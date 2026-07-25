#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  await readFile(path.join(repoRoot, 'contracts/xgen-api-contract.json'), 'utf8'),
);
const serverUrl = normalizeServerUrl(
  process.env.PATHFINDER_XGEN_URL || 'https://dev-xgen.x2bee.com',
);
const token = process.env.PATHFINDER_XGEN_TOKEN || '';
const userId = process.env.PATHFINDER_XGEN_USER_ID || '';
const allowAnonymous = process.env.PATHFINDER_XGEN_ALLOW_ANONYMOUS === '1';
const requireOpenapi = process.env.PATHFINDER_XGEN_REQUIRE_OPENAPI === '1';

function normalizeServerUrl(value) {
  const parsed = new URL(value);
  assert.ok(
    parsed.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(parsed.hostname),
    'PATHFINDER_XGEN_URL must use HTTPS except for localhost',
  );
  assert.equal(parsed.username, '', 'PATHFINDER_XGEN_URL must not contain credentials');
  assert.equal(parsed.password, '', 'PATHFINDER_XGEN_URL must not contain credentials');
  assert.equal(parsed.search, '', 'PATHFINDER_XGEN_URL must not contain a query');
  assert.equal(parsed.hash, '', 'PATHFINDER_XGEN_URL must not contain a fragment');
  return parsed.origin;
}

function requestHeaders() {
  return {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(userId ? { 'x-user-id': userId } : {}),
  };
}

function normalizePathTemplate(value) {
  return value.replace(/\{[^}]+\}/g, '{}');
}

async function probe(pathname, { required = true } = {}) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method: 'GET',
    headers: requestHeaders(),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const result = {
    path: pathname,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type') || '',
  };
  if (required) {
    assert.ok(response.ok, `${pathname}: expected 2xx, got ${response.status}`);
  }
  return { response, result };
}

if (!token && !allowAnonymous) {
  throw new Error(
    'PATHFINDER_XGEN_TOKEN is required. Set PATHFINDER_XGEN_ALLOW_ANONYMOUS=1 for public probes only.',
  );
}

const results = [];
results.push((await probe('/api/health')).result);

if (token) {
  for (const endpoint of contract.endpoints.filter((item) => item.devProbe)) {
    results.push((await probe(endpoint.path)).result);
  }
}

let openapi;
for (const candidate of ['/openapi.json', '/api/openapi.json']) {
  const { response, result } = await probe(candidate, { required: false });
  if (response.ok) {
    results.push(result);
    openapi = await response.json();
    break;
  }
}

if (openapi) {
  for (const endpoint of contract.endpoints) {
    const openapiPath = Object.keys(openapi.paths || {}).find(
      (candidate) => normalizePathTemplate(candidate) === normalizePathTemplate(endpoint.path),
    );
    const operation = openapiPath
      ? openapi.paths?.[openapiPath]?.[endpoint.method.toLowerCase()]
      : undefined;
    assert.ok(operation, `OpenAPI is missing ${endpoint.method} ${endpoint.path}`);
  }
} else if (requireOpenapi) {
  throw new Error('XGEN OpenAPI document was not available from /openapi.json or /api/openapi.json');
}

console.log(JSON.stringify({
  status: 'passed',
  serverOrigin: serverUrl,
  authenticated: Boolean(token),
  userIdHeaderPresent: Boolean(userId),
  openapiVerified: Boolean(openapi),
  probes: results,
}, null, 2));
