#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');
const artifactDir = path.resolve(
  process.env.PATHFINDER_ARTIFACT_DIR || path.join(repoRoot, 'artifacts/pathfinder-runtime'),
);
const SIDEPANEL_CHAT_COMMAND_REQUEST_ID = 'verify-sidepanel-chat-command';

function loadPlaywright() {
  const resolved = require.resolve('playwright', { paths: [repoRoot] });
  return require(resolved);
}

function sendExtensionMessage(page, message) {
  return page.evaluate((payload) => new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => resolve(response));
  }), message);
}

function removeExtensionPermissions(page, request) {
  return page.evaluate(
    (permissionRequest) => chrome.permissions.remove(permissionRequest),
    request,
  );
}

function containsExtensionPermissions(page, request) {
  return page.evaluate(
    (permissionRequest) => chrome.permissions.contains(permissionRequest),
    request,
  );
}

async function grantPersistedExtensionPermissions(
  userDataDir,
  extensionId,
  { permissions = [], origins = [] },
) {
  const prefPath = path.join(userDataDir, 'Default', 'Preferences');
  const preferences = JSON.parse(await readFile(prefPath, 'utf8'));
  const extension = preferences?.extensions?.settings?.[extensionId];
  assert.ok(extension, `extension preferences not found for ${extensionId}`);

  for (const key of ['active_permissions', 'granted_permissions']) {
    assert.ok(extension[key], `${key} not found for ${extensionId}`);
    extension[key].api = [...new Set([...(extension[key].api || []), ...permissions])];
    extension[key].explicit_host = [
      ...new Set([...(extension[key].explicit_host || []), ...origins]),
    ];
  }
  await writeFile(prefPath, JSON.stringify(preferences), 'utf8');
}

function setExtensionStorage(page, values) {
  return page.evaluate((payload) => new Promise((resolve) => {
    chrome.storage.local.set(payload, () => resolve(undefined));
  }), values);
}

function getExtensionSessionStorage(page, key) {
  return page.evaluate(
    (storageKey) => chrome.storage.session.get(storageKey),
    key,
  );
}

function findTabIdByUrl(page, urlPatternSource) {
  return page.evaluate((source) => new Promise((resolve) => {
    const pattern = new RegExp(source);
    chrome.tabs.query({}, (tabs) => {
      resolve(tabs.find((tab) => pattern.test(tab.url || ''))?.id || null);
    });
  }), urlPatternSource);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrubRuntimeLog(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|session|secret)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:authorization|cookie|access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      '$1[REDACTED]',
    );
}

function attachRuntimeLogging(context, logs) {
  context.on('console', (message) => {
    logs.push(`[console:${message.type()}] ${scrubRuntimeLog(message.text())}`);
  });
  context.on('weberror', (webError) => {
    logs.push(`[weberror] ${scrubRuntimeLog(webError.error()?.stack || webError.error())}`);
  });
  const attachPage = (page) => {
    page.on('pageerror', (error) => {
      logs.push(`[pageerror:${scrubRuntimeLog(page.url())}] ${scrubRuntimeLog(error.stack || error)}`);
    });
  };
  context.pages().forEach(attachPage);
  context.on('page', attachPage);
}

async function writeFailureArtifacts(context, error, logs) {
  await mkdir(artifactDir, { recursive: true });

  if (context) {
    const pages = context.pages();
    for (let index = 0; index < pages.length; index += 1) {
      await pages[index]
        .screenshot({
          path: path.join(artifactDir, `page-${index}.png`),
          fullPage: true,
        })
        .catch((screenshotError) => {
          logs.push(`[artifact] screenshot ${index} failed: ${scrubRuntimeLog(screenshotError)}`);
        });
    }
    await context.tracing
      .stop({ path: path.join(artifactDir, 'trace.zip') })
      .catch((traceError) => {
        logs.push(`[artifact] trace failed: ${scrubRuntimeLog(traceError)}`);
      });
  }

  const errorText = error instanceof Error ? error.stack || error.message : String(error);
  const summary = {
    status: 'failed',
    createdAt: new Date().toISOString(),
    error: scrubRuntimeLog(errorText),
    artifactFiles: ['runtime.log', 'runtime-summary.json', 'trace.zip', 'page-*.png'],
  };
  await writeFile(
    path.join(artifactDir, 'runtime.log'),
    `${[...logs, `[failure] ${scrubRuntimeLog(errorText)}`].join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    path.join(artifactDir, 'runtime-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  console.error(`PathFinder failure artifacts: ${artifactDir}`);
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

function sendTabMessage(page, tabId, message) {
  return page.evaluate(({ targetTabId, payload }) => new Promise((resolve) => {
    chrome.tabs.sendMessage(targetTabId, payload, (response) => {
      const lastError = chrome.runtime.lastError?.message;
      resolve(lastError ? { __error: lastError } : response);
    });
  }), { targetTabId: tabId, payload: message });
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

function readJsonRequest(req, callback) {
  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    rawBody += chunk;
  });
  req.on('end', () => {
    try {
      callback(JSON.parse(rawBody || '{}'));
    } catch {
      callback({});
    }
  });
}

function startFixtureServer() {
  const commandResults = [];
  const chatRequests = [];
  const registrationRequests = [];
  const mergeRequests = [];
  const collectionCreateRequests = [];
  const sourcePreviewRequests = [];
  const sourceAddRequests = [];
  const collectionDeleteRequests = [];
  const registrationMode = { conflictNext: false };
  const sourceAddMode = { failNext: false };
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

    if (req.method === 'GET' && req.url === '/api/tools/api-collections') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        {
          collection_id: 'fixture-existing',
          name: 'Fixture Existing',
          tool_count: 3,
          source_count: 1,
        },
      ]));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/tools/api-collections/preview') {
      readJsonRequest(req, (body) => {
        sourcePreviewRequests.push({ headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          incoming_tool_count: 2,
          conflicts: body.target_collection_id ? ['listItems'] : [],
          edges_before: body.target_collection_id ? 1 : 0,
          edges_after: body.target_collection_id ? 3 : 2,
          edges_added: 2,
          existing_total: body.target_collection_id ? 3 : 0,
          spec_hash: 'fixture-openapi-hash',
          ingest_stats: { inserted: 2 },
          ingest_result: {
            adapter: 'openapi',
            ready: true,
            issues: [],
            capabilities: {
              input_schema: true,
              output_schema: true,
            },
            api_collection_execution_supported: true,
          },
          ingest_supported: true,
          readiness_report: {
            summary: {
              readiness_score: 95,
              status: 'ready',
              tool_count: 2,
            },
            issues: [],
          },
        }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/tools/api-collections') {
      readJsonRequest(req, (body) => {
        collectionCreateRequests.push({ headers: req.headers, body });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          collection_id: body.collection_id,
          name: body.name,
          tool_count: 0,
          source_count: 0,
        }));
      });
      return;
    }

    const sourceMatch = req.url?.match(/^\/api\/tools\/api-collections\/([^/]+)\/sources$/);
    if (req.method === 'POST' && sourceMatch) {
      const collectionId = decodeURIComponent(sourceMatch[1]);
      readJsonRequest(req, (body) => {
        sourceAddRequests.push({
          collectionId,
          headers: req.headers,
          body,
        });
        if (sourceAddMode.failNext) {
          sourceAddMode.failNext = false;
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            detail: {
              message: 'fixture source ingest rejected',
              ingest_result: {
                ready: false,
                issues: [{ severity: 'blocker', code: 'fixture_rejected' }],
              },
            },
          }));
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          collection_id: collectionId,
          name: 'Fixture OpenAPI Collection',
          tool_count: 2,
          source_count: 1,
          ingest_result: {
            adapter: 'openapi',
            ready: true,
          },
        }));
      });
      return;
    }

    const deleteCollectionMatch = req.url?.match(/^\/api\/tools\/api-collections\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteCollectionMatch) {
      collectionDeleteRequests.push({
        collectionId: decodeURIComponent(deleteCollectionMatch[1]),
        headers: req.headers,
      });
      res.writeHead(204);
      res.end();
      return;
    }

    const mergeMatch = req.url?.match(/^\/api\/tools\/api-collections\/([^/]+)\/from-trace$/);
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

    if (req.method === 'POST' && req.url === '/graphql') {
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(rawBody || '{}'); } catch { /* fixture returns generic data */ }
        const operationName = body.operationName || 'AnonymousOperation';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            [operationName]: operationName === 'GetGoodsList'
              ? [{ id: 'G10001', name: '제주 상품' }]
              : { id: 'G10001', name: '제주 상품', price: 1000 },
          },
        }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/documents/upload') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { documentId: 'DOC-10001' } }));
      });
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
        collectionCreateRequests,
        sourcePreviewRequests,
        sourceAddRequests,
        collectionDeleteRequests,
        registrationMode,
        sourceAddMode,
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

async function findExtensionIdFromCdp(context, timeoutMs = 5_000) {
  const bootstrapPage = context.pages()[0] || await context.newPage();
  const cdp = await context.newCDPSession(bootstrapPage);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const extensionTarget = targetInfos.find((target) => (
      target.type === 'service_worker'
      && target.url.startsWith('chrome-extension://')
      && target.url.endsWith('/service-worker-loader.js')
    ));
    if (extensionTarget) {
      return new URL(extensionTarget.url).host;
    }
    await wait(100);
  }

  return '';
}

async function resolveExtensionId(context, userDataDir) {
  let extensionId = await findExtensionIdFromCdp(context);
  const serviceWorker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 3_000 }).catch(() => null);
  extensionId ||= serviceWorker ? new URL(serviceWorker.url()).host : '';
  if (!extensionId) {
    await wait(1_000);
    extensionId = await findExtensionIdFromPreferences(userDataDir);
  }
  assert.ok(extensionId, 'extension id should be detected from service worker URL or profile');
  return extensionId;
}

async function openExtensionPage(context, extensionId) {
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  const serviceWorker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 5_000 }).catch(() => null);
  assert.ok(serviceWorker, 'extension service worker should start after opening sidepanel page');
  return extensionPage;
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
  assert.equal(stop.bufferedCount, 0, `${label}: tab capture buffer was not released after stop`);

  const cached = await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });
  assert.equal(cached?.ok, true, `${label}: GET_CAPTURE_RESULT failed: ${JSON.stringify(cached)}`);
  const apis = cached?.result?.apis || [];
  assert.equal(apis.length, stop.count, `${label}: cached result count mismatch`);
  const consumed = await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });
  assert.equal(consumed?.result, null, `${label}: consumed capture result should be released`);
  return apis;
}

async function bootstrapGrantedContentScript(extensionPage, targetPage, url) {
  const parsed = new URL(url);
  const tabId = await findTabIdByUrl(
    extensionPage,
    `^${parsed.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  assert.ok(tabId, 'granted fixture tab should be discoverable');
  const start = await sendExtensionMessage(extensionPage, {
    type: 'START_CAPTURE_SESSION',
    tabId,
  });
  assert.equal(start?.ok, true, `granted content injection failed: ${JSON.stringify(start)}`);
  const stop = await sendExtensionMessage(extensionPage, { type: 'STOP_CAPTURE_SESSION' });
  assert.equal(stop?.ok, true, `granted content bootstrap cleanup failed: ${JSON.stringify(stop)}`);
  await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });
}

async function verifyDeniedOptionalPermissions(extensionPage, targetPage, url) {
  const parsed = new URL(url);
  await targetPage.bringToFront();
  const tabId = await extensionPage.evaluate(() => new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id || null);
    });
  }));
  assert.ok(tabId, 'denied permission fixture tab should be discoverable');

  assert.equal(
    await containsExtensionPermissions(
      extensionPage,
      { origins: [`${parsed.protocol}//${parsed.hostname}/*`] },
    ),
    false,
    'fixture host permission must not be granted at install time',
  );
  assert.equal(
    await containsExtensionPermissions(extensionPage, { permissions: ['cookies'] }),
    false,
    'cookies permission must not be granted at install time',
  );

  const deniedReadiness = await sendExtensionMessage(extensionPage, {
    type: 'GET_PERMISSION_READINESS',
    tabId,
    url,
  });
  assert.equal(deniedReadiness?.ok, true);
  assert.equal(deniedReadiness?.readiness?.reason, 'host_permission_required');

  const deniedStart = await sendExtensionMessage(extensionPage, {
    type: 'START_CAPTURE_SESSION',
    tabId,
  });
  assert.equal(deniedStart?.ok, false, 'capture must not start without host permission');
  assert.match(
    deniedStart?.reason || deniedStart?.error || '',
    /host_permission_required|No active tab/,
  );

  const deniedCookies = await sendExtensionMessage(extensionPage, {
    type: 'GET_LIVE_COOKIES',
    host: parsed.hostname,
    url,
  });
  assert.equal(deniedCookies?.ok, false, 'cookie lookup must fail without host permission');
  assert.equal(deniedCookies?.reason, 'host_permission_required');
}

async function verifyOptionalPermissionLifecycle(extensionPage, context, targetPage, url) {
  const parsed = new URL(url);
  const originPattern = `${parsed.protocol}//${parsed.hostname}/*`;
  const tabId = await findTabIdByUrl(extensionPage, `^${parsed.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  assert.ok(tabId, 'optional permission fixture tab should be discoverable');

  assert.equal(
    await containsExtensionPermissions(extensionPage, { origins: [originPattern] }),
    true,
    'persisted fixture host permission should be active after browser restart',
  );
  assert.equal(
    await containsExtensionPermissions(extensionPage, { permissions: ['cookies'] }),
    true,
    'persisted cookies permission should be active after browser restart',
  );
  const hostReadiness = await sendExtensionMessage(extensionPage, {
    type: 'GET_PERMISSION_READINESS',
    tabId,
    url,
  });
  assert.equal(hostReadiness?.readiness?.ready, true);
  assert.equal(hostReadiness?.readiness?.originPattern, originPattern);
  assert.equal(hostReadiness?.readiness?.cookiePermission, true);
  await context.addCookies([{
    name: 'pathfinder_optional_permission',
    value: 'runtime-secret-must-not-be-logged',
    url: `${parsed.origin}/`,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  const liveCookies = await sendExtensionMessage(extensionPage, {
    type: 'GET_LIVE_COOKIES',
    host: parsed.hostname,
    url,
  });
  assert.equal(liveCookies?.ok, true, 'cookie lookup should work after explicit grant');
  assert.ok(liveCookies?.count >= 1, 'granted cookie lookup should see the fixture cookie');

  const started = await sendExtensionMessage(extensionPage, {
    type: 'START_CAPTURE_SESSION',
    tabId,
  });
  assert.equal(started?.ok, true, `capture should start after host grant: ${JSON.stringify(started)}`);
  const trackedBeforeRevoke = await getExtensionSessionStorage(
    extensionPage,
    'runtime:content-script-origins',
  );
  assert.equal(
    trackedBeforeRevoke['runtime:content-script-origins']?.[String(tabId)],
    originPattern,
    'content-script origin must survive a Service Worker restart in session storage',
  );
  await targetPage.evaluate(async () => {
    const response = await fetch('/api/goods/v1/search?keyword=permission');
    if (!response.ok) throw new Error(`permission fixture failed: ${response.status}`);
    await response.json();
  });

  assert.equal(
    await removeExtensionPermissions(extensionPage, { origins: [originPattern] }),
    true,
    'host permission removal should report a change',
  );
  await targetPage.waitForFunction(
    () => (window).__xgenApiHookActive === false,
    undefined,
    { timeout: 5_000 },
  );
  const contentAfterRevoke = await sendTabMessage(
    extensionPage,
    tabId,
    { type: 'GET_PAGE_CONTEXT' },
  );
  assert.match(
    contentAfterRevoke?.__error || '',
    /Receiving end does not exist|Could not establish connection/,
    'revocation should remove the isolated content-script listener',
  );
  await sendExtensionMessage(extensionPage, {
    type: 'PAGE_COMMAND',
    action: 'start_api_hook',
    params: {},
    tabId,
  });
  await wait(200);
  assert.equal(
    await targetPage.evaluate(() => (window).__xgenApiHookActive === true),
    false,
    'a background command must not reactivate capture after permission revoke',
  );
  const stopAfterRevoke = await sendExtensionMessage(extensionPage, {
    type: 'STOP_CAPTURE_SESSION',
  });
  assert.equal(stopAfterRevoke?.ok, false, 'revocation should terminate the active capture');
  assert.match(stopAfterRevoke?.error || '', /No active session/);
  const purgedResult = await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });
  assert.equal(purgedResult?.result, null, 'revocation must purge cached capture payloads');
  let trackedAfterRevoke;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    trackedAfterRevoke = await getExtensionSessionStorage(
      extensionPage,
      'runtime:content-script-origins',
    );
    if (!trackedAfterRevoke['runtime:content-script-origins']?.[String(tabId)]) break;
    await wait(100);
  }
  assert.ok(
    !trackedAfterRevoke?.['runtime:content-script-origins']?.[String(tabId)],
    'revocation must remove persisted content-script tracking',
  );

  const revokedReadiness = await sendExtensionMessage(extensionPage, {
    type: 'GET_PERMISSION_READINESS',
    tabId,
    url,
  });
  assert.equal(revokedReadiness?.readiness?.ready, false);
  assert.equal(revokedReadiness?.readiness?.reason, 'host_permission_required');

  assert.equal(
    await removeExtensionPermissions(extensionPage, { permissions: ['cookies'] }),
    true,
    'cookie permission removal should report a change',
  );
  const cookiesAfterRevoke = await sendExtensionMessage(extensionPage, {
    type: 'GET_LIVE_COOKIES',
    host: parsed.hostname,
    url,
  });
  assert.equal(cookiesAfterRevoke?.ok, false);
  assert.equal(cookiesAfterRevoke?.reason, 'host_permission_required');
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
  await targetPage.waitForFunction(
    () => (window).__xgenApiHookActive === true,
    undefined,
    { timeout: 5_000 },
  );

  await action();
  await extensionPage.waitForFunction(
    () => /캡처 중[^]*\([1-9]\d*건\)/.test(document.body.innerText),
    undefined,
    { timeout: 5_000 },
  );

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

async function verifyCookiePermissionUi(extensionPage) {
  await extensionPage.getByTestId('settings-toggle').click();
  await extensionPage.waitForFunction(
    () => document.querySelector('[data-testid="cookie-permission-status"]')
      ?.textContent?.includes('현재 사이트 쿠키 연결됨'),
    undefined,
    { timeout: 5_000 },
  );
  assert.match(
    await extensionPage.getByTestId('cookie-permission-status').innerText(),
    /현재 사이트 쿠키 연결됨/,
  );
  await extensionPage.getByTestId('settings-toggle').click();
}

async function verifyStoredServerCookieAuth(extensionPage, browserContext, targetPage, url) {
  const origin = new URL(url).origin;
  await browserContext.addCookies([{
    name: 'xgen_access_token',
    value: 'cookie-token',
    url: `${origin}/`,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  await setExtensionStorage(extensionPage, { serverUrl: origin });

  await targetPage.bringToFront();
  const config = await sendExtensionMessage(extensionPage, { type: 'GET_CHAT_CONFIG' });
  assert.equal(
    config?.serverUrl,
    origin,
    `stored localhost serverUrl should be returned without requiring token storage: ${JSON.stringify(config)}`,
  );
  assert.equal(
    config?.authToken,
    'cookie-token',
    `GET_CHAT_CONFIG should read httpOnly xgen_access_token cookie: ${JSON.stringify(config)}`,
  );
}

async function verifyHarImportUi(extensionPage) {
  const har = {
    log: {
      version: '1.2',
      entries: [
        {
          startedDateTime: '2026-07-26T01:00:00.000Z',
          time: 20,
          request: {
            method: 'POST',
            url: 'https://api.customer.test/items?accessToken=runtime-secret',
            headers: [
              { name: 'Authorization', value: 'Bearer runtime-header-secret' },
              { name: 'Content-Type', value: 'application/json' },
            ],
            postData: {
              mimeType: 'application/json',
              text: JSON.stringify({ itemId: 'ITEM-1', password: 'runtime-password' }),
            },
          },
          response: {
            status: 200,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            content: {
              mimeType: 'application/json',
              text: JSON.stringify({ itemId: 'ITEM-1', name: 'Runtime item' }),
            },
          },
        },
      ],
    },
  };

  await extensionPage.locator('[data-testid="har-import-input"]').setInputFiles({
    name: 'runtime-fixture.har',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(har)),
  });
  await extensionPage.waitForFunction(
    () => document.body.textContent?.includes('HAR 분석'),
    undefined,
    { timeout: 5_000 },
  );
  const text = await extensionPage.locator('body').textContent();
  assert.match(text || '', /runtime-fixture\.har/);
  assert.match(text || '', /민감값 제거/);
  assert.ok(!(text || '').includes('runtime-secret'));
  assert.ok(!(text || '').includes('runtime-password'));

  const analysisHeader = extensionPage.getByText(/HAR 분석 —/).first();
  const panel = analysisHeader.locator('xpath=ancestor::div[contains(@class, "border-b")]');
  await panel.getByRole('button', { name: '닫기' }).click();
  await extensionPage.waitForFunction(
    () => !document.body.textContent?.includes('HAR 분석 —'),
    undefined,
    { timeout: 5_000 },
  );
}

async function openOpenApiImport(extensionPage, targetPage) {
  await clickSidepanelButton(
    extensionPage,
    targetPage,
    'Open source import menu',
    /소스 가져오기/,
  );
  await extensionPage.getByRole('button', { name: /OpenAPI/ }).click();
  await extensionPage.getByTestId('openapi-import-panel').waitFor();
}

async function verifyOpenApiImportUi(
  extensionPage,
  targetPage,
  collectionCreateRequests,
  sourcePreviewRequests,
  sourceAddRequests,
  collectionDeleteRequests,
  sourceAddMode,
) {
  await openOpenApiImport(extensionPage, targetPage);
  let panel = extensionPage.getByTestId('openapi-import-panel');
  const previewStart = sourcePreviewRequests.length;
  await panel.getByTestId('openapi-url-input').fill(
    'https://api.customer.test/openapi.json?apiKey=redacted',
  );
  await panel.getByRole('button', { name: '미리보기' }).click();
  await panel.getByText(/민감 query key를 제거/).waitFor();
  assert.equal(
    sourcePreviewRequests.length,
    previewStart,
    'sensitive OpenAPI URL query must not reach XGEN',
  );
  await panel.getByTestId('openapi-url-input').fill(
    'https://api.customer.test/openapi.json',
  );
  await panel.getByRole('button', { name: '미리보기' }).click();
  await panel.getByText(/준비도 95/).waitFor();

  const urlPreview = await waitForItem(
    sourcePreviewRequests,
    (entry) => entry.body?.source_url === 'https://api.customer.test/openapi.json',
    'OpenAPI URL preview request',
  );
  assert.equal(urlPreview.body.format_hint, 'openapi');
  assert.deepEqual(
    urlPreview.body.required_capabilities,
    ['input_schema', 'output_schema'],
  );
  assert.ok(!urlPreview.body.target_collection_id);

  const createStart = collectionCreateRequests.length;
  await panel.locator('input[placeholder="collection-id"]').fill('../invalid');
  await panel.getByRole('button', { name: 'Collection에 등록' }).click();
  await panel.getByText(/Collection ID는 영문 또는 숫자로 시작/).waitFor();
  assert.equal(
    collectionCreateRequests.length,
    createStart,
    'invalid Collection ID must not reach XGEN',
  );
  await panel.locator('input[placeholder="collection-id"]').fill('api-customer-test');
  await panel.getByRole('button', { name: 'Collection에 등록' }).click();
  await panel.getByText(/Collection 등록 완료: api-customer-test/).waitFor();
  const created = await waitForItem(
    collectionCreateRequests,
    (entry) => entry.body?.collection_id === 'api-customer-test',
    'OpenAPI Collection create request',
  );
  assert.equal(created.body.name, 'api.customer.test');
  assert.equal(created.body.base_url, 'https://api.customer.test');
  assert.deepEqual(created.body.domain_patterns, ['api.customer.test']);
  const urlSource = await waitForItem(
    sourceAddRequests,
    (entry) => entry.collectionId === 'api-customer-test',
    'OpenAPI URL source add request',
  );
  assert.equal(urlSource.body.source_url, 'https://api.customer.test/openapi.json');
  assert.equal(urlSource.body.format_hint, 'openapi');
  assert.equal(urlSource.body.auto_enrich, false);
  await panel.getByRole('button', { name: '닫기' }).click();
  await panel.waitFor({ state: 'detached' });

  await openOpenApiImport(extensionPage, targetPage);
  panel = extensionPage.getByTestId('openapi-import-panel');
  await panel.getByRole('button', { name: 'JSON/YAML 파일' }).click();
  await panel.getByTestId('openapi-file-input').setInputFiles({
    name: 'sensitive-api.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(`
openapi: 3.0.3
info:
  title: Sensitive URL Fixture
  version: 1.0.0
servers:
  - url: https://yaml.customer.test/api?accessToken=redacted
paths: {}
`),
  });
  await panel.getByText(/문서 URL에서 민감정보를 제거/).waitFor();
  await panel.getByTestId('openapi-file-input').setInputFiles({
    name: 'fixture-api.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(`
openapi: 3.0.3
info:
  title: Fixture YAML API
  version: 1.0.0
servers:
  - url: https://yaml.customer.test/api
paths:
  /items:
    get:
      operationId: listItems
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
`),
  });
  await panel.getByText('Fixture YAML API').waitFor();
  await panel.getByRole('button', { name: '기존 Collection' }).click();
  await panel.locator('select').selectOption('fixture-existing');
  await panel.getByRole('button', { name: '미리보기' }).click();
  await panel.getByText(/이름 충돌 1/).waitFor();

  const filePreview = await waitForItem(
    sourcePreviewRequests,
    (entry) => entry.body?.target_collection_id === 'fixture-existing',
    'OpenAPI YAML preview request',
  );
  assert.equal(filePreview.body.spec?.openapi, '3.0.3');
  assert.equal(filePreview.body.spec?.info?.title, 'Fixture YAML API');
  assert.equal(filePreview.body.source_url, undefined);

  await panel.getByRole('button', { name: 'Collection에 등록' }).click();
  await panel.getByText(/Collection 등록 완료: fixture-existing/).waitFor();
  const fileSource = await waitForItem(
    sourceAddRequests,
    (entry) => entry.collectionId === 'fixture-existing',
    'OpenAPI YAML source add request',
  );
  assert.equal(fileSource.body.spec?.openapi, '3.0.3');
  assert.equal(fileSource.body.label, 'fixture-yaml-api');
  await panel.getByRole('button', { name: '닫기' }).click();
  await panel.waitFor({ state: 'detached' });

  await openOpenApiImport(extensionPage, targetPage);
  panel = extensionPage.getByTestId('openapi-import-panel');
  await panel.getByTestId('openapi-url-input').fill(
    'https://failure.customer.test/openapi.json',
  );
  await panel.getByRole('button', { name: '미리보기' }).click();
  await panel.getByText(/준비도 95/).waitFor();
  sourceAddMode.failNext = true;
  await panel.getByRole('button', { name: 'Collection에 등록' }).click();
  await panel.getByText(/fixture source ingest rejected/).waitFor();
  await waitForItem(
    collectionDeleteRequests,
    (entry) => entry.collectionId === 'failure-customer-test',
    'failed OpenAPI import cleanup',
  );
  await panel.getByRole('button', { name: '닫기' }).click();
  await panel.waitFor({ state: 'detached' });
}

async function verifyDevXgenOriginDetection(extensionPage, browserContext) {
  await browserContext.route('https://dev-xgen.x2bee.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
<html>
  <head><title>XGEN dev fixture</title></head>
  <body>
    <main>Dev XGEN fixture</main>
    <script>
      localStorage.setItem('xgen_access_token', 'dev-xgen-token');
      localStorage.setItem('accessToken', 'dev-xgen-token');
    </script>
  </body>
</html>`,
    });
  });

  const devPage = await browserContext.newPage();
  await devPage.goto('https://dev-xgen.x2bee.com/main?view=tool-storage');
  await devPage.waitForLoadState('domcontentloaded');
  await devPage.waitForFunction(() => localStorage.getItem('accessToken') === 'dev-xgen-token');

  const tabId = await findTabIdByUrl(extensionPage, '^https://dev-xgen\\.x2bee\\.com/main');
  assert.ok(tabId, 'dev-xgen tab id should be discoverable');
  const start = await sendExtensionMessage(extensionPage, {
    type: 'START_CAPTURE_SESSION',
    tabId,
  });
  assert.equal(start?.ok, true, `dev-xgen content injection failed: ${JSON.stringify(start)}`);
  const stop = await sendExtensionMessage(extensionPage, { type: 'STOP_CAPTURE_SESSION' });
  assert.equal(stop?.ok, true, `dev-xgen capture cleanup failed: ${JSON.stringify(stop)}`);
  await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });

  let config;
  for (let attempt = 0; attempt < 25; attempt++) {
    config = await sendExtensionMessage(extensionPage, { type: 'GET_CHAT_CONFIG', tabId });
    if (config?.serverUrl === 'https://dev-xgen.x2bee.com' && config?.authToken === 'dev-xgen-token') {
      await devPage.close();
      await removeExtensionPermissions(
        extensionPage,
        { origins: ['https://dev-xgen.x2bee.com/*'] },
      );
      console.log('dev-xgen origin token detection verified');
      return;
    }
    await wait(200);
  }

  await devPage.close();
  assert.fail(`dev-xgen origin token detection failed: ${JSON.stringify(config)}`);
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
  const graphqlTools = request.body.tools.filter(
    (tool) => tool.captureMetadata?.protocol === 'graphql',
  );
  assert.equal(
    graphqlTools.length,
    2,
    `registration should preserve distinct GraphQL operations: ${JSON.stringify(request.body.tools)}`,
  );
  assert.deepEqual(
    new Set(graphqlTools.map((tool) => tool.captureMetadata?.graphql?.operationName)),
    new Set(['GetGoodsList', 'GetGoodsDetail']),
  );
  const multipartTool = request.body.tools.find(
    (tool) => tool.templatedPath === '/api/documents/upload',
  );
  assert.ok(
    multipartTool?.captureMetadata?.requestBodyKinds?.includes('multipart'),
    `registration should preserve multipart contract evidence: ${JSON.stringify(multipartTool)}`,
  );
}

async function verifyCaptureObservationStopped(
  extensionPage,
  targetPage,
  commandResults,
) {
  await targetPage.bringToFront();
  await targetPage.evaluate(async () => {
    const response = await fetch('/api/goods/v1/search?keyword=after-stop');
    if (!response.ok) throw new Error(`post-stop fixture fetch failed: ${response.status}`);
    await response.json();
  });
  await wait(200);

  const tabId = await findTabIdByUrl(extensionPage, '/workspace/details$');
  const requestId = `verify-capture-disabled-${Date.now()}`;
  const relayed = await sendExtensionMessage(extensionPage, {
    type: 'RELAY_COMMAND',
    tabId,
    event: {
      type: 'page_command',
      requestId,
      action: 'get_captured_apis',
      params: {},
    },
  });
  assert.equal(relayed?.ok, true, `capture status relay failed: ${JSON.stringify(relayed)}`);
  const callback = await waitForCommandResult(
    commandResults,
    requestId,
    'Capture observation stop',
  );
  assert.equal(
    callback.body?.result?.total,
    0,
    `API hook should not capture after session stop: ${JSON.stringify(callback.body)}`,
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
  await rm(artifactDir, { recursive: true, force: true });

  if (!existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error('dist/manifest.json not found. Run `npm run build` before runtime verification.');
  }

  const { chromium } = loadPlaywright();
  if (!existsSync(chromium.executablePath())) {
    throw new Error(
      'Playwright Chromium is not installed. Run `npx playwright install chromium` first.',
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
    collectionCreateRequests,
    sourcePreviewRequests,
    sourceAddRequests,
    collectionDeleteRequests,
    registrationMode,
    sourceAddMode,
  } = await startFixtureServer();
  let context;
  let runtimeError;
  const runtimeLogs = [];

  try {
    const launchOptions = {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${distDir}`,
        `--load-extension=${distDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    };

    context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      args: [...launchOptions.args, '--deny-permission-prompts'],
    });
    attachRuntimeLogging(context, runtimeLogs);
    const extensionId = await resolveExtensionId(context, userDataDir);
    const deniedExtensionPage = await openExtensionPage(context, extensionId);
    const deniedTargetPage = await context.newPage();
    await deniedTargetPage.goto(url);
    await verifyDeniedOptionalPermissions(deniedExtensionPage, deniedTargetPage, url);
    await context.close();
    context = undefined;

    const parsedFixtureUrl = new URL(url);
    await grantPersistedExtensionPermissions(userDataDir, extensionId, {
      permissions: ['cookies'],
      origins: [
        `${parsedFixtureUrl.protocol}//${parsedFixtureUrl.hostname}/*`,
        'https://dev-xgen.x2bee.com/*',
      ],
    });

    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    attachRuntimeLogging(context, runtimeLogs);
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });

    const relaunchedExtensionId = await resolveExtensionId(context, userDataDir);
    assert.equal(relaunchedExtensionId, extensionId, 'extension id should remain stable after restart');
    const extensionPage = await openExtensionPage(context, extensionId);

    await extensionPage.bringToFront();
    const unsupportedStart = await sendExtensionMessage(extensionPage, { type: 'START_CAPTURE_SESSION' });
    assert.equal(unsupportedStart?.ok, false, `START_CAPTURE_SESSION should reject extension pages: ${JSON.stringify(unsupportedStart)}`);
    assert.match(unsupportedStart?.error || '', /http\/https|API 캡처|No active tab/);

    await verifyDevXgenOriginDetection(extensionPage, context);

    const targetPage = await context.newPage();
    await targetPage.goto(url);
    await bootstrapGrantedContentScript(extensionPage, targetPage, url);
    await pinSidepanelToTarget(extensionPage, targetPage);
    await verifyCookiePermissionUi(extensionPage);
    const distractorPage = await context.newPage();
    await distractorPage.goto(`${url}distractor`);
    await verifyPageAgent(extensionPage, targetPage);
    await verifyStoredServerCookieAuth(extensionPage, context, targetPage, url);
    await verifyRelayCommandBridge(extensionPage, targetPage, commandResults);
    await verifySidepanelChatRelay(extensionPage, targetPage, distractorPage, commandResults, chatRequests);
    await verifyHarImportUi(extensionPage);
    await verifyOpenApiImportUi(
      extensionPage,
      targetPage,
      collectionCreateRequests,
      sourcePreviewRequests,
      sourceAddRequests,
      collectionDeleteRequests,
      sourceAddMode,
    );
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

        const graphqlOperations = [
          {
            operationName: 'GetGoodsList',
            query: 'query GetGoodsList($keyword: String!) { goods(keyword: $keyword) { id name } }',
            variables: { keyword: 'jeju' },
          },
          {
            operationName: 'GetGoodsDetail',
            query: 'query GetGoodsDetail($id: ID!) { goodsDetail(id: $id) { id name price } }',
            variables: { id: 'G10001' },
          },
        ];
        for (const operation of graphqlOperations) {
          const graphql = await fetch('/graphql', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(operation),
          });
          if (!graphql.ok) throw new Error(`fixture GraphQL failed: ${graphql.status}`);
          await graphql.json();
        }

        const form = new FormData();
        form.append('title', 'runtime fixture');
        form.append(
          'attachment',
          new File(['not-persisted-file-content'], 'private-customer-name.pdf', {
            type: 'application/pdf',
          }),
        );
        const upload = await fetch('/api/documents/upload', { method: 'POST', body: form });
        if (!upload.ok) throw new Error(`fixture upload failed: ${upload.status}`);
        await upload.json();
      });
    }, 'fetch+xhr capture', distractorPage);
    await verifySessionResultRegistration(extensionPage, targetPage, registrationRequests);
    await verifyCaptureObservationStopped(
      extensionPage,
      targetPage,
      commandResults,
    );

    const searchApi = findApi(firstApis, 'GET', '/api/goods/v1/search?keyword=jeju');
    assert.ok(searchApi, `captured search API not found in ${JSON.stringify(firstApis)}`);
    assert.equal(searchApi.responseStatus, 200);
    assert.match(searchApi.responseBody || '', /987654/);
    const memberApi = findApi(firstApis, 'POST', '/api/member/v1/me');
    assert.ok(memberApi, `captured XHR API not found in ${JSON.stringify(firstApis)}`);
    assert.match(memberApi.requestBody || '', /includeGrade/);
    const graphqlApis = firstApis.filter((api) => api.method === 'POST' && api.url.endsWith('/graphql'));
    assert.equal(graphqlApis.length, 2, `GraphQL operations should be captured: ${JSON.stringify(firstApis)}`);
    assert.deepEqual(
      new Set(graphqlApis.map((api) => api.requestMetadata?.graphql?.operationName)),
      new Set(['GetGoodsList', 'GetGoodsDetail']),
    );
    const uploadApi = findApi(firstApis, 'POST', '/api/documents/upload');
    assert.ok(uploadApi, `multipart upload not captured: ${JSON.stringify(firstApis)}`);
    assert.equal(uploadApi.requestMetadata?.bodyKind, 'multipart');
    assert.equal(uploadApi.requestMetadata?.fileFields?.[0]?.fieldPath, 'attachment');
    assert.ok(
      !JSON.stringify(uploadApi).includes('not-persisted-file-content'),
      'multipart file bytes must not be captured',
    );
    assert.ok(
      !JSON.stringify(uploadApi).includes('private-customer-name.pdf'),
      'multipart file names must not be captured',
    );
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
    await verifyOptionalPermissionLifecycle(extensionPage, context, targetPage, url);

    console.log([
      `PathFinder runtime verification passed: extension loaded (${extensionId})`,
      'PageAgent context and commands verified',
      'stored server cookie auth verified',
      'page_command relay callback verified',
      'sidepanel chat relay verified',
      'OpenAPI URL/YAML import and rollback verified',
      'capture result registration verified',
      'capture result merge conflict verified',
      'privacy-safe HAR import verified',
      'capture payload memory release verified',
      'optional host/cookie denial, persisted grant, and revoke cleanup verified',
      `fetch/xhr captured ${firstApis.length} API request(s)`,
      `navigation reinjection captured ${secondApis.length} API request(s)`,
    ].join('; '));
  } catch (error) {
    runtimeError = error;
    throw error;
  } finally {
    if (runtimeError) {
      await writeFailureArtifacts(context, runtimeError, runtimeLogs).catch((artifactError) => {
        console.error('Failed to write PathFinder failure artifacts:', artifactError);
      });
    } else {
      await context?.tracing.stop().catch(() => {});
    }
    await context?.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
