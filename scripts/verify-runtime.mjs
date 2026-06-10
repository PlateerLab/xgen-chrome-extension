#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');
const SIDEPANEL_CHAT_COMMAND_REQUEST_ID = 'verify-sidepanel-chat-command';

function loadPlaywright() {
  const searchPaths = [
    repoRoot,
    path.resolve(repoRoot, '../../tools/demo-recorder'),
  ];
  const resolved = require.resolve('playwright', { paths: searchPaths });
  return require(resolved);
}

function sendExtensionMessage(page, message) {
  return page.evaluate((payload) => new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => resolve(response));
  }), message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendActiveTabMessage(page, message) {
  return page.evaluate((payload) => new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) {
        resolve({ __error: 'No active tab found' });
        return;
      }

      chrome.tabs.sendMessage(tabId, payload, (response) => {
        const lastError = chrome.runtime.lastError?.message;
        if (lastError) {
          resolve({ __error: lastError });
          return;
        }
        resolve(response);
      });
    });
  }), message);
}

async function waitForPageContext(extensionPage, predicate, label) {
  let lastResponse;
  for (let attempt = 0; attempt < 25; attempt++) {
    lastResponse = await sendActiveTabMessage(extensionPage, { type: 'GET_PAGE_CONTEXT' });
    if (lastResponse && !lastResponse.__error && (!predicate || predicate(lastResponse))) {
      return lastResponse;
    }
    await wait(200);
  }

  assert.fail(`${label}: page context not ready: ${JSON.stringify(lastResponse)}`);
}

function findElementIndexInText(elementsText, pattern, label) {
  const elements = String(elementsText || '');
  const chunks = [];
  const chunkPattern = /\[(\d+)\]([^\n]*(?:\n(?!\[\d+\])[^\n]*)*)/g;
  let match;
  while ((match = chunkPattern.exec(elements)) !== null) {
    chunks.push({ index: Number(match[1]), text: match[0] });
  }

  const found = chunks.find((chunk) => pattern.test(chunk.text));
  assert.ok(
    found,
    `${label}: matching element not found. Pattern=${pattern}; elements=${elements}`,
  );
  return found.index;
}

function findElementIndex(context, pattern, label) {
  return findElementIndexInText(context?.elements || '', pattern, label);
}

async function sendPageCommand(extensionPage, action, params) {
  const response = await sendActiveTabMessage(extensionPage, {
    type: 'PAGE_COMMAND',
    requestId: '',
    action,
    params,
  });
  assert.ok(response && !response.__error, `${action}: PAGE_COMMAND failed: ${JSON.stringify(response)}`);
  return response;
}

function waitForCommandResult(commandResults, requestId, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label}: command result callback not received for ${requestId}`));
    }, 5_000);

    const poll = () => {
      const found = commandResults.find((entry) => entry.requestId === requestId);
      if (found) {
        clearTimeout(timeout);
        resolve(found);
        return;
      }
      setTimeout(poll, 100);
    };

    poll();
  });
}

function waitForItem(items, predicate, label, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label}: item not received`));
    }, timeoutMs);

    const poll = () => {
      const found = items.find(predicate);
      if (found) {
        clearTimeout(timeout);
        resolve(found);
        return;
      }
      setTimeout(poll, 100);
    };

    poll();
  });
}

function startFixtureServer() {
  const commandResults = [];
  const chatRequests = [];
  const registrationRequests = [];
  const mergeRequests = [];
  const registrationMode = { conflictNext: false };
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/api/ai-chat/command-result/')) {
      const requestId = decodeURIComponent(req.url.split('/').pop() || '');
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          body = rawBody;
        }
        commandResults.push({ requestId, headers: req.headers, body });
        res.writeHead(204);
        res.end();
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/session-station/v1/auth-profiles') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        { service_id: '127_local_profile', name: '127 local profile', status: 'active' },
      ]));
      return;
    }

    const mergeMatch = req.url?.match(/^\/api\/tools\/api-collections\/([^/]+)\/from-trace\/merge$/);
    if (req.method === 'POST' && mergeMatch) {
      const collectionId = decodeURIComponent(mergeMatch[1]);
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          body = {};
        }
        mergeRequests.push({ collectionId, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          collection_id: collectionId,
          name: 'Fixture Trace Collection',
          tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
        }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/tools/api-collections/from-trace') {
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          body = {};
        }
        registrationRequests.push({ headers: req.headers, body });
        if (registrationMode.conflictNext) {
          registrationMode.conflictNext = false;
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            detail: {
              collection_id: 'col_fixture_trace',
              name: 'Fixture Trace Collection',
              message: `Collection for host '${body.host}' already exists`,
            },
          }));
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          collection_id: 'col_fixture_trace',
          name: 'Fixture Trace Collection',
          tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
        }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ai-chat/stream') {
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          body = {};
        }
        chatRequests.push(body);

        let inputIndex;
        try {
          inputIndex = findElementIndexInText(
            body?.page_context?.elements || '',
            /<input[^>]*(Search term|search-input)/i,
            'sidepanel SSE page_command input',
          );
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(err instanceof Error ? err.message : String(err));
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const writeEvent = (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        writeEvent({ type: 'token', content: 'UI bridge start. ' });
        writeEvent({
          type: 'page_command',
          requestId: SIDEPANEL_CHAT_COMMAND_REQUEST_ID,
          action: 'input_text',
          params: {
            index: inputIndex,
            text: 'from-sidepanel',
            snapshot_id: body?.page_context?.snapshotId || '',
          },
        });
        writeEvent({ type: 'token', content: 'UI bridge done.' });
        writeEvent({ type: 'done' });
        res.end();
      });
      return;
    }

    if (req.url?.startsWith('/api/goods/v1/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        rows: [{ goodsNo: '987654', goodsName: '제주 상품' }],
      }));
      return;
    }

    if (req.url?.startsWith('/api/goods/v1/detail')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        goodsNo: '987654',
        goodsName: '제주 상품',
        stockQty: 5,
      }));
      return;
    }

    if (req.url?.startsWith('/api/member/v1/me')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        memberNo: 'M202606100001',
        grade: 'VIP',
      }));
      return;
    }

    if (req.url?.startsWith('/fragment')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<section>not an api response</section>');
      return;
    }

    if (req.url?.startsWith('/distractor')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
  <head><title>Distractor fixture</title></head>
  <body>
    <main>
      <h1>Distractor Page</h1>
      <input id="distractor-input" aria-label="Distractor input" placeholder="Distractor input" />
      <button id="distractor-button">Distractor action</button>
    </main>
  </body>
</html>`);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
  <head>
    <title>PathFinder fixture</title>
    <style>
      body { min-height: 2200px; font-family: system-ui, sans-serif; }
      main { max-width: 720px; margin: 40px auto; }
      label, input, select, button { display: block; margin: 12px 0; }
      #status { margin-top: 16px; padding: 12px; border: 1px solid #ccc; }
      #bottom-marker { margin-top: 1600px; }
    </style>
  </head>
  <body>
    <main>
      <h1>XGEN Page Agent Fixture</h1>
      <label for="search-input">Search term</label>
      <input id="search-input" aria-label="Search term" placeholder="Search term" />
      <label for="category-select">Category</label>
      <select id="category-select" aria-label="Category">
        <option value="">Choose</option>
        <option value="goods">Goods</option>
        <option value="members">Members</option>
      </select>
      <button id="search-button" aria-label="Run search">Run search</button>
      <button id="details-button" aria-label="Open details">Open details</button>
      <div id="status" role="status">Idle</div>
      <button id="hidden-action" style="display:none">Hidden action</button>
      <div id="bottom-marker">Bottom marker</div>
    </main>
    <script>
      const input = document.querySelector('#search-input');
      const status = document.querySelector('#status');
      document.querySelector('#search-button').addEventListener('click', () => {
        document.body.dataset.clicked = 'true';
        status.textContent = 'Searched: ' + input.value;
      });
      document.querySelector('#category-select').addEventListener('change', (event) => {
        document.body.dataset.category = event.target.value;
      });
      document.querySelector('#details-button').addEventListener('click', () => {
        history.pushState({}, '', '/workspace/details');
        document.title = 'PathFinder fixture - Details';
        status.textContent = 'Details view ready';
      });
    </script>
  </body>
</html>`);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
        commandResults,
        chatRequests,
        registrationRequests,
        mergeRequests,
        registrationMode,
      });
    });
  });
}

async function findExtensionIdFromPreferences(userDataDir) {
  const prefPath = path.join(userDataDir, 'Default', 'Preferences');
  if (!existsSync(prefPath)) return '';

  const prefs = JSON.parse(await readFile(prefPath, 'utf8'));
  const settings = prefs?.extensions?.settings || {};
  for (const [id, entry] of Object.entries(settings)) {
    const entryPath = entry?.path ? path.resolve(String(entry.path)) : '';
    const manifestName = entry?.manifest?.name || '';
    if (entryPath === distDir || manifestName === 'XGEN Pathfinder') {
      return id;
    }
  }
  return '';
}

async function runCaptureSession(extensionPage, targetPage, action, label) {
  await targetPage.bringToFront();
  const start = await sendExtensionMessage(extensionPage, { type: 'START_CAPTURE_SESSION' });
  assert.equal(start?.ok, true, `${label}: START_CAPTURE_SESSION failed: ${JSON.stringify(start)}`);

  await action();

  await targetPage.bringToFront();
  const stop = await sendExtensionMessage(extensionPage, { type: 'STOP_CAPTURE_SESSION' });
  assert.equal(stop?.ok, true, `${label}: STOP_CAPTURE_SESSION failed: ${JSON.stringify(stop)}`);
  assert.ok(stop.count >= 1, `${label}: expected at least one captured API, got ${stop.count}`);

  const cached = await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });
  assert.equal(cached?.ok, true, `${label}: GET_CAPTURE_RESULT failed: ${JSON.stringify(cached)}`);
  const apis = cached?.result?.apis || [];
  assert.equal(apis.length, stop.count, `${label}: cached result count mismatch`);
  return apis;
}

async function clickSidepanelButton(extensionPage, targetPage, label, matcher) {
  await targetPage.bringToFront();
  await extensionPage.evaluate(({ label, matcherSource }) => {
    const matcher = new RegExp(matcherSource);
    const button = Array.from(document.querySelectorAll('button')).find((candidate) => {
      const text = candidate.textContent || '';
      const title = candidate.getAttribute('title') || '';
      return matcher.test(text) || matcher.test(title);
    });
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`${label}: button not found`);
    }
    button.click();
  }, { label, matcherSource: matcher.source });
}

async function runCaptureSessionViaSidepanel(extensionPage, targetPage, action, label, activePageForControls = targetPage) {
  await clickSidepanelButton(extensionPage, activePageForControls, `${label}: start`, /캡처 세션 시작/);
  await extensionPage.waitForFunction(() => document.body.innerText.includes('캡처 중'));

  await action();
  await wait(300);

  await clickSidepanelButton(extensionPage, activePageForControls, `${label}: stop`, /캡처 종료/);
  await extensionPage.waitForFunction(() => document.body.innerText.includes('캡처 분석'));

  const cached = await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });
  assert.equal(cached?.ok, true, `${label}: GET_CAPTURE_RESULT failed: ${JSON.stringify(cached)}`);
  const apis = cached?.result?.apis || [];
  assert.ok(apis.length >= 1, `${label}: expected at least one captured API, got ${apis.length}`);
  return apis;
}

function findApi(apis, method, pathPart) {
  return apis.find((api) => api.method === method && api.url.includes(pathPart));
}

async function verifyPageAgent(extensionPage, targetPage) {
  await targetPage.bringToFront();
  const context = await waitForPageContext(
    extensionPage,
    (ctx) => /Search term/.test(ctx.elements || '') && /Run search/.test(ctx.elements || ''),
    'PageAgent initial context',
  );

  assert.equal(context.pageType, 'unknown');
  assert.match(context.title, /PathFinder fixture/);
  assert.ok(context.snapshotId, 'PageAgent context should include snapshotId');
  assert.ok(context.availableActions?.includes('click_element'), 'PageAgent should expose click_element');
  assert.ok(context.availableActions?.includes('input_text'), 'PageAgent should expose input_text');
  assert.ok(context.availableActions?.includes('scroll'), 'PageAgent should expose scroll');

  const serviceWorkerContext = await sendExtensionMessage(extensionPage, { type: 'GET_PAGE_CONTEXT' });
  assert.ok(
    /Search term/.test(serviceWorkerContext?.elements || ''),
    `service worker should relay active tab page context: ${JSON.stringify(serviceWorkerContext)}`,
  );

  const chatConfig = await sendExtensionMessage(extensionPage, { type: 'GET_CHAT_CONFIG' });
  assert.ok(
    /Run search/.test(chatConfig?.pageContext?.elements || ''),
    `chat config should include PageAgent context: ${JSON.stringify(chatConfig)}`,
  );

  const inputIndex = findElementIndex(context, /<input[^>]*(Search term|search-input)/i, 'PageAgent input_text');
  const buttonIndex = findElementIndex(context, /<button[^>]*(Run search|search-button)/i, 'PageAgent click_element');

  const inputResult = await sendPageCommand(extensionPage, 'input_text', {
    index: inputIndex,
    text: 'jeju',
    snapshot_id: context.snapshotId,
  });
  assert.equal(inputResult.success, true, `input_text should succeed: ${JSON.stringify(inputResult)}`);
  await targetPage.waitForFunction(() => document.querySelector('#search-input')?.value === 'jeju');

  const contextAfterInput = inputResult.pageContext || context;
  const clickResult = await sendPageCommand(extensionPage, 'click_element', {
    index: buttonIndex,
    snapshot_id: contextAfterInput.snapshotId,
  });
  assert.equal(clickResult.success, true, `click_element should succeed: ${JSON.stringify(clickResult)}`);
  await targetPage.waitForFunction(() => document.body.dataset.clicked === 'true');
  assert.match(await targetPage.locator('#status').textContent(), /Searched: jeju/);

  const contextAfterClick = clickResult.pageContext || contextAfterInput;
  const scrollBefore = await targetPage.evaluate(() => window.scrollY);
  const scrollResult = await sendPageCommand(extensionPage, 'scroll', {
    down: true,
    num_pages: 1,
    snapshot_id: contextAfterClick.snapshotId,
  });
  assert.equal(scrollResult.success, true, `scroll should succeed: ${JSON.stringify(scrollResult)}`);
  await targetPage.waitForFunction((before) => window.scrollY > before, scrollBefore);

  const contextAfterScroll = scrollResult.pageContext || contextAfterClick;
  const invalidResult = await sendPageCommand(extensionPage, 'click_element', {
    index: 99999,
    snapshot_id: contextAfterScroll.snapshotId,
  });
  assert.equal(invalidResult.success, false, 'invalid element index should fail');
  assert.match(invalidResult.error || '', /99999|인덱스/);

  await targetPage.evaluate(() => window.scrollTo(0, 0));
  await wait(300);
  const staleContext = await waitForPageContext(
    extensionPage,
    (ctx) => /Search term/.test(ctx.elements || ''),
    'PageAgent stale snapshot baseline',
  );
  const staleInputIndex = findElementIndex(staleContext, /<input[^>]*(Search term|search-input)/i, 'PageAgent stale input_text');
  await targetPage.evaluate(() => {
    const status = document.querySelector('#status');
    if (status) status.textContent = 'Dynamic snapshot marker';
  });
  const staleResult = await sendPageCommand(extensionPage, 'input_text', {
    index: staleInputIndex,
    text: 'stale',
    snapshot_id: staleContext.snapshotId,
  });
  assert.equal(staleResult.success, false, `stale snapshot should fail: ${JSON.stringify(staleResult)}`);
  assert.match(staleResult.error || '', /snapshot_id stale/);
  assert.ok(staleResult.pageContext?.snapshotId, `stale failure should include latest context: ${JSON.stringify(staleResult)}`);
  assert.notEqual(staleResult.pageContext.snapshotId, staleContext.snapshotId);
  assert.notEqual(await targetPage.locator('#search-input').inputValue(), 'stale');

  const freshContext = staleResult.pageContext;
  const freshInputIndex = findElementIndex(freshContext, /<input[^>]*(Search term|search-input)/i, 'PageAgent fresh input_text');
  const freshResult = await sendPageCommand(extensionPage, 'input_text', {
    index: freshInputIndex,
    text: 'fresh',
    snapshot_id: freshContext.snapshotId,
  });
  assert.equal(freshResult.success, true, `fresh snapshot retry should succeed: ${JSON.stringify(freshResult)}`);
  await targetPage.waitForFunction(() => document.querySelector('#search-input')?.value === 'fresh');

  const contextBeforeDetails = await waitForPageContext(
    extensionPage,
    (ctx) => /Open details/.test(ctx.elements || ''),
    'PageAgent context before SPA click',
  );
  const detailsIndex = findElementIndex(contextBeforeDetails, /<button[^>]*(Open details|details-button)/i, 'PageAgent SPA click');
  const detailsResult = await sendPageCommand(extensionPage, 'click_element', {
    index: detailsIndex,
    snapshot_id: contextBeforeDetails.snapshotId,
  });
  assert.equal(detailsResult.success, true, `SPA navigation click should succeed: ${JSON.stringify(detailsResult)}`);

  const spaContext = await waitForPageContext(
    extensionPage,
    (ctx) => /\/workspace\/details$/.test(ctx.url || '') && /Details view ready/.test(ctx.elements || ''),
    'PageAgent SPA context',
  );
  assert.equal(spaContext.title, 'PathFinder fixture - Details');
}

async function pinSidepanelToTarget(extensionPage, targetPage) {
  await clickSidepanelButton(extensionPage, targetPage, 'Sidepanel target reset', /초기화/);
  await waitForPageContext(
    extensionPage,
    (ctx) => /Search term/.test(ctx.elements || '') && /Run search/.test(ctx.elements || ''),
    'Sidepanel pinned target context',
  );
  await wait(300);
}

async function verifyRelayCommandBridge(extensionPage, targetPage, commandResults) {
  await targetPage.bringToFront();
  const origin = new URL(targetPage.url()).origin;
  const tokenResult = await sendExtensionMessage(extensionPage, {
    type: 'SET_TOKEN',
    token: 'verify-token',
    origin,
  });
  assert.equal(tokenResult?.ok, true, `SET_TOKEN should succeed before relay bridge: ${JSON.stringify(tokenResult)}`);

  const context = await waitForPageContext(
    extensionPage,
    (ctx) => /Search term/.test(ctx.elements || ''),
    'PageAgent relay bridge context',
  );
  const inputIndex = findElementIndex(context, /<input[^>]*(Search term|search-input)/i, 'PageAgent relay bridge input');

  const requestId = `verify-page-command-${Date.now()}`;
  const relayResult = await sendExtensionMessage(extensionPage, {
    type: 'RELAY_COMMAND',
    event: {
      type: 'page_command',
      requestId,
      action: 'input_text',
      params: {
        index: inputIndex,
        text: 'bridge',
        snapshot_id: context.snapshotId,
      },
    },
  });

  assert.equal(relayResult?.ok, true, `RELAY_COMMAND should be accepted: ${JSON.stringify(relayResult)}`);
  await targetPage.waitForFunction(() => document.querySelector('#search-input')?.value === 'bridge');

  const callback = await waitForCommandResult(commandResults, requestId, 'PageAgent relay bridge');
  assert.equal(callback.headers.authorization, 'Bearer verify-token');
  assert.equal(callback.body.success, true, `command callback should report success: ${JSON.stringify(callback.body)}`);
  assert.equal(callback.body.action, 'input_text');
  assert.match(callback.body.pageContext?.url || '', /\/workspace\/details$/);
  assert.match(callback.body.pageContext?.elements || '', /Search term/);
}

async function submitSidepanelMessage(extensionPage, activePageBeforeSubmit, message) {
  const input = extensionPage.locator('textarea[placeholder="메시지 입력..."]');
  await input.fill(message);
  await extensionPage.waitForFunction(() => {
    const button = document.querySelector('button[title="전송"]');
    return button && !button.disabled;
  });

  await activePageBeforeSubmit.bringToFront();
  await extensionPage.evaluate(() => {
    const button = document.querySelector('button[title="전송"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('sidepanel send button not found');
    }
    button.click();
  });
}

async function verifySidepanelChatRelay(extensionPage, targetPage, distractorPage, commandResults, chatRequests) {
  await targetPage.bringToFront();
  const context = await waitForPageContext(
    extensionPage,
    (ctx) => /Search term/.test(ctx.elements || ''),
    'Sidepanel chat relay context',
  );
  assert.match(context.url || '', /\/workspace\/details$/);

  await submitSidepanelMessage(extensionPage, distractorPage, 'sidepanel bridge check');

  await targetPage.waitForFunction(() => document.querySelector('#search-input')?.value === 'from-sidepanel');
  assert.equal(
    await distractorPage.locator('#distractor-input').inputValue(),
    '',
    'sidepanel page_command should not target the active distractor tab',
  );
  const callback = await waitForCommandResult(
    commandResults,
    SIDEPANEL_CHAT_COMMAND_REQUEST_ID,
    'Sidepanel chat relay',
  );
  assert.equal(callback.headers.authorization, 'Bearer verify-token');
  assert.equal(callback.body.success, true, `sidepanel command callback should report success: ${JSON.stringify(callback.body)}`);
  assert.equal(callback.body.action, 'input_text');

  const lastChatRequest = chatRequests.at(-1);
  assert.equal(lastChatRequest?.messages?.[0]?.content, 'sidepanel bridge check');
  assert.match(lastChatRequest?.page_context?.elements || '', /Search term/);

  await extensionPage.waitForFunction(() => document.body.innerText.includes('UI bridge done.'));
}

async function verifySessionResultRegistration(extensionPage, targetPage, registrationRequests) {
  await extensionPage.waitForFunction(() => document.body.innerText.includes('컬렉션으로 등록'));
  await clickSidepanelButton(extensionPage, targetPage, 'Session result registration', /컬렉션으로 등록/);
  await extensionPage.waitForFunction(() => document.body.innerText.includes('컬렉션 등록 완료'));

  const request = await waitForItem(
    registrationRequests,
    (entry) => entry.body?.host && entry.body?.auth_profile_id === '127_local_profile',
    'Session result registration request',
  );

  assert.equal(request.headers.authorization, 'Bearer verify-token');
  assert.match(request.body.host, /^127\.0\.0\.1:\d+$/);
  assert.equal(request.body.auth_profile_id, '127_local_profile');
  assert.ok(Array.isArray(request.body.tools), `registration tools should be an array: ${JSON.stringify(request.body)}`);
  assert.ok(request.body.tools.length >= 2, `registration should include captured tools: ${JSON.stringify(request.body.tools)}`);
  assert.ok(
    request.body.tools.some((tool) => tool.method === 'GET' && tool.templatedPath === '/api/goods/v1/search'),
    `registration should include search tool: ${JSON.stringify(request.body.tools)}`,
  );
  assert.ok(
    request.body.tools.some((tool) => tool.method === 'POST' && tool.templatedPath === '/api/member/v1/me'),
    `registration should include member tool: ${JSON.stringify(request.body.tools)}`,
  );
}

async function verifySessionResultMergeConflict(
  extensionPage,
  targetPage,
  registrationMode,
  registrationRequests,
  mergeRequests,
) {
  const registrationStart = registrationRequests.length;
  const mergeStart = mergeRequests.length;
  registrationMode.conflictNext = true;

  await extensionPage.waitForFunction(() => document.body.innerText.includes('컬렉션으로 등록'));
  await clickSidepanelButton(extensionPage, targetPage, 'Session result conflict', /컬렉션으로 등록/);
  await extensionPage.waitForFunction(() => document.body.innerText.includes('기존 컬렉션에 병합'));

  const conflictRequest = await waitForItem(
    registrationRequests,
    (entry, index) => index >= registrationStart
      && entry.body?.host
      && entry.body?.auth_profile_id === '127_local_profile',
    'Session result conflict request',
  );
  assert.equal(conflictRequest.headers.authorization, 'Bearer verify-token');
  assert.ok(
    conflictRequest.body.tools.some((tool) => tool.method === 'GET' && tool.templatedPath === '/api/goods/v1/detail'),
    `conflict request should include detail tool: ${JSON.stringify(conflictRequest.body.tools)}`,
  );

  await clickSidepanelButton(extensionPage, targetPage, 'Session result merge', /기존 컬렉션에 병합/);
  await extensionPage.waitForFunction(() => document.body.innerText.includes('컬렉션 등록 완료'));

  const mergeRequest = await waitForItem(
    mergeRequests,
    (entry, index) => index >= mergeStart
      && entry.collectionId === 'col_fixture_trace'
      && entry.body?.auth_profile_id === '127_local_profile',
    'Session result merge request',
  );
  assert.equal(mergeRequest.headers.authorization, 'Bearer verify-token');
  assert.match(mergeRequest.body.host, /^127\.0\.0\.1:\d+$/);
  assert.ok(Array.isArray(mergeRequest.body.tools), `merge tools should be an array: ${JSON.stringify(mergeRequest.body)}`);
  assert.ok(
    mergeRequest.body.tools.some((tool) => tool.method === 'GET' && tool.templatedPath === '/api/goods/v1/detail'),
    `merge should include detail tool: ${JSON.stringify(mergeRequest.body.tools)}`,
  );
}

async function main() {
  if (!existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error('dist/manifest.json not found. Run `npm run build` before runtime verification.');
  }

  const { chromium } = loadPlaywright();
  if (!existsSync(chromium.executablePath())) {
    throw new Error(
      'Playwright Chromium is not installed. Run `../../tools/demo-recorder/node_modules/.bin/playwright install chromium` first.',
    );
  }
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-runtime-'));
  const {
    server,
    url,
    commandResults,
    chatRequests,
    registrationRequests,
    mergeRequests,
    registrationMode,
  } = await startFixtureServer();
  let context;

  try {
    const launchOptions = {
      headless: false,
      args: [
        `--disable-extensions-except=${distDir}`,
        `--load-extension=${distDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    };

    context = await chromium.launchPersistentContext(userDataDir, launchOptions);

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 3_000 }).catch(() => null);
    }
    let extensionId = serviceWorker ? new URL(serviceWorker.url()).host : '';
    if (!extensionId) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      extensionId = await findExtensionIdFromPreferences(userDataDir);
    }
    assert.ok(extensionId, 'extension id should be detected from service worker URL');

    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    serviceWorker = context.serviceWorkers()[0]
      || await context.waitForEvent('serviceworker', { timeout: 5_000 }).catch(() => null);
    assert.ok(serviceWorker, 'extension service worker should start after opening sidepanel page');

    await extensionPage.bringToFront();
    const unsupportedStart = await sendExtensionMessage(extensionPage, { type: 'START_CAPTURE_SESSION' });
    assert.equal(unsupportedStart?.ok, false, `START_CAPTURE_SESSION should reject extension pages: ${JSON.stringify(unsupportedStart)}`);
    assert.match(unsupportedStart?.error || '', /http\/https|API 캡처/);

    const targetPage = await context.newPage();
    await targetPage.goto(url);
    await pinSidepanelToTarget(extensionPage, targetPage);
    const distractorPage = await context.newPage();
    await distractorPage.goto(`${url}distractor`);
    await verifyPageAgent(extensionPage, targetPage);
    await verifyRelayCommandBridge(extensionPage, targetPage, commandResults);
    await verifySidepanelChatRelay(extensionPage, targetPage, distractorPage, commandResults, chatRequests);
    await wait(2_200);

    const firstApis = await runCaptureSessionViaSidepanel(extensionPage, targetPage, async () => {
      await targetPage.evaluate(async () => {
        const search = await fetch('/api/goods/v1/search?keyword=jeju');
        if (!search.ok) throw new Error(`fixture fetch failed: ${search.status}`);
        await search.json();

        const html = await fetch('/fragment');
        if (!html.ok) throw new Error(`fixture html fetch failed: ${html.status}`);
        await html.text();

        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/member/v1/me');
          xhr.setRequestHeader('content-type', 'application/json');
          xhr.onload = () => resolve(undefined);
          xhr.onerror = () => reject(new Error('fixture xhr failed'));
          xhr.send(JSON.stringify({ includeGrade: true }));
        });
      });
    }, 'fetch+xhr capture', distractorPage);
    await verifySessionResultRegistration(extensionPage, targetPage, registrationRequests);

    const searchApi = findApi(firstApis, 'GET', '/api/goods/v1/search?keyword=jeju');
    assert.ok(searchApi, `captured search API not found in ${JSON.stringify(firstApis)}`);
    assert.equal(searchApi.responseStatus, 200);
    assert.match(searchApi.responseBody || '', /987654/);
    const memberApi = findApi(firstApis, 'POST', '/api/member/v1/me');
    assert.ok(memberApi, `captured XHR API not found in ${JSON.stringify(firstApis)}`);
    assert.match(memberApi.requestBody || '', /includeGrade/);
    assert.ok(!firstApis.some((api) => api.url.includes('/fragment')), 'HTML fetch should be ignored');

    const mergeApis = await runCaptureSessionViaSidepanel(extensionPage, targetPage, async () => {
      await targetPage.evaluate(async () => {
        const detail = await fetch('/api/goods/v1/detail?goodsNo=987654&siteNo=1000');
        if (!detail.ok) throw new Error(`fixture detail fetch failed: ${detail.status}`);
        await detail.json();
      });
    }, 'registration conflict merge capture', distractorPage);
    await verifySessionResultMergeConflict(
      extensionPage,
      targetPage,
      registrationMode,
      registrationRequests,
      mergeRequests,
    );
    const mergeDetailApi = findApi(mergeApis, 'GET', '/api/goods/v1/detail?goodsNo=987654&siteNo=1000');
    assert.ok(mergeDetailApi, `captured merge detail API not found in ${JSON.stringify(mergeApis)}`);

    const secondApis = await runCaptureSession(extensionPage, targetPage, async () => {
      await targetPage.goto(`${url}after-navigation`);
      await targetPage.waitForLoadState('domcontentloaded');
      await targetPage.waitForTimeout(300);
      await targetPage.evaluate(async () => {
        const detail = await fetch('/api/goods/v1/detail?goodsNo=987654&siteNo=1000');
        if (!detail.ok) throw new Error(`fixture detail fetch failed: ${detail.status}`);
        await detail.json();
      });
    }, 'navigation reinjection');

    const detailApi = findApi(secondApis, 'GET', '/api/goods/v1/detail?goodsNo=987654&siteNo=1000');
    assert.ok(detailApi, `captured post-navigation API not found in ${JSON.stringify(secondApis)}`);
    assert.equal(secondApis.length, 1, `navigation session should reset old captures: ${JSON.stringify(secondApis)}`);

    const extraStop = await sendExtensionMessage(extensionPage, { type: 'STOP_CAPTURE_SESSION' });
    assert.equal(extraStop?.ok, false, `STOP_CAPTURE_SESSION without active session should fail: ${JSON.stringify(extraStop)}`);
    assert.match(extraStop?.error || '', /No active session/);

    console.log([
      `PathFinder runtime verification passed: extension loaded (${extensionId})`,
      'PageAgent context and commands verified',
      'page_command relay callback verified',
      'sidepanel chat relay verified',
      'capture result registration verified',
      'capture result merge conflict verified',
      `fetch/xhr captured ${firstApis.length} API request(s)`,
      `navigation reinjection captured ${secondApis.length} API request(s)`,
    ].join('; '));
  } finally {
    await context?.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
