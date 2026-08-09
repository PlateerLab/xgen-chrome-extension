#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

async function assertValueFreeCaptureSessionStorage(extensionPage, label) {
  const stored = await getExtensionSessionStorage(
    extensionPage,
    'runtime:capture-session',
  );
  const metadata = stored['runtime:capture-session'];
  assert.ok(metadata, `${label}: persisted capture metadata should exist`);
  assert.deepEqual(
    Object.keys(metadata).sort(),
    ['phase', 'sessionId', 'startedAt', 'tabId'],
    `${label}: capture storage must contain metadata only`,
  );
  assert.equal('captures' in metadata, false);
  assert.equal('requestBody' in metadata, false);
  assert.equal('responseBody' in metadata, false);
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
      /([?&](?:authorization|cookie|password|passwd|pwd|access[_-]?token|refresh[_-]?token|token|api[_-]?key|session|secret|client[_-]?secret)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:authorization|cookie|password|passwd|pwd|access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|client[_-]?secret)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[REDACTED:EMAIL]',
    )
    .replace(
      /\+\d{1,3}(?:[-\s]?\d){7,14}\b/g,
      '[REDACTED:PHONE]',
    )
    .replace(
      /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g,
      '[REDACTED:PHONE]',
    )
    .replace(/\b\d{12,19}\b/g, '[REDACTED:LONG_NUMBER]');
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
    `${[
      ...logs.map((entry) => scrubRuntimeLog(entry)),
      `[failure] ${scrubRuntimeLog(errorText)}`,
    ].join('\n')}\n`,
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
  const legacyToolSaveRequests = [];
  const mergeRequests = [];
  const collectionCreateRequests = [];
  const sourcePreviewRequests = [];
  const sourceAddRequests = [];
  const collectionDeleteRequests = [];
  const capabilityRequests = [];
  const mcpSessionRequests = [];
  const mcpSourcePreviewRequests = [];
  const mcpSourceAddRequests = [];
  const authProfiles = [
    {
      service_id: '127_local_profile',
      name: '127 local profile',
      description: 'operator managed fixture profile',
      status: 'active',
    },
  ];
  const authProfileMutations = [];
  const workerApiRequests = [];
  const registrationMode = { conflictNext: false };
  const sourceAddMode = { failNext: false };
  const collectionDetailMode = { failNext: false };
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
      res.end(JSON.stringify(authProfiles));
      return;
    }

    if (
      req.method === 'GET'
      && req.url === '/api/tools/api-collections/capabilities'
    ) {
      capabilityRequests.push({ headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        contract: {
          name: 'xgen-pathfinder-api-collection',
          version: 1,
          min_client_version: 1,
          max_client_version: 1,
        },
        engine: {
          graph_tool_call_version: '0.33.0',
        },
        capabilities: {
          trace_collection_import: true,
          collection_build_status: true,
          collection_quality_summaries: true,
          collection_search: true,
          collection_plan: true,
          collection_execute: true,
          quality_lab: true,
          auth_profile_resolution: true,
          mcp_source_ingest: true,
        },
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/session-station/v1/auth-profiles') {
      readJsonRequest(req, (body) => {
        authProfileMutations.push({
          method: 'POST',
          serviceId: String(body.service_id || ''),
          managed: String(body.description || '').includes('[pathfinder:auto]'),
          hasLoginConfig: Boolean(body.login_config),
          extractionRuleCount: Array.isArray(body.extraction_rules)
            ? body.extraction_rules.length
            : 0,
        });
        authProfiles.push({
          service_id: String(body.service_id || ''),
          name: String(body.name || ''),
          description: String(body.description || ''),
          status: 'active',
        });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          service_id: body.service_id,
          status: 'active',
        }));
      });
      return;
    }

    const authProfileUpdateMatch = req.url?.match(
      /^\/api\/session-station\/v1\/auth-profiles\/([^/]+)$/,
    );
    if (req.method === 'PUT' && authProfileUpdateMatch) {
      readJsonRequest(req, (body) => {
        authProfileMutations.push({
          method: 'PUT',
          serviceId: decodeURIComponent(authProfileUpdateMatch[1]),
          managed: String(body.description || '').includes('[pathfinder:auto]'),
          hasLoginConfig: Boolean(body.login_config),
          extractionRuleCount: Array.isArray(body.extraction_rules)
            ? body.extraction_rules.length
            : 0,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          service_id: decodeURIComponent(authProfileUpdateMatch[1]),
          status: 'active',
        }));
      });
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
          domain_patterns: ['127.0.0.1'],
          auth_profile_id: '127_local_profile',
        },
      ]));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/mcp/sessions') {
      mcpSessionRequests.push({ headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        {
          session_id: 'session-customer-crm',
          session_name: 'Customer Relationship Management',
          server_type: 'node',
          status: 'running',
          tool_count: 128,
          is_shared: true,
        },
        {
          session_id: 'session-stopped',
          session_name: 'Stopped session',
          server_type: 'python',
          status: 'stopped',
          tool_count: 3,
        },
      ]));
      return;
    }

    const mcpPreviewMatch = req.url?.match(
      /^\/api\/tools\/api-collections\/([^/]+)\/mcp-sources\/preview$/,
    );
    if (req.method === 'POST' && mcpPreviewMatch) {
      const collectionId = decodeURIComponent(mcpPreviewMatch[1]);
      readJsonRequest(req, (body) => {
        mcpSourcePreviewRequests.push({
          collectionId,
          headers: req.headers,
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          incoming_tool_count: 128,
          conflicts: [],
          existing_total: 3,
          ingest_supported: true,
          ingest_stats: { generated_tool_count: 128 },
          ingest_result: {
            adapter: 'mcp-tools',
            ready: true,
            issues: [],
            api_collection_execution_supported: true,
          },
          source_context: {
            session_count: 1,
            session_ids: ['session-customer-crm'],
          },
        }));
      });
      return;
    }

    const mcpSourceMatch = req.url?.match(
      /^\/api\/tools\/api-collections\/([^/]+)\/mcp-sources$/,
    );
    if (req.method === 'POST' && mcpSourceMatch) {
      const collectionId = decodeURIComponent(mcpSourceMatch[1]);
      readJsonRequest(req, (body) => {
        mcpSourceAddRequests.push({
          collectionId,
          headers: req.headers,
          body,
        });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          collection_id: collectionId,
          tool_count: 131,
          source_count: 2,
          ingest_result: {
            adapter: 'mcp-tools',
            ready: true,
          },
        }));
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/tools/api-collections/preview') {
      readJsonRequest(req, (body) => {
        sourcePreviewRequests.push({ headers: req.headers, body });
        const adapter = body.format_hint === 'graphql-introspection'
          ? 'graphql-introspection'
          : 'openapi';
        const toolCount = adapter === 'graphql-introspection' ? 3 : 2;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          incoming_tool_count: toolCount,
          conflicts: body.target_collection_id ? ['listItems'] : [],
          edges_before: body.target_collection_id ? 1 : 0,
          edges_after: body.target_collection_id ? 3 : 2,
          edges_added: 2,
          existing_total: body.target_collection_id ? 3 : 0,
          spec_hash: 'fixture-openapi-hash',
          ingest_stats: { inserted: 2 },
          ingest_result: {
            adapter,
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
              tool_count: toolCount,
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
          tool_count: body.format_hint === 'graphql-introspection' ? 3 : 2,
          source_count: 1,
          ingest_result: {
            adapter: body.format_hint === 'graphql-introspection'
              ? 'graphql-introspection'
              : 'openapi',
            ready: true,
          },
        }));
      });
      return;
    }

    const collectionDetailMatch = req.url?.match(
      /^\/api\/tools\/api-collections\/([^/]+)$/,
    );
    if (req.method === 'GET' && collectionDetailMatch) {
      if (collectionDetailMode.failNext) {
        collectionDetailMode.failNext = false;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'fixture collection detail unsupported' }));
        return;
      }
      const collectionId = decodeURIComponent(collectionDetailMatch[1]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        collection_id: collectionId,
        name: 'Fixture Collection',
        tool_count: 256,
        edge_count: 12,
        source_count: 1,
        graph_tool_call_version: '0.35.0',
        collection_graph_version: 2,
        readiness_summary: {
          readiness_score: 96,
          status: 'ready',
          tool_count: 256,
        },
        semantic_summary: {
          canonical_action_known_rate: 0.98,
          primary_resource_assigned_rate: 0.91,
          path_module_assigned_rate: 1,
        },
        edge_quality_summary: {
          total: 12,
          strong_deterministic_evidence: 9,
          strong_deterministic_evidence_rate: 0.75,
          visual_edge_candidate_count: 9,
        },
        auth_profile_id: collectionId === 'graphql-customer-test'
          ? null
          : '127_local_profile',
        workspace_status: 'ready',
      }));
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

    if (req.method === 'POST' && req.url === '/api/tools/storage/save') {
      readJsonRequest(req, (body) => {
        legacyToolSaveRequests.push({ headers: req.headers, body });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, function_name: body.function_name }));
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

    if (req.url?.startsWith('/fixture-base/api/relative/v1/list')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rows: [{ id: 'REL-10001' }] }));
      return;
    }

    if (req.url === '/api/large/v1/report') {
      const body = JSON.stringify({ data: 'x'.repeat((100 * 1024) + 20_000) });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (req.url === '/api/binary/v1/export') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0, 1, 2, 3, 4, 5]));
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

    if (req.method === 'POST' && req.url === '/api/login') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            access_token: 'runtime-auth-response-secret',
          },
        }));
      });
      return;
    }

    if (req.url === '/fixture-sw.js') {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'service-worker-allowed': '/',
      });
      res.end(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data === 'fetch-worker-api') {
    event.waitUntil(fetch('/api/worker/v1/background'));
  }
});
`);
      return;
    }

    if (req.url === '/api/worker/v1/background') {
      workerApiRequests.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
      return;
    }

    if (req.url?.startsWith('/api/iframe/v1/detail')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({
        itemId: 'IFRAME-10001',
        itemName: 'iframe fixture item',
      }));
      return;
    }

    if (req.url === '/iframe-fixture' || req.url === '/iframe-blocked') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
  <head><title>PathFinder iframe fixture</title></head>
  <body><button id="iframe-action">iframe action</button></body>
</html>`);
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
    <base href="/fixture-base/" />
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
      <iframe
        id="api-frame"
        title="API frame fixture"
        src="http://localhost:${server.address().port}/iframe-fixture"
      ></iframe>
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
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
        commandResults,
        chatRequests,
        registrationRequests,
        legacyToolSaveRequests,
        mergeRequests,
        collectionCreateRequests,
        sourcePreviewRequests,
        sourceAddRequests,
        collectionDeleteRequests,
        capabilityRequests,
        mcpSessionRequests,
        mcpSourcePreviewRequests,
        mcpSourceAddRequests,
        authProfileMutations,
        workerApiRequests,
        registrationMode,
        sourceAddMode,
        collectionDetailMode,
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

function unpackedExtensionId(extensionPath) {
  const digest = createHash('sha256')
    .update(path.resolve(extensionPath))
    .digest('hex')
    .slice(0, 32);
  return [...digest]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join('');
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
  extensionId ||= unpackedExtensionId(distDir);
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

async function terminateExtensionServiceWorker(context, extensionId) {
  const bootstrapPage = context.pages()[0] || await context.newPage();
  const cdp = await context.newCDPSession(bootstrapPage);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find((candidate) => (
    candidate.type === 'service_worker'
    && candidate.url === `chrome-extension://${extensionId}/service-worker-loader.js`
  ));
  assert.ok(target?.targetId, 'extension Service Worker target should be running');
  const closed = await cdp.send('Target.closeTarget', { targetId: target.targetId });
  assert.equal(closed.success, true, 'extension Service Worker target should terminate');
}

async function waitForCaptureSessionStatus(extensionPage, predicate, label) {
  let response;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    response = await sendExtensionMessage(extensionPage, {
      type: 'GET_CAPTURE_SESSION_STATUS',
    }).catch(() => null);
    if (response && predicate(response)) return response;
    await wait(100);
  }
  assert.fail(`${label}: capture session status not reached: ${JSON.stringify(response)}`);
}

async function verifyCaptureSessionLifecycle(
  context,
  extensionId,
  targetPage,
) {
  const controlPage = await context.newPage();
  await controlPage.goto(`chrome-extension://${extensionId}/src/demo/index.html`);
  await targetPage.bringToFront();

  const firstStart = await sendExtensionMessage(controlPage, {
    type: 'START_CAPTURE_SESSION',
  });
  assert.equal(firstStart?.ok, true);
  assert.ok(firstStart.sessionId, 'capture start should return sessionId');
  const duplicateStart = await sendExtensionMessage(controlPage, {
    type: 'START_CAPTURE_SESSION',
  });
  assert.equal(duplicateStart?.ok, true);
  assert.equal(duplicateStart?.alreadyActive, true);
  assert.equal(duplicateStart?.sessionId, firstStart.sessionId);

  const activeStatus = await sendExtensionMessage(controlPage, {
    type: 'GET_CAPTURE_SESSION_STATUS',
  });
  assert.equal(activeStatus?.state, 'active');
  assert.equal(activeStatus?.sessionId, firstStart.sessionId);
  const staleStop = await sendExtensionMessage(controlPage, {
    type: 'STOP_CAPTURE_SESSION',
    sessionId: 'stale-session-id',
  });
  assert.equal(staleStop?.ok, false);
  assert.match(staleStop?.error || '', /Stale capture session/);
  assert.equal(
    (await sendExtensionMessage(controlPage, { type: 'GET_CAPTURE_SESSION_STATUS' }))?.state,
    'active',
  );

  const stopped = await sendExtensionMessage(controlPage, {
    type: 'STOP_CAPTURE_SESSION',
    sessionId: firstStart.sessionId,
  });
  assert.equal(stopped?.ok, true);
  assert.ok(stopped?.resultId);
  const stableResult = await sendExtensionMessage(controlPage, { type: 'GET_CAPTURE_RESULT' });
  assert.equal(stableResult?.result?.resultId, stopped.resultId);
  assert.equal(stableResult?.result?.state, 'completed');
  assert.equal(
    (await sendExtensionMessage(controlPage, { type: 'GET_CAPTURE_RESULT' }))?.result?.resultId,
    stopped.resultId,
  );
  assert.equal((await sendExtensionMessage(controlPage, {
    type: 'ACK_CAPTURE_RESULT',
    resultId: stopped.resultId,
  }))?.ok, true);
  assert.equal(
    (await sendExtensionMessage(controlPage, { type: 'GET_CAPTURE_RESULT' }))?.result,
    null,
  );

  const secondPage = await context.newPage();
  await secondPage.goto(`${targetPage.url()}?capture-tab=second`);
  const firstTabId = await findTabIdByUrl(
    controlPage,
    `^${targetPage.url().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
  );
  const secondTabId = await findTabIdByUrl(controlPage, 'capture-tab=second');
  assert.ok(firstTabId && secondTabId, 'both capture lifecycle tabs should be discoverable');
  const tabAStart = await sendExtensionMessage(controlPage, {
    type: 'START_CAPTURE_SESSION',
    tabId: firstTabId,
  });
  assert.equal(tabAStart?.ok, true);
  const tabBStart = await sendExtensionMessage(controlPage, {
    type: 'START_CAPTURE_SESSION',
    tabId: secondTabId,
  });
  assert.equal(tabBStart?.ok, true);
  assert.notEqual(tabBStart?.sessionId, tabAStart?.sessionId);
  const tabBStatus = await sendExtensionMessage(controlPage, {
    type: 'GET_CAPTURE_SESSION_STATUS',
  });
  assert.equal(tabBStatus?.tabId, secondTabId);
  assert.equal(tabBStatus?.state, 'active');
  await targetPage.waitForFunction(() => window.__xgenApiHookActive === false);
  await secondPage.waitForFunction(() => window.__xgenApiHookActive === true);
  const tabBStop = await sendExtensionMessage(controlPage, {
    type: 'STOP_CAPTURE_SESSION',
    sessionId: tabBStart.sessionId,
  });
  assert.equal(tabBStop?.ok, true);
  assert.equal((await sendExtensionMessage(controlPage, {
    type: 'ACK_CAPTURE_RESULT',
    resultId: tabBStop.resultId,
  }))?.ok, true);
  await secondPage.close();

  await targetPage.bringToFront();
  const restartStart = await sendExtensionMessage(controlPage, {
    type: 'START_CAPTURE_SESSION',
  });
  assert.equal(restartStart?.ok, true);
  await targetPage.waitForFunction(() => window.__xgenApiHookActive === true);
  await terminateExtensionServiceWorker(context, extensionId);
  const recoveredStatus = await waitForCaptureSessionStatus(
    controlPage,
    (status) => status.state === 'idle',
    'MV3 restart recovery',
  );
  assert.equal(recoveredStatus.active, false);
  const interrupted = await sendExtensionMessage(controlPage, { type: 'GET_CAPTURE_RESULT' });
  assert.equal(interrupted?.result?.sessionId, restartStart.sessionId);
  assert.equal(interrupted?.result?.state, 'interrupted');
  assert.equal(interrupted?.result?.reason, 'service_worker_restarted');
  assert.deepEqual(interrupted?.result?.apis, []);
  await targetPage.waitForFunction(
    () => window.__xgenApiHookActive === false,
    undefined,
    { timeout: 5_000 },
  );
  assert.equal((await sendExtensionMessage(controlPage, {
    type: 'ACK_CAPTURE_RESULT',
    resultId: interrupted.result.resultId,
  }))?.ok, true);
  await controlPage.close();
}

async function runCaptureSession(extensionPage, targetPage, action, label) {
  await extensionPage.evaluate(() => {
    const runtimeWindow = window;
    runtimeWindow.__pathfinderRuntimeCaptureResults = [];
    if (runtimeWindow.__pathfinderRuntimeCaptureListenerInstalled) return;
    runtimeWindow.__pathfinderRuntimeCaptureListenerInstalled = true;
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'CAPTURE_SESSION_RESULT') {
        runtimeWindow.__pathfinderRuntimeCaptureResults.push(message);
      }
    });
  });
  await targetPage.bringToFront();
  const start = await sendExtensionMessage(extensionPage, { type: 'START_CAPTURE_SESSION' });
  assert.equal(start?.ok, true, `${label}: START_CAPTURE_SESSION failed: ${JSON.stringify(start)}`);

  await action();
  await assertValueFreeCaptureSessionStorage(extensionPage, label);

  await targetPage.bringToFront();
  const stop = await sendExtensionMessage(extensionPage, { type: 'STOP_CAPTURE_SESSION' });
  assert.equal(stop?.ok, true, `${label}: STOP_CAPTURE_SESSION failed: ${JSON.stringify(stop)}`);
  assert.ok(stop.count >= 1, `${label}: expected at least one captured API, got ${stop.count}`);
  assert.ok(stop.sessionId, `${label}: stop response should include sessionId`);
  assert.ok(stop.resultId, `${label}: stop response should include resultId`);

  const cached = await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });
  assert.equal(cached?.ok, true, `${label}: GET_CAPTURE_RESULT failed: ${JSON.stringify(cached)}`);
  const broadcastResult = await extensionPage.evaluate(() => (
    window.__pathfinderRuntimeCaptureResults?.at(-1) || null
  ));
  const result = cached?.result || broadcastResult;
  assert.equal(result?.resultId, stop.resultId, `${label}: resultId mismatch`);
  const apis = result?.apis || [];
  assert.equal(apis.length, stop.count, `${label}: cached result count mismatch`);
  if (cached?.result) {
    const repeated = await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });
    assert.equal(
      repeated?.result?.resultId,
      stop.resultId,
      `${label}: result should remain stable until acknowledged`,
    );
    const acknowledged = await sendExtensionMessage(extensionPage, {
      type: 'ACK_CAPTURE_RESULT',
      resultId: stop.resultId,
    });
    assert.equal(acknowledged?.ok, true, `${label}: capture result acknowledgement failed`);
  }
  const consumed = await sendExtensionMessage(extensionPage, { type: 'GET_CAPTURE_RESULT' });
  assert.equal(consumed?.result, null, `${label}: acknowledged capture result should be released`);
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
  if (stop.resultId) {
    await sendExtensionMessage(extensionPage, {
      type: 'ACK_CAPTURE_RESULT',
      resultId: stop.resultId,
    });
  }
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
  await extensionPage.evaluate(() => {
    const runtimeWindow = window;
    runtimeWindow.__pathfinderRuntimeCaptureResults = [];
    if (runtimeWindow.__pathfinderRuntimeCaptureListenerInstalled) return;
    runtimeWindow.__pathfinderRuntimeCaptureListenerInstalled = true;
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'CAPTURE_SESSION_RESULT') {
        runtimeWindow.__pathfinderRuntimeCaptureResults.push(message);
      }
    });
  });
  await clickSidepanelButton(extensionPage, activePageForControls, `${label}: start`, /캡처 세션 시작/);
  await extensionPage.waitForFunction(() => document.body.innerText.includes('캡처 중'));
  await targetPage.waitForFunction(
    () => (window).__xgenApiHookActive === true,
    undefined,
    { timeout: 5_000 },
  );

  await action();
  await assertValueFreeCaptureSessionStorage(extensionPage, label);
  await extensionPage.waitForFunction(
    () => /캡처 중[^]*\([1-9]\d*건\)/.test(document.body.innerText),
    undefined,
    { timeout: 5_000 },
  );

  await clickSidepanelButton(extensionPage, activePageForControls, `${label}: stop`, /캡처 종료/);
  await extensionPage.waitForFunction(() => document.body.innerText.includes('캡처 분석'));

  const capturedResult = await extensionPage.evaluate(() => (
    window.__pathfinderRuntimeCaptureResults?.at(-1) || null
  ));
  const apis = capturedResult?.apis || [];
  assert.ok(apis.length >= 1, `${label}: expected at least one captured API, got ${apis.length}`);
  return {
    apis,
    captureCoverage: capturedResult?.captureCoverage,
  };
}

function findApi(apis, method, pathPart) {
  return apis.find((api) => api.method === method && api.url.includes(pathPart));
}

function captureSummary(apis) {
  return apis.map((api) => {
    let endpoint = '(invalid URL)';
    try {
      const parsed = new URL(api.url);
      endpoint = `${parsed.origin}${parsed.pathname}`;
    } catch {
      // Keep malformed URLs opaque so query credentials cannot reach artifacts.
    }
    return {
      method: api.method,
      endpoint,
      responseStatus: api.responseStatus,
    };
  });
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

async function verifyXgenCompatibilityUi(extensionPage) {
  await extensionPage.getByTestId('settings-toggle').click();
  await extensionPage.waitForFunction(
    () => document.querySelector('[data-testid="xgen-compatibility-status"]')
      ?.textContent?.includes('연동 계약 v1 · 호환'),
    undefined,
    { timeout: 5_000 },
  );
  assert.match(
    await extensionPage.getByTestId('xgen-compatibility-status').innerText(),
    /연동 계약 v1 · 호환/,
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

async function openGraphQLImport(extensionPage, targetPage) {
  await clickSidepanelButton(
    extensionPage,
    targetPage,
    'Open source import menu',
    /소스 가져오기/,
  );
  await extensionPage.getByRole('button', { name: /GraphQL Introspection/ }).click();
  await extensionPage.getByTestId('graphql-import-panel').waitFor();
}

async function openManualToolContract(extensionPage, targetPage) {
  await clickSidepanelButton(
    extensionPage,
    targetPage,
    'Open source import menu',
    /소스 가져오기/,
  );
  await extensionPage.getByRole('button', { name: /수동 Tool Contract/ }).click();
  await extensionPage.getByTestId('manual-tool-contract-panel').waitFor();
}

async function verifyManualToolContractUi(
  extensionPage,
  targetPage,
  fixtureUrl,
  collectionCreateRequests,
  sourcePreviewRequests,
  sourceAddRequests,
) {
  await openManualToolContract(extensionPage, targetPage);
  const editor = extensionPage.getByTestId('manual-tool-contract-panel');
  const endpoint = `${new URL(fixtureUrl).origin}/api/orders/{orderId}`;
  await editor.getByLabel('HTTP method').selectOption('POST');
  await editor.getByTestId('manual-endpoint-input').fill(endpoint);
  await editor.locator('input[placeholder^="operationId"]').fill('createOrderFromManual');
  await editor.getByTestId('manual-summary-input').fill('주문을 생성합니다.');
  await editor.getByRole('button', { name: '+ parameter' }).click();
  await editor.getByLabel('parameter 1 이름').fill('dryRun');
  await editor.getByLabel('parameter 1 위치').selectOption('query');
  await editor.getByLabel('parameter 1 타입').selectOption('boolean');
  await editor.getByTestId('manual-request-schema').fill(JSON.stringify({
    type: 'object',
    required: ['sku', 'quantity'],
    properties: {
      sku: { type: 'string', example: 'MUST-NOT-PERSIST' },
      quantity: { type: 'integer', minimum: 1 },
    },
  }));
  const previewStart = sourcePreviewRequests.length;
  await editor.getByTestId('manual-response-schema').fill('{"type":"object"');
  await editor.getByRole('button', { name: 'contract 검증' }).click();
  await editor.getByText(/응답 JSON Schema 파싱 실패/).waitFor();
  assert.equal(
    sourcePreviewRequests.length,
    previewStart,
    'invalid manual schema must not reach XGEN preview',
  );
  await editor.getByTestId('manual-response-schema').fill(JSON.stringify({
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string' },
      accepted: { type: 'boolean' },
    },
  }));
  await editor.getByLabel('인증 요구사항').selectOption('bearer');
  await editor.getByRole('button', { name: 'contract 검증' }).click();

  const panel = extensionPage.getByTestId('openapi-import-panel');
  await panel.waitFor();
  await panel.getByText(/example\/default 값은 개인정보 보호를 위해 제외/).waitFor();
  await panel.getByRole('button', { name: '미리보기' }).click();
  await panel.getByText(/준비도 95/).waitFor();

  const preview = await waitForItem(
    sourcePreviewRequests,
    (entry) => (
      entry.body?.spec?.paths?.['/api/orders/{orderId}']?.post
        ?.operationId === 'createOrderFromManual'
    ),
    'manual tool contract preview request',
  );
  assert.equal(sourcePreviewRequests.length, previewStart + 1);
  assert.equal(preview.body.format_hint, 'openapi');
  assert.equal(preview.body.spec.openapi, '3.1.0');
  const operation = preview.body.spec.paths['/api/orders/{orderId}'].post;
  assert.equal(operation.summary, '주문을 생성합니다.');
  assert.equal(operation.parameters[0].name, 'dryRun');
  assert.equal(operation.parameters[0].in, 'query');
  assert.equal(operation.parameters[1].name, 'orderId');
  assert.equal(operation.parameters[1].required, true);
  assert.equal(
    operation.requestBody.content['application/json'].schema.properties.sku.example,
    undefined,
  );
  assert.equal(
    operation.responses['200'].content['application/json'].schema
      .properties.orderId.type,
    'string',
  );
  assert.deepEqual(operation.security, [{ pathfinderManualAuth: [] }]);
  assert.equal(operation['x-pathfinder-source'].sample_values_persisted, false);
  assert.ok(!JSON.stringify(preview.body).includes('MUST-NOT-PERSIST'));

  await panel.locator('input[placeholder="collection-id"]').fill('manual-runtime');
  await panel.locator('input[placeholder="Collection 이름"]').fill('Manual Runtime');
  await panel.getByRole('button', { name: 'Collection에 등록' }).click();
  await panel.getByText(/Collection 등록 완료: manual-runtime/).waitFor();

  const created = await waitForItem(
    collectionCreateRequests,
    (entry) => entry.body?.collection_id === 'manual-runtime',
    'manual contract Collection create request',
  );
  assert.equal(created.body.base_url, new URL(fixtureUrl).origin);
  assert.deepEqual(created.body.domain_patterns, [new URL(fixtureUrl).hostname]);
  const source = await waitForItem(
    sourceAddRequests,
    (entry) => entry.collectionId === 'manual-runtime',
    'manual contract source add request',
  );
  assert.equal(
    source.body.spec.paths['/api/orders/{orderId}'].post.operationId,
    'createOrderFromManual',
  );
  assert.ok(!JSON.stringify(source.body).includes('MUST-NOT-PERSIST'));

  await panel.getByRole('button', { name: '닫기' }).click();
  await panel.waitFor({ state: 'detached' });
}

async function openPostmanImport(extensionPage, targetPage) {
  await clickSidepanelButton(
    extensionPage,
    targetPage,
    'Open source import menu',
    /소스 가져오기/,
  );
  await extensionPage.getByRole('button', { name: /Postman Collection/ }).click();
  await extensionPage.getByTestId('postman-import-panel').waitFor();
}

async function verifyPostmanImportUi(
  extensionPage,
  targetPage,
  fixtureUrl,
  collectionCreateRequests,
  sourcePreviewRequests,
  sourceAddRequests,
) {
  await openPostmanImport(extensionPage, targetPage);
  const editor = extensionPage.getByTestId('postman-import-panel');
  const collection = {
    info: {
      name: 'Postman Runtime',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: 'postman-runtime-token-must-not-persist' }],
    },
    event: [{
      listen: 'prerequest',
      script: { exec: ['console.log("runtime-secret")'] },
    }],
    item: [{
      name: 'Customers',
      item: [{
        name: 'Get customer',
        request: {
          method: 'GET',
          url: {
            raw: '{{baseUrl}}/customers/:customerId?expand=orders&token=query-secret',
            query: [
              { key: 'expand', value: 'orders' },
              { key: 'token', value: 'query-secret' },
            ],
            variable: [{ key: 'customerId', value: '123456789012' }],
          },
          header: [
            { key: 'Authorization', value: 'Bearer header-secret' },
            { key: 'X-Tenant', value: 'tenant-secret' },
          ],
        },
        response: [{
          code: 200,
          status: 'OK',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: JSON.stringify({
            customerId: '123456789012',
            email: 'runtime@example.com',
            accessToken: 'response-secret',
          }),
        }],
      }],
    }],
  };

  await editor.getByTestId('postman-file-input').setInputFiles({
    name: 'postman-runtime.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(collection)),
  });
  await editor.getByText(/URL host 변수를 해석할 수 없습니다:/).waitFor();
  await editor.getByTestId('postman-base-url-input').fill(
    `${new URL(fixtureUrl).origin}/api`,
  );
  await editor.getByRole('button', { name: '다시 분석' }).click();

  const panel = extensionPage.getByTestId('openapi-import-panel');
  await panel.waitFor();
  await panel.getByText(/Postman v2\.1/).waitFor();
  await panel.getByText(/scripts_not_executed/).waitFor();
  const previewStart = sourcePreviewRequests.length;
  await panel.getByRole('button', { name: '미리보기' }).click();
  await panel.getByText(/준비도 95/).waitFor();

  const preview = await waitForItem(
    sourcePreviewRequests,
    (entry) => (
      entry.body?.spec?.info?.['x-pathfinder-import']?.kind === 'postman_collection'
    ),
    'Postman Collection preview request',
  );
  assert.equal(sourcePreviewRequests.length, previewStart + 1);
  const operation = preview.body.spec.paths['/api/customers/{customerId}'].get;
  assert.equal(operation.parameters.some((parameter) => (
    parameter.name === 'expand' && parameter.in === 'query'
  )), true);
  assert.equal(operation.parameters.some((parameter) => parameter.name === 'token'), false);
  assert.equal(operation.parameters.some((parameter) => (
    parameter.name === 'X-Tenant' && parameter.in === 'header'
  )), true);
  assert.equal(
    operation.responses['200'].content['application/json'].schema
      .properties.email.type,
    'string',
  );
  assert.deepEqual(operation.security, [{ postman_bearer: [] }]);
  assert.equal(operation['x-pathfinder-source'].sample_values_persisted, false);
  assert.equal(operation['x-pathfinder-source'].scripts_executed, false);

  const serializedPreview = JSON.stringify(preview.body);
  for (const secret of [
    'postman-runtime-token-must-not-persist',
    'runtime-secret',
    'header-secret',
    'tenant-secret',
    'query-secret',
    'runtime@example.com',
    'response-secret',
  ]) {
    assert.ok(!serializedPreview.includes(secret), `Postman preview leaked ${secret}`);
  }

  await panel.locator('input[placeholder="collection-id"]').fill('postman-runtime');
  await panel.getByRole('button', { name: 'Collection에 등록' }).click();
  await panel.getByText(/Collection 등록 완료: postman-runtime/).waitFor();
  await waitForItem(
    collectionCreateRequests,
    (entry) => entry.body?.collection_id === 'postman-runtime',
    'Postman Collection create request',
  );
  const source = await waitForItem(
    sourceAddRequests,
    (entry) => entry.collectionId === 'postman-runtime',
    'Postman source add request',
  );
  assert.equal(
    source.body.spec.paths['/api/customers/{customerId}'].get
      .operationId,
    operation.operationId,
  );
  assert.ok(!JSON.stringify(source.body).includes('response-secret'));
  await panel.getByRole('button', { name: '닫기' }).click();
  await panel.waitFor({ state: 'detached' });
}

async function verifyMcpCollectionSourceUi(
  extensionPage,
  targetPage,
  mcpSessionRequests,
  mcpSourcePreviewRequests,
  mcpSourceAddRequests,
) {
  const sessionStart = mcpSessionRequests.length;
  await clickSidepanelButton(
    extensionPage,
    targetPage,
    'MCP source menu',
    /메뉴 열기/,
  );
  await extensionPage.getByRole('dialog', { name: '사이드 메뉴' }).waitFor();
  await extensionPage.getByRole('button', { name: /MCP 도구 연결/ }).click();

  const panel = extensionPage.getByTestId('mcp-collection-source');
  await panel.waitFor();
  await waitForItem(
    mcpSessionRequests,
    (_entry, index) => index >= sessionStart,
    'MCP Station session list',
  );
  assert.equal(
    mcpSessionRequests.at(-1)?.headers.authorization,
    'Bearer verify-token',
  );
  await panel.getByText('Customer Relationship Management').waitFor();
  assert.equal(
    await panel.getByText('Stopped session').count(),
    0,
    'stopped MCP sessions must not be selectable',
  );

  await panel.getByRole('checkbox').check();
  const previewStart = mcpSourcePreviewRequests.length;
  await panel.getByRole('button', { name: '미리보기' }).click();
  await panel.getByText('사용 가능').waitFor();
  await waitForItem(
    mcpSourcePreviewRequests,
    (_entry, index) => index >= previewStart,
    'MCP source preview',
  );
  const preview = mcpSourcePreviewRequests.at(-1);
  assert.equal(preview.collectionId, 'fixture-existing');
  assert.equal(preview.headers.authorization, 'Bearer verify-token');
  assert.deepEqual(preview.body.session_ids, ['session-customer-crm']);
  assert.deepEqual(preview.body.required_capabilities, ['input_schema']);
  assert.equal(preview.body.label, 'mcp-station');

  const addStart = mcpSourceAddRequests.length;
  await panel.getByRole('button', { name: '등록 / 갱신' }).click();
  await panel.getByText('128개 MCP 도구를 등록했습니다.').waitFor();
  await waitForItem(
    mcpSourceAddRequests,
    (_entry, index) => index >= addStart,
    'MCP source add',
  );
  const added = mcpSourceAddRequests.at(-1);
  assert.equal(added.collectionId, 'fixture-existing');
  assert.equal(added.headers.authorization, 'Bearer verify-token');
  assert.deepEqual(added.body.session_ids, ['session-customer-crm']);
  assert.equal(
    await panel.getByRole('button', { name: '등록 / 갱신' }).isDisabled(),
    true,
    'successful registration must require another preview before retry',
  );
  await panel.getByRole('button', { name: '채팅으로 돌아가기' }).click();
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

async function verifyGraphQLImportUi(
  extensionPage,
  targetPage,
  collectionCreateRequests,
  sourcePreviewRequests,
  sourceAddRequests,
  collectionDetailMode,
) {
  await openGraphQLImport(extensionPage, targetPage);
  const sourcePanel = extensionPage.getByTestId('graphql-import-panel');
  const endpoint = 'https://graphql.customer.test/v1/graphql';
  await sourcePanel.getByTestId('graphql-endpoint-input').fill(endpoint);
  await sourcePanel.getByTestId('graphql-file-input').setInputFiles({
    name: 'graphql-introspection.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      data: {
        __schema: {
          queryType: { name: 'Query' },
          mutationType: { name: 'Mutation' },
          subscriptionType: { name: 'Subscription' },
          types: [
            {
              kind: 'OBJECT',
              name: 'Query',
              fields: [
                { name: 'order', args: [], type: { kind: 'OBJECT', name: 'Order' } },
                { name: 'orders', args: [], type: { kind: 'LIST', ofType: { name: 'Order' } } },
              ],
            },
            {
              kind: 'OBJECT',
              name: 'Mutation',
              fields: [{
                name: 'createOrder',
                args: [{ name: 'input', type: { kind: 'INPUT_OBJECT', name: 'OrderInput' } }],
                type: { kind: 'OBJECT', name: 'Order' },
              }],
            },
            {
              kind: 'OBJECT',
              name: 'Subscription',
              fields: [{ name: 'orderUpdated', args: [] }],
            },
            { kind: 'OBJECT', name: 'Order', fields: [{ name: 'id', args: [] }] },
            {
              kind: 'INPUT_OBJECT',
              name: 'OrderInput',
              inputFields: [{ name: 'sku', type: { kind: 'SCALAR', name: 'String' } }],
            },
          ],
        },
      },
      errors: [{
        message: 'Bearer graphql-runtime-secret',
        extensions: {
          token: 'graphql-token-must-not-persist',
          email: 'customer@example.com',
        },
      }],
    })),
  });

  const panel = extensionPage.getByTestId('openapi-import-panel');
  await panel.getByText('GraphQL Introspection 등록').waitFor();
  await panel.getByText(/query 2개 · mutation 1개/).waitFor();
  await panel.getByText(/subscription은 streaming adapter가 없어/).waitFor();

  await panel.getByRole('button', { name: '미리보기' }).click();
  await panel.getByText(/adapter graphql-introspection/).waitFor();
  const preview = await waitForItem(
    sourcePreviewRequests,
    (entry) => entry.body?.format_hint === 'graphql-introspection',
    'GraphQL introspection preview request',
  );
  assert.equal(preview.body.endpoint_url, endpoint);
  assert.deepEqual(
    preview.body.required_capabilities,
    ['input_schema', 'output_schema'],
  );
  assert.equal(preview.body.spec?.data?.__schema?.queryType?.name, 'Query');
  assert.equal(preview.body.spec?.errors?.length, 1);
  const previewPayload = JSON.stringify(preview.body);
  assert.ok(!previewPayload.includes('graphql-runtime-secret'));
  assert.ok(!previewPayload.includes('graphql-token-must-not-persist'));
  assert.ok(!previewPayload.includes('customer@example.com'));

  await panel.getByRole('button', { name: 'Collection에 등록' }).click();
  await panel.getByText(/Collection 등록 완료: graphql-customer-test/).waitFor();
  const buildStatus = panel.getByTestId('collection-build-status');
  await buildStatus.getByText('graph build 완료').waitFor();
  await buildStatus.getByText(/graph-tool-call 0\.35\.0 · graph v2/).waitFor();
  await buildStatus.getByText(/action 98% · resource 91% · module 100%/).waitFor();
  collectionDetailMode.failNext = true;
  await buildStatus.getByRole('button', { name: '새로고침' }).click();
  await buildStatus.getByText(
    /현재 XGEN backend가 Collection build 상태 조회 기능을 지원하지 않습니다/,
  ).waitFor();
  const created = await waitForItem(
    collectionCreateRequests,
    (entry) => entry.body?.collection_id === 'graphql-customer-test',
    'GraphQL Collection create request',
  );
  assert.equal(created.body.name, 'graphql.customer.test GraphQL');
  assert.equal(created.body.base_url, 'https://graphql.customer.test');
  assert.deepEqual(created.body.domain_patterns, ['graphql.customer.test']);
  assert.deepEqual(created.body.tags, ['pathfinder', 'graphql']);

  const source = await waitForItem(
    sourceAddRequests,
    (entry) => entry.collectionId === 'graphql-customer-test',
    'GraphQL introspection source add request',
  );
  assert.equal(source.body.format_hint, 'graphql-introspection');
  assert.equal(source.body.endpoint_url, endpoint);
  assert.equal(source.body.auto_enrich, false);
  assert.ok(!JSON.stringify(source.body).includes('graphql-runtime-secret'));
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
  if (stop.resultId) {
    await sendExtensionMessage(extensionPage, {
      type: 'ACK_CAPTURE_RESULT',
      resultId: stop.resultId,
    });
  }

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
  const buildStatus = extensionPage.getByTestId('collection-build-status');
  await buildStatus.getByText('graph build 완료').waitFor();
  await buildStatus.getByText('인증 연결됨 (127_local_profile)').waitFor();

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

async function verifyLegacyCaptureCommandPrivacy(
  extensionPage,
  targetPage,
  commandResults,
  legacyToolSaveRequests,
  fixtureUrl,
) {
  await targetPage.waitForTimeout(200);
  const tabId = await findTabIdByUrl(extensionPage, '/workspace/details$');

  const listRequestId = `verify-value-free-capture-list-${Date.now()}`;
  const relayed = await sendExtensionMessage(extensionPage, {
    type: 'RELAY_COMMAND',
    tabId,
    event: {
      type: 'page_command',
      requestId: listRequestId,
      action: 'get_captured_apis',
      params: {},
    },
  });
  assert.equal(relayed?.ok, true, `capture list relay failed: ${JSON.stringify(relayed)}`);
  const callback = await waitForCommandResult(
    commandResults,
    listRequestId,
    'Value-free capture list',
  );
  const summaries = callback.body?.result?.apis || [];
  const loginSummary = summaries.find((entry) => (
    entry.method === 'POST' && entry.url?.endsWith('/api/login')
  ));
  assert.ok(loginSummary, `value-free login summary missing: ${JSON.stringify(summaries)}`);
  assert.ok(loginSummary.request?.field_paths?.includes('password'));
  assert.ok(loginSummary.response?.field_paths?.includes('data.access_token'));
  assert.equal(loginSummary.sample_values_persisted, false);
  assert.equal('request_body_preview' in loginSummary, false);
  assert.equal('response_body_preview' in loginSummary, false);

  const listText = JSON.stringify(callback.body);
  for (const secret of [
    'runtime-login-request-secret',
    'runtime-login-concurrent-secret',
    'runtime-auth-response-secret',
  ]) {
    assert.ok(!listText.includes(secret), `capture command result leaked ${secret}`);
  }

  const legacyRequestId = `verify-value-free-legacy-save-${Date.now()}`;
  const legacyRelay = await sendExtensionMessage(extensionPage, {
    type: 'RELAY_COMMAND',
    tabId,
    event: {
      type: 'page_command',
      requestId: legacyRequestId,
      action: 'register_tool',
      params: {
        function_name: 'runtime_login_tool',
        api_url: `${fixtureUrl}api/login?accessToken=runtime-query-secret`,
        api_method: 'POST',
        auth_profile_id: '127_local_profile',
        api_header: {
          Authorization: 'Bearer runtime-header-secret',
          'Content-Type': 'application/json',
        },
        static_body: {
          password: 'runtime-static-secret',
        },
        metadata: {
          email: 'runtime-metadata@example.com',
        },
      },
    },
  });
  assert.equal(legacyRelay?.ok, true, `legacy Tool relay failed: ${JSON.stringify(legacyRelay)}`);
  const legacyResult = await waitForCommandResult(
    commandResults,
    legacyRequestId,
    'Value-free legacy Tool registration',
  );
  assert.equal(
    legacyResult.body?.success,
    true,
    `legacy Tool registration failed: ${JSON.stringify(legacyResult)}`,
  );
  const saved = await waitForItem(
    legacyToolSaveRequests,
    (entry) => entry.body?.function_name === 'runtime_login_tool',
    'Value-free legacy Tool save',
  );
  assert.equal(saved.body.content.api_url, `${fixtureUrl}api/login`);
  assert.deepEqual(saved.body.content.static_body, {});
  assert.deepEqual(saved.body.content.api_header, { 'Content-Type': 'application/json' });
  assert.equal(saved.body.content.metadata.sample_values_persisted, false);
  assert.ok(saved.body.content.api_body?.properties?.username);
  assert.ok(saved.body.content.api_body?.properties?.password);

  const savedText = JSON.stringify(saved.body);
  for (const secret of [
    'runtime-login-request-secret',
    'runtime-login-concurrent-secret',
    'runtime-auth-response-secret',
    'runtime-query-secret',
    'runtime-header-secret',
    'runtime-static-secret',
    'runtime-metadata@example.com',
  ]) {
    assert.ok(!savedText.includes(secret), `legacy Tool save leaked ${secret}`);
  }
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
    legacyToolSaveRequests,
    mergeRequests,
    collectionCreateRequests,
    sourcePreviewRequests,
    sourceAddRequests,
    collectionDeleteRequests,
    capabilityRequests,
    registrationMode,
    sourceAddMode,
    collectionDetailMode,
    authProfileMutations,
    workerApiRequests,
    mcpSessionRequests,
    mcpSourcePreviewRequests,
    mcpSourceAddRequests,
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
        'http://localhost/*',
        'https://dev-xgen.x2bee.com/*',
      ],
    });

    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    attachRuntimeLogging(context, runtimeLogs);
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });

    const relaunchedExtensionId = await resolveExtensionId(context, userDataDir);
    assert.equal(relaunchedExtensionId, extensionId, 'extension id should remain stable after restart');
    let extensionPage = await openExtensionPage(context, extensionId);

    await extensionPage.bringToFront();
    if (process.env.PATHFINDER_RUNTIME_EXPECTED_FAILURE === '1') {
      const probePayload = process.env.PATHFINDER_RUNTIME_FAILURE_PAYLOAD
        || 'synthetic runtime artifact probe';
      runtimeLogs.push(`[artifact-probe] ${probePayload}`);
      throw new Error(`Expected artifact probe failure: ${probePayload}`);
    }
    const unsupportedStart = await sendExtensionMessage(extensionPage, { type: 'START_CAPTURE_SESSION' });
    assert.equal(unsupportedStart?.ok, false, `START_CAPTURE_SESSION should reject extension pages: ${JSON.stringify(unsupportedStart)}`);
    assert.match(unsupportedStart?.error || '', /http\/https|API 캡처|No active tab/);

    await verifyDevXgenOriginDetection(extensionPage, context);

    const targetPage = await context.newPage();
    await targetPage.goto(url);
    await bootstrapGrantedContentScript(extensionPage, targetPage, url);
    await extensionPage.close();
    await verifyCaptureSessionLifecycle(context, extensionId, targetPage);
    extensionPage = await openExtensionPage(context, extensionId);
    await pinSidepanelToTarget(extensionPage, targetPage);
    await verifyCookiePermissionUi(extensionPage);
    const distractorPage = await context.newPage();
    await distractorPage.goto(`${url}distractor`);
    await verifyPageAgent(extensionPage, targetPage);
    await verifyStoredServerCookieAuth(extensionPage, context, targetPage, url);
    await verifyXgenCompatibilityUi(extensionPage);
    assert.ok(
      capabilityRequests.some(
        (entry) => entry.headers.authorization === 'Bearer cookie-token',
      ),
      'XGEN capability manifest should be requested with the active login token',
    );
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
    await verifyGraphQLImportUi(
      extensionPage,
      targetPage,
      collectionCreateRequests,
      sourcePreviewRequests,
      sourceAddRequests,
      collectionDetailMode,
    );
    await verifyManualToolContractUi(
      extensionPage,
      targetPage,
      url,
      collectionCreateRequests,
      sourcePreviewRequests,
      sourceAddRequests,
    );
    await verifyPostmanImportUi(
      extensionPage,
      targetPage,
      url,
      collectionCreateRequests,
      sourcePreviewRequests,
      sourceAddRequests,
    );
    await verifyMcpCollectionSourceUi(
      extensionPage,
      targetPage,
      mcpSessionRequests,
      mcpSourcePreviewRequests,
      mcpSourceAddRequests,
    );
    await wait(2_200);

    await targetPage.evaluate(async () => {
      await navigator.serviceWorker.register('/fixture-sw.js');
      await navigator.serviceWorker.ready;
    });
    await targetPage.reload();
    await targetPage.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

    const firstResult = await runCaptureSessionViaSidepanel(extensionPage, targetPage, async () => {
      const extensionSpoof = await sendExtensionMessage(extensionPage, {
        type: 'API_CAPTURE_REJECTED',
        reason: 'invalid_payload',
      });
      assert.equal(
        extensionSpoof?.ok,
        false,
        'extension pages without a sender tab must not mutate capture diagnostics',
      );
      await targetPage.evaluate(async () => {
        const forgedBase = {
          timestamp: Date.now(),
          method: 'GET',
          requestHeaders: {},
          requestBody: null,
          responseStatus: 200,
          responseHeaders: { 'content-type': 'application/json' },
          responseBody: '{}',
          contentType: 'application/json',
          duration: 1,
        };
        window.dispatchEvent(new CustomEvent('xgen:api-captured', { detail: null }));
        window.dispatchEvent(new CustomEvent('xgen:api-captured', {
          detail: {
            ...forgedBase,
            id: 'forged-oversized',
            url: '/api/forged/oversized',
            responseBody: 'x'.repeat((100 * 1024) + 1),
          },
        }));
        window.dispatchEvent(new CustomEvent('xgen:api-captured', {
          detail: {
            ...forgedBase,
            id: 'forged-unsupported-url',
            url: 'javascript:alert(1)',
          },
        }));

        const logins = await Promise.all([
          'runtime-login-request-secret',
          'runtime-login-concurrent-secret',
        ].map(async (password) => {
          const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              username: 'runtime-user',
              password,
            }),
          });
          if (!response.ok) {
            throw new Error(`fixture login failed: ${response.status}`);
          }
          return response.json();
        }));
        if (logins.length !== 2) throw new Error('fixture concurrent login failed');

        const search = await fetch('/api/goods/v1/search?keyword=jeju');
        if (!search.ok) throw new Error(`fixture fetch failed: ${search.status}`);
        await search.json();

        const relative = await fetch('api/relative/v1/list');
        if (!relative.ok) throw new Error(`fixture relative fetch failed: ${relative.status}`);
        await relative.json();

        const large = await fetch('/api/large/v1/report');
        if (!large.ok) throw new Error(`fixture large fetch failed: ${large.status}`);
        await large.text();

        const binary = await fetch('/api/binary/v1/export');
        if (!binary.ok) throw new Error(`fixture binary fetch failed: ${binary.status}`);
        await binary.arrayBuffer();

        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', '/api/binary/v1/export');
          xhr.responseType = 'arraybuffer';
          xhr.onload = () => resolve(undefined);
          xhr.onerror = () => reject(new Error('fixture binary xhr failed'));
          xhr.send();
        });

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
      const apiFrame = targetPage.frames().find((frame) =>
        frame.url().startsWith('http://localhost:')
        && frame.url().endsWith('/iframe-fixture'));
      assert.ok(apiFrame, 'approved cross-origin API iframe should be available');
      await apiFrame.evaluate(async (apiUrl) => {
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`fixture iframe fetch failed: ${response.status}`);
        await response.json();
      }, `${url}api/iframe/v1/detail?itemId=IFRAME-10001`);
      await targetPage.evaluate(() => {
        navigator.serviceWorker.controller?.postMessage('fetch-worker-api');
      });
      await targetPage.evaluate((blockedFrameUrl) => {
        const frame = document.createElement('iframe');
        frame.id = 'blocked-api-frame';
        frame.title = 'Blocked API frame fixture';
        frame.src = blockedFrameUrl;
        document.body.append(frame);
      }, `http://127.0.0.2:${new URL(url).port}/iframe-blocked`);
      await targetPage.waitForTimeout(300);
      await waitForItem(
        workerApiRequests,
        (entry) => entry.url === '/api/worker/v1/background',
        'Service Worker fixture request',
      );
      await verifyLegacyCaptureCommandPrivacy(
        extensionPage,
        targetPage,
        commandResults,
        legacyToolSaveRequests,
        url,
      );
    }, 'fetch+xhr capture', distractorPage);
    const firstApis = firstResult.apis;
    const createdAuthProfile = await waitForItem(
      authProfileMutations,
      (entry) => entry.method === 'POST' && entry.serviceId === '127_0_0_1',
      'Pathfinder managed auth profile create',
    );
    assert.equal(createdAuthProfile.managed, true);
    assert.equal(createdAuthProfile.hasLoginConfig, true);
    assert.ok(createdAuthProfile.extractionRuleCount >= 1);
    await waitForItem(
      authProfileMutations,
      (entry) => entry.method === 'PUT' && entry.serviceId === '127_0_0_1',
      'serialized concurrent auth profile refresh',
    );
    await verifySessionResultRegistration(extensionPage, targetPage, registrationRequests);
    await verifyCaptureObservationStopped(
      extensionPage,
      targetPage,
      commandResults,
    );

    const searchApi = findApi(firstApis, 'GET', '/api/goods/v1/search?keyword=jeju');
    assert.ok(
      searchApi,
      `captured search API not found in ${JSON.stringify(captureSummary(firstApis))}`,
    );
    assert.equal(searchApi.responseStatus, 200);
    assert.match(searchApi.responseBody || '', /987654/);
    assert.equal(searchApi.provenance?.source, 'page_hook');
    assert.equal(searchApi.provenance?.trust, 'untrusted_page_event');
    assert.equal(searchApi.provenance?.transport, 'fetch');
    const relativeApi = findApi(firstApis, 'GET', '/fixture-base/api/relative/v1/list');
    assert.ok(
      relativeApi,
      `document.baseURI-relative API not captured: ${JSON.stringify(captureSummary(firstApis))}`,
    );
    const largeApi = findApi(firstApis, 'GET', '/api/large/v1/report');
    assert.ok(largeApi, 'large API response should retain endpoint-level evidence');
    assert.equal(largeApi.responseBody, null);
    assert.equal(largeApi.responseMetadata?.bodyCaptured, false);
    assert.equal(largeApi.responseMetadata?.bodyTruncated, true);
    assert.ok(
      largeApi.responseMetadata?.limitations?.includes('response_content_length_exceeds_limit'),
    );
    const binaryApi = findApi(firstApis, 'GET', '/api/binary/v1/export');
    assert.ok(binaryApi, 'binary API response should retain endpoint-level evidence');
    assert.equal(binaryApi.responseBody, null);
    assert.equal(binaryApi.responseMetadata?.bodyCaptured, false);
    assert.ok(
      binaryApi.responseMetadata?.limitations?.includes(
        'response_binary_or_streaming_body_not_captured',
      ),
    );
    const binaryXhrApi = firstApis.find((api) => (
      api.method === 'GET'
      && api.url.includes('/api/binary/v1/export')
      && api.provenance?.transport === 'xhr'
    ));
    assert.ok(binaryXhrApi, 'binary XHR should retain endpoint-level evidence');
    assert.equal(binaryXhrApi.responseBody, null);
    assert.equal(binaryXhrApi.responseMetadata?.bodyCaptured, false);
    assert.ok(
      binaryXhrApi.responseMetadata?.limitations?.includes(
        'response_binary_or_streaming_body_not_captured',
      ),
    );
    assert.ok(
      !firstApis.some((api) => String(api.id).startsWith('forged-')),
      'page-forged capture events must not reach the accepted capture set',
    );
    const memberApi = findApi(firstApis, 'POST', '/api/member/v1/me');
    assert.ok(
      memberApi,
      `captured XHR API not found in ${JSON.stringify(captureSummary(firstApis))}`,
    );
    assert.match(memberApi.requestBody || '', /includeGrade/);
    const graphqlApis = firstApis.filter((api) => api.method === 'POST' && api.url.endsWith('/graphql'));
    assert.equal(
      graphqlApis.length,
      2,
      `GraphQL operations should be captured: ${JSON.stringify(captureSummary(firstApis))}`,
    );
    assert.deepEqual(
      new Set(graphqlApis.map((api) => api.requestMetadata?.graphql?.operationName)),
      new Set(['GetGoodsList', 'GetGoodsDetail']),
    );
    const uploadApi = findApi(firstApis, 'POST', '/api/documents/upload');
    assert.ok(
      uploadApi,
      `multipart upload not captured: ${JSON.stringify(captureSummary(firstApis))}`,
    );
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
    const iframeApi = findApi(firstApis, 'GET', '/api/iframe/v1/detail');
    assert.ok(
      iframeApi,
      `approved cross-origin iframe API not captured: ${JSON.stringify(captureSummary(firstApis))}`,
    );
    assert.equal(iframeApi.captureContext?.kind, 'subframe');
    assert.ok(
      !firstApis.some((api) => api.url.includes('/api/worker/v1/background')),
      'Service Worker fetch must not be mislabeled as an observed page request',
    );
    assert.ok(firstResult.captureCoverage, 'capture coverage should be returned');
    assert.ok(firstResult.captureCoverage.instrumentedFrameCount >= 2);
    assert.ok(firstResult.captureCoverage.blockedFrameCount >= 1);
    assert.ok(
      firstResult.captureCoverage.blockedOrigins.some(
        (origin) => origin.startsWith('http://127.0.0.2:'),
      ),
      `blocked iframe origin should be reported: ${JSON.stringify(firstResult.captureCoverage)}`,
    );
    assert.ok(firstResult.captureCoverage.observedSubframeRequestCount >= 1);
    assert.equal(firstResult.captureCoverage.serviceWorkerControlled, true);
    assert.ok(
      firstResult.captureCoverage.issues.some(
        (issue) => issue.code === 'service_worker_fetch_not_observable',
      ),
      'Service Worker limitation should be explicit',
    );
    assert.ok(
      firstResult.captureCoverage.issues.some(
        (issue) => issue.code === 'capture_payload_invalid' && issue.count >= 2,
      ),
      `invalid or unsupported page events should be diagnosed: ${JSON.stringify(firstResult.captureCoverage)}`,
    );
    assert.ok(
      firstResult.captureCoverage.issues.some(
        (issue) => issue.code === 'capture_payload_oversized' && issue.count >= 1,
      ),
      `oversized page events should be diagnosed: ${JSON.stringify(firstResult.captureCoverage)}`,
    );
    await extensionPage.getByText(/iframe 요청 1건/).waitFor();
    await extensionPage.getByText('Service Worker 제어 감지').waitFor();
    await targetPage.evaluate(() => {
      document.querySelector('#blocked-api-frame')?.remove();
    });

    const authRefreshStart = authProfileMutations.length;
    const mergeResult = await runCaptureSessionViaSidepanel(extensionPage, targetPage, async () => {
      await targetPage.evaluate(async () => {
        const login = await fetch('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: 'runtime-user',
            password: 'runtime-login-refresh-secret',
          }),
        });
        if (!login.ok) throw new Error(`fixture login refresh failed: ${login.status}`);
        await login.json();

        const detail = await fetch('/api/goods/v1/detail?goodsNo=987654&siteNo=1000');
        if (!detail.ok) throw new Error(`fixture detail fetch failed: ${detail.status}`);
        await detail.json();
      });
    }, 'registration conflict merge capture', distractorPage);
    const mergeApis = mergeResult.apis;
    const updatedAuthProfile = await waitForItem(
      authProfileMutations,
      (entry, index) => index >= authRefreshStart
        && entry.method === 'PUT'
        && entry.serviceId === '127_0_0_1',
      'Pathfinder managed auth profile refresh',
    );
    assert.equal(updatedAuthProfile.managed, true);
    assert.equal(updatedAuthProfile.hasLoginConfig, true);
    assert.ok(
      !authProfileMutations.some(
        (entry) => entry.serviceId === '127_local_profile',
      ),
      'Pathfinder must not overwrite an operator-managed linked auth profile',
    );
    await verifySessionResultMergeConflict(
      extensionPage,
      targetPage,
      registrationMode,
      registrationRequests,
      mergeRequests,
    );
    const mergeDetailApi = findApi(mergeApis, 'GET', '/api/goods/v1/detail?goodsNo=987654&siteNo=1000');
    assert.ok(
      mergeDetailApi,
      `captured merge detail API not found in ${JSON.stringify(captureSummary(mergeApis))}`,
    );

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
    assert.ok(
      detailApi,
      `captured post-navigation API not found in ${JSON.stringify(captureSummary(secondApis))}`,
    );
    assert.equal(
      secondApis.length,
      1,
      `navigation session should reset old captures: ${JSON.stringify(captureSummary(secondApis))}`,
    );

    const extraStop = await sendExtensionMessage(extensionPage, { type: 'STOP_CAPTURE_SESSION' });
    assert.equal(extraStop?.ok, false, `STOP_CAPTURE_SESSION without active session should fail: ${JSON.stringify(extraStop)}`);
    assert.match(extraStop?.error || '', /No active session/);
    await verifyOptionalPermissionLifecycle(extensionPage, context, targetPage, url);

    const runtimeLogText = runtimeLogs.join('\n');
    for (const [index, secret] of [
      'runtime-login-request-secret',
      'runtime-login-concurrent-secret',
      'runtime-login-refresh-secret',
      'runtime-auth-response-secret',
    ].entries()) {
      assert.ok(
        !runtimeLogText.includes(secret),
        `runtime log leaked synthetic auth secret #${index + 1}`,
      );
    }

    console.log([
      `PathFinder runtime verification passed: extension loaded (${extensionId})`,
      'PageAgent context and commands verified',
      'stored server cookie auth verified',
      'page_command relay callback verified',
      'sidepanel chat relay verified',
      'OpenAPI URL/YAML import and rollback verified',
      'GraphQL introspection preview and registration verified',
      'manual tool contract preview and registration verified',
      'privacy-safe Postman Collection import verified',
      'MCP Station source preview and registration verified',
      'auth profile explicit link, managed create, and refresh verified',
      'approved iframe capture, blocked iframe coverage, and worker limitation verified',
      'capture result registration verified',
      'value-free capture summary and legacy Tool registration verified',
      'capture result merge conflict verified',
      'privacy-safe HAR import verified',
      'capture payload memory release verified',
      'serialized capture lifecycle and MV3 restart recovery verified',
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
  const errorText = err instanceof Error ? err.stack || err.message : String(err);
  console.error(scrubRuntimeLog(errorText));
  process.exit(1);
});
