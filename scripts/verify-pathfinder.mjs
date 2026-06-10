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

async function loadTraceRegistration() {
  const sourcePath = path.join(repoRoot, 'src/sidepanel/lib/trace-registration.ts');
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

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-registration-'));
  const outputPath = path.join(tmpDir, 'trace-registration.mjs');
  await writeFile(outputPath, compiled.outputText, 'utf8');
  const mod = await import(pathToFileURL(outputPath).href);
  return {
    buildTraceRegistrationPayload: mod.buildTraceRegistrationPayload,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

async function loadApiClient() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-api-'));

  const constantsSourcePath = path.join(repoRoot, 'src/shared/constants.ts');
  const constantsSource = await readFile(constantsSourcePath, 'utf8');
  const constantsCompiled = ts.transpileModule(constantsSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: constantsSourcePath,
  });
  await writeFile(path.join(tmpDir, 'constants.mjs'), constantsCompiled.outputText, 'utf8');

  const apiSourcePath = path.join(repoRoot, 'src/shared/api.ts');
  const apiSource = await readFile(apiSourcePath, 'utf8');
  const apiCompiled = ts.transpileModule(apiSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: apiSourcePath,
  });
  const apiOutput = apiCompiled.outputText.replace("from './constants'", "from './constants.mjs'");
  await writeFile(path.join(tmpDir, 'api.mjs'), apiOutput, 'utf8');

  const mod = await import(pathToFileURL(path.join(tmpDir, 'api.mjs')).href);
  return {
    createCollectionFromTrace: mod.createCollectionFromTrace,
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

function testTraceRegistrationPayload(analyzeTrace, buildTraceRegistrationPayload) {
  const analysis = analyzeTrace([
    captured({
      id: 'search',
      timestamp: 1,
      url: 'https://bo.x2bee.com/api/goods/v1/search?keyword=jeju&siteNo=1000',
      responseBody: { rows: [{ goodsNo: '987654' }] },
    }),
    captured({
      id: 'detail',
      timestamp: 2,
      url: 'https://bo.x2bee.com/api/goods/v1/detail?goodsNo=987654&siteNo=1000',
      responseBody: { goodsNo: '987654', stockQty: 5 },
    }),
    captured({
      id: 'member',
      timestamp: 3,
      url: 'https://bo.x2bee.com/api/member/v1/me',
      responseBody: { memberNo: 'M202606100001' },
    }),
  ]);
  const selected = analysis.tools
    .filter((tool) => tool.templatedPath.includes('/goods/'))
    .map((tool) => tool.id);
  const payload = buildTraceRegistrationPayload(analysis, selected, 'bo_x2bee_com');

  assert.equal(payload.host, 'bo.x2bee.com');
  assert.equal(payload.authProfileId, 'bo_x2bee_com');
  assert.equal(payload.tools.length, 2);
  assert.equal(payload.edges.length, 1);
  assert.ok(payload.tools.every((tool) => tool.templatedPath.includes('/goods/')));
  assert.equal(payload.tools.find((tool) => tool.templatedPath.endsWith('/search'))?.querySample.keyword, 'jeju');
  assert.equal(payload.edges[0].sampleSharedValue, '987654');

  assert.throws(
    () => buildTraceRegistrationPayload({ ...analysis, primaryHost: null }, selected),
    /host를 식별/,
  );
}

function testTraceRegistrationPayloadHardening(analyzeTrace, buildTraceRegistrationPayload) {
  const largeDescription = 'x'.repeat(35_000);
  const analysis = analyzeTrace([
    captured({
      id: 'sensitive-search',
      timestamp: 1,
      method: 'POST',
      url: 'https://bo.x2bee.com/api/goods/v1/search?keyword=jeju&accessToken=token-query-secret',
      requestBody: {
        keyword: 'jeju',
        password: 'plain-password',
        nested: {
          authorization: 'Bearer token-body-secret',
          keep: 'visible',
        },
      },
      responseBody: {
        rows: Array.from({ length: 35 }, (_, idx) => ({
          goodsNo: `G${idx}`,
          name: `상품-${idx}`,
          refreshToken: `refresh-token-${idx}`,
        })),
        description: largeDescription,
      },
    }),
  ]);

  const payload = buildTraceRegistrationPayload(
    analysis,
    analysis.tools.map((tool) => tool.id),
    'bo_x2bee_com',
  );
  const tool = payload.tools[0];
  const serialized = JSON.stringify(payload);

  assert.equal(payload.tools.length, 1);
  assert.ok(tool.sampleMeta?.redacted, `sampleMeta should mark redaction: ${JSON.stringify(tool.sampleMeta)}`);
  assert.ok(tool.sampleMeta?.truncated, `sampleMeta should mark truncation: ${JSON.stringify(tool.sampleMeta)}`);
  assert.equal(tool.sampleMeta?.droppedQueryKeyCount, 1);
  assert.deepEqual(tool.queryParamKeys, ['keyword']);
  assert.equal(tool.querySample.keyword, 'jeju');
  assert.ok(!serialized.includes('token-query-secret'), 'query token should be removed from payload');
  assert.ok(!serialized.includes('plain-password'), 'password should be redacted from payload');
  assert.ok(!serialized.includes('token-body-secret'), 'authorization value should be redacted from payload');
  assert.ok(!serialized.includes('refresh-token-0'), 'response token should be redacted from payload');
  assert.ok(serialized.includes('[REDACTED]'), 'redaction marker should remain for operator visibility');
  assert.ok(serialized.length < 25_000, `payload should be bounded, got ${serialized.length}`);
}

function testTraceRegistrationPayloadCaps(buildTraceRegistrationPayload) {
  const tools = Array.from({ length: 60 }, (_, idx) => ({
    id: `GET:bo.x2bee.com/api/goods/v1/item/${idx}`,
    method: 'GET',
    host: 'bo.x2bee.com',
    templatedPath: `/api/goods/v1/item/${idx}`,
    rawPaths: [`/api/goods/v1/item/${idx}`],
    sampleCount: 1,
    pathParams: [],
    queryParamKeys: ['keyword'],
    querySample: { keyword: `item-${idx}` },
    responseSample: { goodsNo: `${idx}` },
    label: `상품 ${idx}`,
    isLowPriority: false,
  }));
  const edges = Array.from({ length: 220 }, (_, idx) => ({
    fromToolId: tools[idx % 50].id,
    toToolId: tools[(idx + 1) % 50].id,
    source: 'observed',
    confidence: 1,
    sampleSharedValue: `shared-${idx}`,
  }));

  const payload = buildTraceRegistrationPayload(
    {
      primaryHost: 'bo.x2bee.com',
      tools,
      edges,
      authCandidates: [],
      dropped: [],
      totalRaw: tools.length,
      keptRaw: tools.length,
    },
    tools.map((tool) => tool.id),
  );

  assert.equal(payload.tools.length, 50);
  assert.equal(payload.edges.length, 200);
  const includedIds = new Set(tools.slice(0, 50).map((tool) => tool.id));
  assert.ok(payload.edges.every((edge) => includedIds.has(edge.fromToolId) && includedIds.has(edge.toToolId)));
}

async function withMockFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCreateCollectionFromTrace(createCollectionFromTrace) {
  const payload = {
    host: 'bo.x2bee.com',
    authProfileId: 'bo_x2bee_com',
    tools: [{
      method: 'GET',
      templatedPath: '/api/goods/v1/search',
      pathParams: [],
      queryParamKeys: ['keyword'],
      querySample: { keyword: 'jeju' },
      responseSample: { rows: [] },
      label: '상품 검색',
      sampleCount: 1,
    }],
    edges: [],
  };

  await withMockFetch(async (_url, _init) => new Response(JSON.stringify({
    collection_id: 'bo_x2bee_com',
    tool_count: 1,
  }), { status: 201, headers: { 'content-type': 'application/json' } }), async (calls) => {
    const result = await createCollectionFromTrace('https://xgen.x2bee.com', 'token-123', payload);
    assert.equal(result.status, 201);
    assert.equal(result.collection.collection_id, 'bo_x2bee_com');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://xgen.x2bee.com/api/tools/api-collections/from-trace');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token-123');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.host, 'bo.x2bee.com');
    assert.equal(body.auth_profile_id, 'bo_x2bee_com');
    assert.equal(body.tools[0].querySample.keyword, 'jeju');
  });

  await withMockFetch(async () => new Response(JSON.stringify({
    detail: {
      collection_id: 'bo_x2bee_com',
      name: 'BO',
      hint: '이미 등록됨',
    },
  }), { status: 409, headers: { 'content-type': 'application/json' } }), async () => {
    const result = await createCollectionFromTrace('https://xgen.x2bee.com', '', payload);
    assert.equal(result.status, 409);
    assert.equal(result.collectionId, 'bo_x2bee_com');
    assert.equal(result.message, '이미 등록됨');
  });

  await withMockFetch(async () => new Response('broken', { status: 500, statusText: 'Internal Server Error' }), async () => {
    await assert.rejects(
      () => createCollectionFromTrace('https://xgen.x2bee.com', '', payload),
      /Collection create failed: 500 broken/,
    );
  });
}

async function main() {
  const { analyzeTrace, cleanup } = await loadTraceAnalyzer();
  const {
    buildTraceRegistrationPayload,
    cleanup: cleanupRegistration,
  } = await loadTraceRegistration();
  const { createCollectionFromTrace, cleanup: cleanupApi } = await loadApiClient();
  try {
    testTraceFiltering(analyzeTrace);
    testAnalyticsHeavyCaptureKeepsPrimaryApiHost(analyzeTrace);
    testAuthHostDoesNotStealPrimaryHost(analyzeTrace);
    testPathTemplating(analyzeTrace);
    testPollingIsCollapsed(analyzeTrace);
    testPostBodySample(analyzeTrace);
    testObservedEdges(analyzeTrace);
    testTraceRegistrationPayload(analyzeTrace, buildTraceRegistrationPayload);
    testTraceRegistrationPayloadHardening(analyzeTrace, buildTraceRegistrationPayload);
    testTraceRegistrationPayloadCaps(buildTraceRegistrationPayload);
    await testCreateCollectionFromTrace(createCollectionFromTrace);
  } finally {
    await cleanup();
    await cleanupRegistration();
    await cleanupApi();
  }

  console.log('PathFinder verification passed: trace analysis, registration payload, API client.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
