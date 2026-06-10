#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  ['npm', ['run', 'build']],
  ['node', ['scripts/verify-pathfinder.mjs']],
  ['node', ['scripts/verify-runtime.mjs']],
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
      }
    });
  });
}

for (const [command, args] of steps) {
  await run(command, args);
}

console.log('\nXGEN Pathfinder verification passed.');
