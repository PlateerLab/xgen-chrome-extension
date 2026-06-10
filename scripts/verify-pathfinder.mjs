#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function captured({
  id,
  timestamp,
  url,
  method = 'GET',
  requestBody = null,
  responseStatus = 200,
  responseBody = {},
  requestHeaders = {},
  responseHeaders = {},
  contentType = 'application/json',
}) {
  return {
    id,
    tabId: 1,
    timestamp,
    url,
    method,
    requestHeaders,
    requestBody,
    responseStatus,
    responseHeaders,
    responseBody: responseBody == null
      ? null
      : typeof responseBody === 'string'
        ? responseBody
        : JSON.stringify(responseBody),
    contentType,
    duration: 12,
    origin: 'user',
  };
}

async function loadTraceAnalyzer() {
  const sourcePath = path.join(repoRoot, 'src/sidepanel/lib/trace-analyzer.ts');
  const source = await readFile(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      verbatimModuleSyntax: true,
    },
    fileName: sourcePath,
  });

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-verify-'));
  const outputPath = path.join(tmpDir, 'trace-analyzer.mjs');
  await writeFile(outputPath, compiled.outputText, 'utf8');
  const mod = await import(pathToFileURL(outputPath).href);
  return {
    analyzeTrace: mod.analyzeTrace,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

function testTraceFiltering(analyzeTrace) {
  const analysis = analyzeTrace([
    captured({
      id: 'nav',
      timestamp: 1,
      method: 'NAVIGATION',
      url: 'https://bo.x2bee.com/dashboard',
      responseBody: null,
    }),
    captured({
      id: 'analytics',
      timestamp: 2,
      url: 'https://www.google-analytics.com/collect?v=1',
      responseBody: {},
    }),
    captured({
      id: 'login',
      timestamp: 3,
      method: 'POST',
      url: 'https://bo.x2bee.com/api/bo/v2/login',
      requestBody: JSON.stringify({ userId: 'x2bee', password: 'secret' }),
      responseBody: { payload: { accessToken: 'token-12345' } },
    }),
    captured({
      id: 'orders',
      timestamp: 4,
      url: 'https://bo.x2bee.com/api/order/v1/orders?siteNo=1000&langCd=ko',
      responseBody: { rows: [{ orderNo: '202606100001' }] },
    }),
    captured({
      id: 'other-host',
      timestamp: 5,
      url: 'https://cdn.example.com/api/order/v1/orders',
      responseBody: { ok: true },
    }),
    captured({
      id: 'server-error',
      timestamp: 6,
      url: 'https://bo.x2bee.com/api/order/v1/error',
      responseStatus: 500,
      responseBody: { error: true },
    }),
  ]);

  assert.equal(analysis.primaryHost, 'bo.x2bee.com');
  assert.equal(analysis.authCandidates.length, 1);
  assert.equal(analysis.tools.length, 1);
  assert.equal(analysis.tools[0].templatedPath, '/api/order/v1/orders');
  assert.equal(analysis.tools[0].querySample.siteNo, '1000');
  assert.equal(analysis.tools[0].querySample.langCd, 'ko');
}

function testAnalyticsHeavyCaptureKeepsPrimaryApiHost(analyzeTrace) {
  const noisyAnalytics = Array.from({ length: 5 }, (_, idx) => captured({
    id: `analytics-${idx}`,
    timestamp: idx + 1,
    url: `https://www.google-analytics.com/collect?v=${idx}`,
    responseBody: {},
  }));
  const analysis = analyzeTrace([
    ...noisyAnalytics,
    captured({
      id: 'goods',
      timestamp: 10,
      url: 'https://bo.x2bee.com/api/goods/v1/search?keyword=jeju',
      responseBody: { rows: [{ goodsNo: '987654' }] },
    }),
  ]);

  assert.equal(analysis.primaryHost, 'bo.x2bee.com');
  assert.equal(analysis.tools.length, 1);
  assert.equal(analysis.tools[0].templatedPath, '/api/goods/v1/search');
  assert.equal(analysis.dropped.find((d) => d.reason === 'analytics/tracking')?.count, 5);
}

function testAuthHostDoesNotStealPrimaryHost(analyzeTrace) {
  const analysis = analyzeTrace([
    captured({
      id: 'auth-1',
      timestamp: 1,
      method: 'POST',
      url: 'https://auth.x2bee.com/oauth/token',
      responseBody: { access_token: 'token-11111' },
    }),
    captured({
      id: 'auth-2',
      timestamp: 2,
      method: 'POST',
      url: 'https://auth.x2bee.com/session/refresh',
      responseBody: { access_token: 'token-22222' },
    }),
    captured({
      id: 'orders',
      timestamp: 3,
      url: 'https://bo.x2bee.com/api/order/v1/orders?siteNo=1000',
      responseBody: { rows: [{ orderNo: '202606100001' }] },
    }),
  ]);

  assert.equal(analysis.primaryHost, 'bo.x2bee.com');
  assert.equal(analysis.authCandidates.length, 2);
  assert.equal(analysis.tools.length, 1);
  assert.equal(analysis.tools[0].templatedPath, '/api/order/v1/orders');
}

function testPathTemplating(analyzeTrace) {
  const analysis = analyzeTrace([
    captured({
      id: 'goods-1',
      timestamp: 10,
      url: 'https://bo.x2bee.com/api/goods/v1/goods/123456?siteNo=1000&langCd=ko',
      responseBody: { goodsNo: '123456', goodsName: '상품 A' },
    }),
    captured({
      id: 'goods-2',
      timestamp: 20,
      url: 'https://bo.x2bee.com/api/goods/v1/goods/234567?siteNo=1000&langCd=ko',
      responseBody: { goodsNo: '234567', goodsName: '상품 B' },
    }),
  ]);

  assert.equal(analysis.tools.length, 1);
  const [tool] = analysis.tools;
  assert.equal(tool.method, 'GET');
  assert.equal(tool.templatedPath, '/api/goods/v1/goods/{id}');
  assert.deepEqual(tool.pathParams, ['id']);
  assert.equal(tool.sampleCount, 2);
  assert.deepEqual(new Set(tool.queryParamKeys), new Set(['siteNo', 'langCd']));
}

function testPollingIsCollapsed(analyzeTrace) {
  const analysis = analyzeTrace([
    captured({
      id: 'poll-1',
      timestamp: 1_000,
      url: 'https://bo.x2bee.com/api/notification/v1/count',
      responseBody: { count: 1 },
    }),
    captured({
      id: 'poll-2',
      timestamp: 2_000,
      url: 'https://bo.x2bee.com/api/notification/v1/count',
      responseBody: { count: 1 },
    }),
    captured({
      id: 'poll-3',
      timestamp: 3_000,
      url: 'https://bo.x2bee.com/api/notification/v1/count',
      responseBody: { count: 1 },
    }),
  ]);

  assert.equal(analysis.tools.length, 1);
  assert.equal(analysis.tools[0].sampleCount, 1);
  assert.equal(analysis.dropped.find((d) => d.reason.includes('폴링 패턴'))?.count, 2);
}

function testPostBodySample(analyzeTrace) {
  const analysis = analyzeTrace([
    captured({
      id: 'create-order',
      timestamp: 1,
      method: 'POST',
      url: 'https://bo.x2bee.com/api/order/v1/orders?siteNo=1000',
      requestBody: JSON.stringify({ goodsNo: '987654', quantity: 2 }),
      responseBody: { orderNo: '202606100001' },
    }),
  ]);

  assert.equal(analysis.tools.length, 1);
  assert.equal(analysis.tools[0].method, 'POST');
  assert.deepEqual(analysis.tools[0].requestBodySample, { goodsNo: '987654', quantity: 2 });
  assert.equal(analysis.tools[0].querySample.siteNo, '1000');
}

function testObservedEdges(analyzeTrace) {
  const analysis = analyzeTrace([
    captured({
      id: 'search',
      timestamp: 100,
      url: 'https://bo.x2bee.com/api/goods/v1/search?keyword=jeju',
      responseBody: { rows: [{ goodsNo: '987654', goodsName: '제주 상품' }] },
    }),
    captured({
      id: 'detail',
      timestamp: 200,
      url: 'https://bo.x2bee.com/api/goods/v1/detail?goodsNo=987654&siteNo=1000',
      responseBody: { goodsNo: '987654', stockQty: 5 },
    }),
  ]);

  assert.equal(analysis.tools.length, 2);
  assert.equal(analysis.edges.length, 1);
  assert.match(analysis.edges[0].fromToolId, /\/search$/);
  assert.match(analysis.edges[0].toToolId, /\/detail$/);
  assert.equal(analysis.edges[0].sampleSharedValue, '987654');
}

async function main() {
  const { analyzeTrace, cleanup } = await loadTraceAnalyzer();
  try {
    testTraceFiltering(analyzeTrace);
    testAnalyticsHeavyCaptureKeepsPrimaryApiHost(analyzeTrace);
    testAuthHostDoesNotStealPrimaryHost(analyzeTrace);
    testPathTemplating(analyzeTrace);
    testPollingIsCollapsed(analyzeTrace);
    testPostBodySample(analyzeTrace);
    testObservedEdges(analyzeTrace);
  } finally {
    await cleanup();
  }

  console.log('PathFinder verification passed: trace filtering, templating, query samples, observed edges.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
