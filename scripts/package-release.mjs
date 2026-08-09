#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');
const releaseDir = path.resolve(
  process.env.PATHFINDER_RELEASE_DIR || path.join(repoRoot, 'artifacts/release'),
);
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const sourceManifest = JSON.parse(await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');

assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, 'package version must be semver');
assert.equal(packageLock.version, packageJson.version, 'package-lock.json version must match');
assert.equal(
  packageLock.packages?.['']?.version,
  packageJson.version,
  'package-lock.json root package version must match',
);
assert.equal(sourceManifest.version, packageJson.version, 'source manifest version must match');
assert.equal(
  manifest.version,
  packageJson.version,
  'package.json and built manifest.json versions must match',
);
assert.match(
  changelog,
  new RegExp(`^## ${packageJson.version.replace(/\./g, '\\.')}(?:\\s|$)`, 'm'),
  'CHANGELOG.md is missing the release version',
);

await mkdir(releaseDir, { recursive: true });
const archiveName = `xgen-pathfinder-v${packageJson.version}.zip`;
const archivePath = path.join(releaseDir, archiveName);
await rm(archivePath, { force: true });

const zip = spawnSync(
  'zip',
  ['-q', '-r', archivePath, '.', '-x', '*.map', '*/.DS_Store'],
  { cwd: distDir, encoding: 'utf8' },
);
if (zip.error) throw zip.error;
assert.equal(zip.status, 0, `zip failed: ${zip.stderr || zip.stdout}`);

const integrity = spawnSync('unzip', ['-tq', archivePath], { encoding: 'utf8' });
if (integrity.error) throw integrity.error;
assert.equal(
  integrity.status,
  0,
  `archive integrity failed: ${integrity.stderr || integrity.stdout}`,
);

const list = spawnSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' });
if (list.error) throw list.error;
assert.equal(list.status, 0, `archive listing failed: ${list.stderr || list.stdout}`);
const entries = list.stdout.split(/\r?\n/).filter(Boolean);
for (const requiredEntry of [
  'manifest.json',
  'service-worker-loader.js',
  'pathfinder-content.js',
  'src/sidepanel/index.html',
  'public/icons/icon-16.png',
  'public/icons/icon-48.png',
  'public/icons/icon-128.png',
]) {
  assert.ok(entries.includes(requiredEntry), `release archive is missing ${requiredEntry}`);
}
assert.ok(!entries.some((entry) => entry.endsWith('.map')), 'release archive contains source maps');
assert.ok(
  !entries.some((entry) => {
    const segments = entry.replaceAll('\\', '/').split('/');
    return entry.includes('\\')
      || entry.startsWith('/')
      || segments.includes('..')
      || segments.some((segment) => segment.startsWith('.'));
  }),
  'release archive contains an unsafe path',
);
const allowedTopLevel = new Set([
  'assets',
  'icons',
  'manifest.json',
  'pathfinder-content.js',
  'public',
  'service-worker-loader.js',
  'src',
]);
assert.ok(
  entries.every((entry) => allowedTopLevel.has(entry.replaceAll('\\', '/').split('/')[0])),
  'release archive contains an unexpected top-level entry',
);

const archive = await readFile(archivePath);
const digest = createHash('sha256').update(archive).digest('hex');
const archiveStat = await stat(archivePath);
assert.ok(archiveStat.size <= 5 * 1024 * 1024, 'release archive exceeds 5 MiB');
console.log(JSON.stringify({
  status: 'passed',
  version: packageJson.version,
  archive: archivePath,
  sizeBytes: archiveStat.size,
  entryCount: entries.length,
  sha256: digest,
}, null, 2));
