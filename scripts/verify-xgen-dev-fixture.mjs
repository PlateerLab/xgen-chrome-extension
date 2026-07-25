#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureToken = 'fixture-token-must-not-be-printed';
const requests = [];
let deletedCollectionId = null;

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const authorization = req.headers.authorization || '';
  requests.push({ method: req.method, path: url.pathname, authorization });

  if (url.pathname !== '/api/health') {
    assert.equal(authorization, `Bearer ${fixtureToken}`);
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    json(res, 200, { status: 'ok' });
    return;
  }
  if (
    req.method === 'GET'
    && [
      '/api/ai-chat/providers',
      '/api/session-station/v1/auth-profiles',
      '/api/mcp/sessions',
    ].includes(url.pathname)
  ) {
    json(res, 200, []);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/tools/api-collections') {
    json(res, 200, []);
    return;
  }
  if (req.method === 'GET' && ['/openapi.json', '/api/openapi.json'].includes(url.pathname)) {
    json(res, 404, { detail: 'not exposed in fixture' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/tools/api-collections/preview') {
    const body = await readJson(req);
    const adapter = body.format_hint || 'openapi';
    json(res, 200, {
      incoming_tool_count: 1,
      conflicts: [],
      edges_before: 0,
      edges_after: 0,
      edges_added: 0,
      existing_total: 0,
      spec_hash: `${adapter}-fixture`,
      ingest_stats: { inserted: 1 },
      ingest_result: {
        adapter,
        ready: true,
        issues: [],
        capabilities: {
          input_schema: true,
          output_schema: true,
        },
      },
      ingest_supported: true,
      readiness_report: {
        summary: {
          readiness_score: 100,
          status: 'ready',
          tool_count: 1,
        },
        issues: [],
      },
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/tools/api-collections') {
    const body = await readJson(req);
    json(res, 201, {
      collection_id: body.collection_id,
      name: body.name,
      tool_count: 0,
      source_count: 0,
    });
    return;
  }

  const collectionMatch = url.pathname.match(/^\/api\/tools\/api-collections\/([^/]+)$/);
  const sourceMatch = url.pathname.match(
    /^\/api\/tools\/api-collections\/([^/]+)\/sources$/,
  );
  const searchMatch = url.pathname.match(
    /^\/api\/tools\/api-collections\/([^/]+)\/test-search$/,
  );
  const planMatch = url.pathname.match(
    /^\/api\/tools\/api-collections\/([^/]+)\/synthesize-plan$/,
  );

  if (req.method === 'POST' && sourceMatch) {
    const body = await readJson(req);
    json(res, 201, {
      collection_id: decodeURIComponent(sourceMatch[1]),
      tool_count: 1,
      source_count: 1,
      ingest_result: { adapter: body.format_hint, ready: true },
    });
    return;
  }
  if (req.method === 'POST' && searchMatch) {
    json(res, 200, {
      results: [{
        name: 'pathfinder_t2_getPathfinderT2Health',
        score: 1,
        http: 'GET /api/health',
      }],
      subgraph_text: 'NODE pathfinder_t2_getPathfinderT2Health',
      intent: { dominant: 'read' },
      stats: { seeds: 1, visited_nodes: 1, visited_edges: 0 },
      graph_tool_call_version: 'fixture',
      collection_graph_version: 2,
    });
    return;
  }
  if (req.method === 'POST' && planMatch) {
    const body = await readJson(req);
    json(res, 200, {
      id: 'fixture-plan',
      target: body.target,
      steps: [{ id: 'step-1', tool: body.target, args: {} }],
      metadata: {},
    });
    return;
  }
  if (req.method === 'GET' && collectionMatch) {
    json(res, 200, {
      collection_id: decodeURIComponent(collectionMatch[1]),
      name: 'Pathfinder T2 Read-only Acceptance',
      tool_count: 1,
      edge_count: 0,
      source_count: 1,
      graph_tool_call_version: 'fixture',
      collection_graph_version: 2,
      readiness_summary: { status: 'ready', readiness_score: 100 },
      semantic_summary: {
        canonical_action_known_rate: 1,
        primary_resource_assigned_rate: 1,
        path_module_assigned_rate: 1,
      },
      edge_quality_summary: { total: 0 },
      sources: [{ label: 'pathfinder-t2-openapi' }],
    });
    return;
  }
  if (req.method === 'DELETE' && collectionMatch) {
    deletedCollectionId = decodeURIComponent(collectionMatch[1]);
    res.writeHead(204);
    res.end();
    return;
  }

  json(res, 404, { detail: 'fixture route not found' });
});

function runVerifier(origin) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/verify-xgen-dev.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATHFINDER_XGEN_URL: origin,
        PATHFINDER_XGEN_TOKEN: fixtureToken,
        PATHFINDER_XGEN_USER_ID: 'fixture-user',
        PATHFINDER_XGEN_ALLOW_ANONYMOUS: '0',
        PATHFINDER_XGEN_REQUIRE_OPENAPI: '0',
        PATHFINDER_XGEN_RUN_COLLECTION_FLOW: '1',
        PATHFINDER_XGEN_TEST_GRAPHQL: '1',
        PATHFINDER_XGEN_RUN_EXECUTE: '0',
        PATHFINDER_XGEN_KEEP_COLLECTION: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`dev verifier fixture failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { stdout, stderr } = await runVerifier(
    `http://127.0.0.1:${address.port}`,
  );
  assert.equal(stderr, '');
  assert.ok(!stdout.includes(fixtureToken), 'verifier output leaked its token');
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'passed');
  assert.equal(result.authenticated, true);
  assert.equal(result.collectionAcceptance.previews.openapi.adapter, 'openapi');
  assert.equal(
    result.collectionAcceptance.previews.graphql.adapter,
    'graphql-introspection',
  );
  assert.equal(result.collectionAcceptance.collection.toolCount, 1);
  assert.equal(result.collectionAcceptance.search.targetRank, 1);
  assert.equal(result.collectionAcceptance.plan.stepCount, 1);
  assert.equal(result.collectionAcceptance.execute, undefined);
  assert.equal(deletedCollectionId, result.collectionAcceptance.collectionId);
  assert.ok(
    requests.some((entry) => entry.path.endsWith('/test-search')),
    'search route was not exercised',
  );
  assert.ok(
    requests.some((entry) => entry.path.endsWith('/synthesize-plan')),
    'plan route was not exercised',
  );
  console.log(
    'XGEN dev verifier fixture passed: OpenAPI/GraphQL preview, Collection build, search, plan, cleanup.',
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
