#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(
  process.env.PATHFINDER_EXTENSION_DIR || path.join(repoRoot, 'dist'),
);
const artifactDir = path.resolve(
  process.env.PATHFINDER_LIVE_ARTIFACT_DIR
    || path.join(repoRoot, 'artifacts/live-xgen-session'),
);
const serverOrigin = new URL(
  process.env.PATHFINDER_XGEN_URL || 'https://dev-xgen.x2bee.com',
).origin;
const token = process.env.PATHFINDER_XGEN_TOKEN || '';

assert.ok(token, 'PATHFINDER_XGEN_TOKEN is required for live session verification');
assert.ok(existsSync(path.join(distDir, 'manifest.json')), 'Build the extension before verification');

function extensionIdForPath(extensionPath) {
  const digest = createHash('sha256')
    .update(path.resolve(extensionPath))
    .digest('hex')
    .slice(0, 32);
  return [...digest]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join('');
}

function sendExtensionMessage(page, message) {
  return page.evaluate((payload) => new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => resolve(response));
  }), message);
}

const { chromium } = require('playwright');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-live-session-'));
let context;

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--deny-permission-prompts',
    ],
  });
  await context.addCookies([{
    name: 'xgen_access_token',
    value: token,
    url: `${serverOrigin}/`,
    sameSite: 'Lax',
  }]);

  const xgenPage = await context.newPage();
  await xgenPage.goto(`${serverOrigin}/main?view=current-chat`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  const extensionId = extensionIdForPath(distDir);
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await context.waitForEvent('serviceworker', { timeout: 5_000 }).catch(() => null);

  const permissionState = await extensionPage.evaluate((origin) => Promise.all([
    chrome.permissions.contains({ origins: [`${origin}/*`] }),
    chrome.permissions.contains({ permissions: ['cookies'] }),
  ]), serverOrigin);
  assert.deepEqual(
    permissionState,
    [true, false],
    'live verification must use required XGEN host access without optional cookie permission',
  );

  const tabId = await extensionPage.evaluate((origin) => new Promise((resolve) => {
    chrome.tabs.query({ url: `${origin}/*` }, (tabs) => resolve(tabs[0]?.id || null));
  }), serverOrigin);
  assert.ok(tabId, 'live XGEN tab should be visible to the extension');

  await extensionPage.evaluate(() => new Promise((resolve) => {
    chrome.storage.local.set({
      serverUrl: 'http://localhost:8080',
      authToken: 'stale-live-verification-token',
    }, resolve);
  }));

  const config = await sendExtensionMessage(extensionPage, {
    type: 'GET_CHAT_CONFIG',
    tabId,
  });
  assert.equal(config?.serverUrl, serverOrigin);
  assert.equal(config?.authToken, token);

  const providerResponse = await fetch(`${serverOrigin}/api/ai-chat/providers`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(
    providerResponse.ok,
    true,
    `authenticated provider probe failed with ${providerResponse.status}`,
  );

  await xgenPage.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  const refreshedConfig = await sendExtensionMessage(extensionPage, {
    type: 'GET_CHAT_CONFIG',
    tabId,
  });
  assert.equal(refreshedConfig?.serverUrl, serverOrigin);
  assert.equal(refreshedConfig?.authToken, token);

  await extensionPage.reload({ waitUntil: 'domcontentloaded' });
  await extensionPage.locator('[data-testid="settings-toggle"]').click();
  await extensionPage.getByText('로그인 세션 감지됨', { exact: false }).waitFor({
    timeout: 15_000,
  });
  await extensionPage.getByText('dev-xgen.x2bee.com', { exact: false }).waitFor({
    timeout: 15_000,
  });

  await mkdir(artifactDir, { recursive: true });
  await xgenPage.screenshot({
    path: path.join(artifactDir, 'dev-xgen-session-page.png'),
    fullPage: false,
  });
  await extensionPage.screenshot({
    path: path.join(artifactDir, 'pathfinder-session-panel.png'),
    fullPage: false,
  });

  console.log(JSON.stringify({
    status: 'passed',
    serverOrigin,
    optionalCookiePermission: false,
    staleServerOverridden: true,
    authenticatedProviderProbe: true,
    refreshPreserved: true,
    settingsSessionRendered: true,
    artifactDir,
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await rm(userDataDir, { recursive: true, force: true });
}
