#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = path.resolve(
  process.env.PATHFINDER_ARTIFACT_DIR
    || path.join(repoRoot, 'artifacts/pathfinder-runtime'),
);
const forbiddenValues = [
  'artifact-probe-token',
  'owner@example.test',
  '010-1234-5678',
  '1234567890123456',
];

function runExpectedFailure() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/verify-runtime.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATHFINDER_ARTIFACT_DIR: artifactDir,
        PATHFINDER_RUNTIME_EXPECTED_FAILURE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, output }));
  });
}

await rm(artifactDir, { recursive: true, force: true });
const result = await runExpectedFailure();
assert.notEqual(result.code, 0, 'runtime artifact probe must fail intentionally');

const files = await readdir(artifactDir);
for (const required of ['runtime.log', 'runtime-summary.json', 'trace.zip']) {
  assert.ok(files.includes(required), `missing failure artifact: ${required}`);
}
assert.ok(
  files.some((name) => /^page-\d+\.png$/.test(name)),
  'failure artifact did not include a screenshot',
);

const runtimeLog = await readFile(path.join(artifactDir, 'runtime.log'), 'utf8');
const summary = await readFile(
  path.join(artifactDir, 'runtime-summary.json'),
  'utf8',
);
const textualArtifacts = `${runtimeLog}\n${summary}`;
for (const forbidden of forbiddenValues) {
  assert.ok(
    !textualArtifacts.includes(forbidden),
    `failure artifact leaked a synthetic secret or PII value: ${forbidden}`,
  );
  assert.ok(
    !result.output.includes(forbidden),
    `artifact probe process output leaked a synthetic value: ${forbidden}`,
  );
}
for (const marker of [
  '[REDACTED]',
  '[REDACTED:EMAIL]',
  '[REDACTED:PHONE]',
  '[REDACTED:LONG_NUMBER]',
]) {
  assert.ok(runtimeLog.includes(marker), `runtime log is missing ${marker}`);
}

console.log(
  `Pathfinder failure artifact probe passed: ${files.sort().join(', ')}`,
);

if (process.env.PATHFINDER_ARTIFACT_PROBE_FAIL_JOB === '1') {
  throw new Error(
    'Intentional workflow failure after artifact verification; inspect the uploaded artifact.',
  );
}
