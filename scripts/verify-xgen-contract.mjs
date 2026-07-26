#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repoRoot, 'contracts/xgen-api-contract.json');
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const validMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const identities = new Set();

assert.equal(contract.version, 2, 'unsupported XGEN API contract version');
assert.ok(Array.isArray(contract.endpoints) && contract.endpoints.length > 0, 'endpoint contract is empty');

async function assertNeedle(endpoint, role, reference) {
  if (!reference) return;
  const filePath = path.join(repoRoot, reference.file);
  const content = await readFile(filePath, 'utf8');
  assert.ok(
    content.includes(reference.needle),
    `${endpoint.id}: ${role} contract missing in ${reference.file}: ${reference.needle}`,
  );
}

for (const endpoint of contract.endpoints) {
  assert.match(endpoint.id, /^[a-z][a-z0-9_]+$/, `invalid endpoint id: ${endpoint.id}`);
  assert.ok(validMethods.has(endpoint.method), `${endpoint.id}: invalid method ${endpoint.method}`);
  assert.ok(endpoint.path.startsWith('/api/'), `${endpoint.id}: path must start with /api/`);
  const identity = `${endpoint.method} ${endpoint.path}`;
  assert.ok(!identities.has(identity), `duplicate endpoint contract: ${identity}`);
  identities.add(identity);
  await assertNeedle(endpoint, 'client', endpoint.client);
  await assertNeedle(endpoint, 'runtime mock', endpoint.runtimeMock);
}

console.log(
  `XGEN API contract verification passed: ${contract.endpoints.length} endpoint(s), `
  + `${contract.endpoints.filter((endpoint) => endpoint.runtimeMock).length} runtime mock(s).`,
);
