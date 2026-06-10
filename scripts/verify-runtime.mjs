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

function startFixtureServer() {
  const server = createServer((req, res) => {
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

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
  <head><title>PathFinder fixture</title></head>
  <body><button id="search">search</button></body>
</html>`);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
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

function findApi(apis, method, pathPart) {
  return apis.find((api) => api.method === method && api.url.includes(pathPart));
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
  const { server, url } = await startFixtureServer();
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

    const firstApis = await runCaptureSession(extensionPage, targetPage, async () => {
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
    }, 'fetch+xhr capture');

    const searchApi = findApi(firstApis, 'GET', '/api/goods/v1/search?keyword=jeju');
    assert.ok(searchApi, `captured search API not found in ${JSON.stringify(firstApis)}`);
    assert.equal(searchApi.responseStatus, 200);
    assert.match(searchApi.responseBody || '', /987654/);
    const memberApi = findApi(firstApis, 'POST', '/api/member/v1/me');
    assert.ok(memberApi, `captured XHR API not found in ${JSON.stringify(firstApis)}`);
    assert.match(memberApi.requestBody || '', /includeGrade/);
    assert.ok(!firstApis.some((api) => api.url.includes('/fragment')), 'HTML fetch should be ignored');

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
