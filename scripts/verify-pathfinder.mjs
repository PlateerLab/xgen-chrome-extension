#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function testManifestPermissionContract() {
  for (const manifestPath of [
    path.join(repoRoot, 'manifest.json'),
    path.join(repoRoot, 'dist', 'manifest.json'),
  ]) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.ok(
      !manifest.permissions?.includes('cookies'),
      `${manifestPath}: cookies must not be an install-time permission`,
    );
    assert.ok(
      !manifest.host_permissions?.length,
      `${manifestPath}: install-time host permissions must be empty`,
    );
    assert.ok(
      !manifest.content_scripts?.length,
      `${manifestPath}: static all-host content scripts must not be declared`,
    );
    assert.deepEqual(manifest.optional_permissions, ['cookies']);
    assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
  }

  const contentBundlePath = path.join(repoRoot, 'dist', 'pathfinder-content.js');
  assert.ok(
    (await readFile(contentBundlePath, 'utf8')).length > 0,
    'dynamic content script bundle must be built',
  );
}

function captured({
  id,
  timestamp,
  url,
  method = 'GET',
  requestBody = null,
  requestContentType = '',
  requestMetadata,
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
    requestBody: requestBody == null
      ? null
      : typeof requestBody === 'string'
        ? requestBody
        : JSON.stringify(requestBody),
    requestContentType,
    ...(requestMetadata ? { requestMetadata } : {}),
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

async function loadHarImporter() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-har-'));
  const registrationSourcePath = path.join(
    repoRoot,
    'src/sidepanel/lib/trace-registration.ts',
  );
  const importerSourcePath = path.join(repoRoot, 'src/sidepanel/lib/har-import.ts');
  const compilerOptions = {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  };
  const registration = ts.transpileModule(
    await readFile(registrationSourcePath, 'utf8'),
    { compilerOptions, fileName: registrationSourcePath },
  );
  const importer = ts.transpileModule(
    await readFile(importerSourcePath, 'utf8'),
    { compilerOptions, fileName: importerSourcePath },
  );
  await writeFile(
    path.join(tmpDir, 'trace-registration.mjs'),
    registration.outputText,
    'utf8',
  );
  await writeFile(
    path.join(tmpDir, 'har-import.mjs'),
    importer.outputText.replace(
      /from ['"]\.\/trace-registration['"]/g,
      "from './trace-registration.mjs'",
    ),
    'utf8',
  );
  const mod = await import(pathToFileURL(path.join(tmpDir, 'har-import.mjs')).href);
  return {
    importHarArchive: mod.importHarArchive,
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
    mergeCollectionFromTrace: mod.mergeCollectionFromTrace,
    listApiCollections: mod.listApiCollections,
    previewOpenApiSource: mod.previewOpenApiSource,
    createApiCollection: mod.createApiCollection,
    addOpenApiSource: mod.addOpenApiSource,
    deleteApiCollection: mod.deleteApiCollection,
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

function testSingleNumericPathIsConservative(analyzeTrace) {
  const analysis = analyzeTrace([
    captured({
      id: 'year-report',
      timestamp: 1,
      url: 'https://bo.x2bee.com/api/reports/2026',
      responseBody: { year: 2026, total: 10 },
    }),
    captured({
      id: 'long-id',
      timestamp: 2,
      url: 'https://bo.x2bee.com/api/goods/123456',
      responseBody: { goodsNo: '123456' },
    }),
  ]);

  assert.ok(
    analysis.tools.some((tool) => tool.templatedPath === '/api/reports/2026'),
    `single year segment must stay literal: ${JSON.stringify(analysis.tools)}`,
  );
  assert.ok(
    analysis.tools.some((tool) => tool.templatedPath === '/api/goods/{id}'),
    `long numeric identifier should still be templated: ${JSON.stringify(analysis.tools)}`,
  );
}

function testGraphqlOperationsRemainDistinct(analyzeTrace) {
  const analysis = analyzeTrace([
    captured({
      id: 'graphql-list',
      timestamp: 1,
      method: 'POST',
      url: 'https://bo.x2bee.com/graphql',
      requestContentType: 'application/json',
      requestBody: JSON.stringify({
        operationName: 'GetGoodsList',
        query: 'query GetGoodsList($keyword: String!) { goods(keyword: $keyword) { id name } }',
        variables: { keyword: 'jeju' },
      }),
      requestMetadata: {
        bodyKind: 'graphql',
        fieldPaths: ['query', 'operationName', 'variables.keyword'],
        fileFields: [],
        graphql: { operationType: 'query', operationName: 'GetGoodsList' },
      },
      responseBody: { data: { goods: [{ id: 'G10001', name: '제주 상품' }] } },
    }),
    captured({
      id: 'graphql-detail',
      timestamp: 2,
      method: 'POST',
      url: 'https://bo.x2bee.com/graphql',
      requestContentType: 'application/json',
      requestBody: JSON.stringify({
        operationName: 'GetGoodsDetail',
        query: 'query GetGoodsDetail($id: ID!) { goodsDetail(id: $id) { id name price } }',
        variables: { id: 'G10001' },
      }),
      requestMetadata: {
        bodyKind: 'graphql',
        fieldPaths: ['query', 'operationName', 'variables.id'],
        fileFields: [],
        graphql: { operationType: 'query', operationName: 'GetGoodsDetail' },
      },
      responseBody: { data: { goodsDetail: { id: 'G10001', name: '제주 상품', price: 1000 } } },
    }),
  ]);

  assert.equal(analysis.tools.length, 2);
  assert.ok(analysis.tools.every((tool) => tool.captureMetadata.protocol === 'graphql'));
  assert.deepEqual(
    new Set(analysis.tools.map((tool) => tool.captureMetadata.graphql?.operationName)),
    new Set(['GetGoodsList', 'GetGoodsDetail']),
  );
  assert.equal(analysis.qualitySummary.graphqlToolCount, 2);
  assert.ok(
    analysis.tools.every((tool) => tool.captureMetadata.responseEnvelopePaths.includes('$.data')),
  );
}

function testRestQueryFieldAndHeterogeneousArray(analyzeTrace) {
  const analysis = analyzeTrace([
    captured({
      id: 'rest-query-field',
      timestamp: 1,
      method: 'POST',
      url: 'https://bo.x2bee.com/api/search',
      requestContentType: 'application/json',
      requestBody: { query: 'summer sale', filters: ['active'] },
      responseBody: [
        { id: 'ITEM-1' },
        { id: 'ITEM-2', displayName: 'Summer item' },
      ],
    }),
  ]);

  assert.equal(analysis.tools.length, 1);
  const tool = analysis.tools[0];
  assert.equal(tool.captureMetadata.protocol, 'http');
  assert.ok(
    tool.captureMetadata.responseSchemaVariants[0].fields.some(
      (field) => field.path === '$[].displayName' && field.type === 'string',
    ),
    `heterogeneous array fields should be preserved: ${JSON.stringify(tool.captureMetadata)}`,
  );
}

function testMultipartAndSchemaVariation(analyzeTrace) {
  const multipartMetadata = {
    bodyKind: 'multipart',
    fieldPaths: ['title', 'attachment.$file', 'attachment.contentType', 'attachment.size'],
    fileFields: [{ fieldPath: 'attachment', contentType: 'application/pdf', size: 1024 }],
  };
  const analysis = analyzeTrace([
    captured({
      id: 'upload-1',
      timestamp: 1,
      method: 'POST',
      url: 'https://bo.x2bee.com/api/documents/upload',
      requestContentType: 'multipart/form-data; boundary=fixture',
      requestBody: JSON.stringify({
        title: 'manual',
        attachment: { $file: true, contentType: 'application/pdf', size: 1024 },
      }),
      requestMetadata: multipartMetadata,
      responseBody: { result: { documentId: 'DOC-10001' } },
    }),
    captured({
      id: 'upload-2',
      timestamp: 2,
      method: 'POST',
      url: 'https://bo.x2bee.com/api/documents/upload',
      requestContentType: 'multipart/form-data; boundary=fixture-2',
      requestBody: JSON.stringify({
        title: 'manual',
        category: 'guide',
        attachment: { $file: true, contentType: 'application/pdf', size: 2048 },
      }),
      requestMetadata: multipartMetadata,
      responseBody: { result: { documentId: 'DOC-10002', revision: 2 } },
    }),
  ]);

  assert.equal(analysis.tools.length, 1);
  const tool = analysis.tools[0];
  assert.ok(tool.captureMetadata.requestBodyKinds.includes('multipart'));
  assert.equal(tool.captureMetadata.fileFields[0].fieldPath, 'attachment');
  assert.equal(tool.captureMetadata.requestSchemaVariants.length, 2);
  assert.equal(tool.captureMetadata.responseSchemaVariants.length, 2);
  assert.ok(
    tool.captureMetadata.issues.some((entry) => entry.code === 'schema_variation_observed'),
  );
  assert.equal(analysis.qualitySummary.multipartToolCount, 1);
  assert.equal(analysis.qualitySummary.schemaVariationToolCount, 1);
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
  assert.deepEqual(analysis.edges[0].valueEvidence, {
    sourceFieldPath: 'responseBody.rows[].goodsNo',
    targetFieldPath: 'query.goodsNo',
    valueType: 'string',
  });
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
  const searchTool = payload.tools.find((tool) => tool.templatedPath.endsWith('/search'));
  assert.equal(searchTool?.querySample.keyword, 'jeju');
  assert.equal(searchTool?.aiMetadata?.source, 'pathfinder_trace');
  assert.equal(searchTool?.aiMetadata?.canonical_action, 'search');
  assert.equal(searchTool?.aiMetadata?.primary_resource, 'goods');
  assert.ok(
    searchTool?.aiMetadata?.consumes_semantics?.some((entry) => entry.field === 'keyword' && entry.semantic === 'search_keyword'),
    `search metadata should include keyword consume semantics: ${JSON.stringify(searchTool?.aiMetadata)}`,
  );
  assert.ok(
    searchTool?.aiMetadata?.produces_semantics?.some((entry) => entry.field === 'goodsNo' && entry.semantic === 'goods_no'),
    `search metadata should include goodsNo produce semantics: ${JSON.stringify(searchTool?.aiMetadata)}`,
  );
  assert.equal(payload.edges[0].sampleSharedValue, undefined);
  assert.deepEqual(payload.edges[0].valueEvidence, {
    sourceFieldPath: 'responseBody.rows[].goodsNo',
    targetFieldPath: 'query.goodsNo',
    valueType: 'string',
  });
  assert.equal(searchTool?.captureMetadata?.protocol, 'http');
  assert.equal(typeof searchTool?.captureMetadata?.coverageScore, 'number');

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
        email: 'customer@example.com',
        phone: '010-1234-5678',
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
        accountReference: '1234567890123456',
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
  assert.ok(!serialized.includes('customer@example.com'), 'email should be redacted from payload');
  assert.ok(!serialized.includes('010-1234-5678'), 'phone should be redacted from payload');
  assert.ok(!serialized.includes('1234567890123456'), 'long numeric identifier should be redacted');
  assert.ok(serialized.includes('[REDACTED]'), 'redaction marker should remain for operator visibility');
  assert.ok(serialized.length < 25_000, `payload should be bounded, got ${serialized.length}`);

  const structureOnlyPayload = buildTraceRegistrationPayload(
    analysis,
    analysis.tools.map((candidate) => candidate.id),
    'bo_x2bee_com',
    { includeSamples: false },
  );
  const structureOnlyTool = structureOnlyPayload.tools[0];
  const structureOnlySerialized = JSON.stringify(structureOnlyPayload);

  assert.deepEqual(structureOnlyTool.querySample, {});
  assert.equal(structureOnlyTool.requestBodySample, undefined);
  assert.equal(structureOnlyTool.responseSample, undefined);
  assert.ok(
    structureOnlyTool.queryParamKeys.includes('keyword'),
    'structure-only registration should preserve query field names',
  );
  assert.ok(!structureOnlySerialized.includes('customer@example.com'));
  assert.ok(!structureOnlySerialized.includes('010-1234-5678'));
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
    valueEvidence: {
      sourceFieldPath: `responseBody.items[${idx}].id`,
      targetFieldPath: 'query.id',
      valueType: 'string',
    },
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

function testPrivacySafeHarImport(
  importHarArchive,
  analyzeTrace,
  buildTraceRegistrationPayload,
) {
  const har = {
    log: {
      version: '1.2',
      entries: [
        {
          startedDateTime: '2026-07-26T01:00:00.000Z',
          time: 25,
          request: {
            method: 'POST',
            url: 'https://url-user:url-password@api.customer.test/items?email=person@example.com&accessToken=query-secret',
            headers: [
              { name: 'Authorization', value: 'Bearer header-secret' },
              { name: 'Cookie', value: 'session=cookie-secret' },
              { name: 'Content-Type', value: 'application/json' },
            ],
            postData: {
              mimeType: 'application/json',
              text: JSON.stringify({
                itemId: 'ITEM-1',
                password: 'plain-password',
                email: 'person@example.com',
              }),
            },
          },
          response: {
            status: 200,
            headers: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Set-Cookie', value: 'session=response-secret' },
            ],
            content: {
              mimeType: 'application/json',
              text: JSON.stringify({
                itemId: 'ITEM-1',
                ownerEmail: 'owner@example.com',
                refreshToken: 'refresh-secret',
              }),
            },
          },
        },
        {
          startedDateTime: '2026-07-26T01:00:01.000Z',
          time: 15,
          request: {
            method: 'POST',
            url: 'https://api.customer.test/graphql',
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            postData: {
              mimeType: 'application/json',
              text: JSON.stringify({
                operationName: 'GetItem',
                query: 'query GetItem($id: ID!) { item(id: $id) { id name } }',
                variables: { id: 'ITEM-1' },
              }),
            },
          },
          response: {
            status: 200,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            content: {
              mimeType: 'application/json',
              encoding: 'base64',
              text: Buffer.from(
                JSON.stringify({ data: { item: { id: 'ITEM-1', name: '한글 상품' } } }),
                'utf8',
              ).toString('base64'),
            },
          },
        },
        {
          startedDateTime: '2026-07-26T01:00:02.000Z',
          time: 40,
          request: {
            method: 'POST',
            url: 'https://api.customer.test/documents',
            headers: [{ name: 'Content-Type', value: 'multipart/form-data' }],
            postData: {
              mimeType: 'multipart/form-data',
              params: [
                { name: 'title', value: 'guide' },
                {
                  name: 'attachment',
                  fileName: 'private-customer-name.pdf',
                  contentType: 'application/pdf',
                  value: 'file-bytes-secret',
                },
              ],
            },
          },
          response: {
            status: 201,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            content: {
              mimeType: 'application/json',
              text: JSON.stringify({ documentId: 'DOC-1' }),
            },
          },
        },
        {
          startedDateTime: '2026-07-26T01:00:03.000Z',
          request: {
            method: 'GET',
            url: 'wss://api.customer.test/socket',
          },
          response: { status: 101, content: {} },
        },
      ],
    },
  };

  const imported = importHarArchive(har, 77);
  const serialized = JSON.stringify(imported);
  assert.equal(imported.summary.totalEntries, 4);
  assert.equal(imported.summary.importedEntries, 3);
  assert.equal(imported.summary.skippedEntries, 1);
  assert.equal(imported.summary.redacted, true);
  assert.equal(imported.apis.every((api) => api.tabId === 77), true);
  assert.ok(!serialized.includes('query-secret'));
  assert.ok(!serialized.includes('url-user'));
  assert.ok(!serialized.includes('url-password'));
  assert.ok(!serialized.includes('header-secret'));
  assert.ok(!serialized.includes('cookie-secret'));
  assert.ok(!serialized.includes('plain-password'));
  assert.ok(!serialized.includes('person@example.com'));
  assert.ok(!serialized.includes('owner@example.com'));
  assert.ok(!serialized.includes('refresh-secret'));
  assert.ok(!serialized.includes('private-customer-name.pdf'));
  assert.ok(!serialized.includes('file-bytes-secret'));
  assert.equal(imported.apis[0].requestHeaders.authorization, undefined);
  assert.equal(imported.apis[0].requestHeaders.cookie, undefined);
  assert.equal(imported.apis[0].responseHeaders['set-cookie'], undefined);
  assert.equal(new URL(imported.apis[0].url).username, '');
  assert.equal(new URL(imported.apis[0].url).password, '');
  assert.ok(serialized.includes('한글 상품'));
  assert.equal(
    imported.apis.find((api) => api.url.endsWith('/documents'))
      ?.requestMetadata?.fileFields[0]?.fieldPath,
    'attachment',
  );

  const analysis = analyzeTrace(imported.apis);
  assert.equal(analysis.primaryHost, 'api.customer.test');
  assert.ok(analysis.tools.length >= 3);
  assert.equal(analysis.qualitySummary.graphqlToolCount, 1);
  assert.equal(analysis.qualitySummary.multipartToolCount, 1);

  const payload = buildTraceRegistrationPayload(
    analysis,
    analysis.tools.map((tool) => tool.id),
  );
  const payloadText = JSON.stringify(payload);
  assert.ok(!payloadText.includes('query-secret'));
  assert.ok(!payloadText.includes('plain-password'));
  assert.ok(!payloadText.includes('private-customer-name.pdf'));
}

function testHarImportValidationAndCaps(importHarArchive) {
  assert.throws(
    () => importHarArchive({}),
    /HAR log 객체/,
  );

  const entry = {
    startedDateTime: '2026-07-26T01:00:00.000Z',
    time: 1,
    request: {
      method: 'GET',
      url: 'https://api.customer.test/items',
      headers: [],
    },
    response: {
      status: 200,
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      content: {
        mimeType: 'application/json',
        text: JSON.stringify({ ok: true }),
      },
    },
  };
  const capped = importHarArchive({
    log: {
      entries: Array.from({ length: 501 }, () => entry),
    },
  });
  assert.equal(capped.apis.length, 500);
  assert.equal(capped.summary.skippedEntries, 1);
  assert.equal(capped.summary.truncated, true);

  const oversized = importHarArchive({
    log: {
      entries: [{
        ...entry,
        response: {
          ...entry.response,
          content: {
            mimeType: 'application/json',
            text: 'x'.repeat(100_001),
          },
        },
      }],
    },
  });
  assert.equal(oversized.apis[0].responseBody, null);
  assert.equal(oversized.summary.truncated, true);
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

async function testCollectionFromTraceApi(createCollectionFromTrace, mergeCollectionFromTrace) {
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
      aiMetadata: {
        source: 'pathfinder_trace',
        canonical_action: 'search',
        primary_resource: 'goods',
      },
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
    assert.equal(body.tools[0].aiMetadata?.canonical_action, payload.tools[0].aiMetadata?.canonical_action);
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

  await withMockFetch(async () => new Response(JSON.stringify({
    collection_id: 'bo_x2bee_com',
    tool_count: 1,
  }), { status: 200, headers: { 'content-type': 'application/json' } }), async (calls) => {
    const result = await mergeCollectionFromTrace(
      'https://xgen.x2bee.com',
      'token-123',
      'bo/x2bee',
      payload,
    );
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://xgen.x2bee.com/api/tools/api-collections/bo%2Fx2bee/from-trace',
    );
    assert.equal(calls[0].init.method, 'POST');
  });
}

async function testOpenApiCollectionApi({
  listApiCollections,
  previewOpenApiSource,
  createApiCollection,
  addOpenApiSource,
  deleteApiCollection,
}) {
  const observed = [];
  await withMockFetch(async (url, init) => {
    const requestUrl = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    observed.push({ requestUrl, init, body });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (!init.method) {
      return new Response(JSON.stringify([
        { collection_id: 'existing', name: 'Existing', tool_count: 1 },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requestUrl.endsWith('/preview')) {
      return new Response(JSON.stringify({
        incoming_tool_count: 1,
        conflicts: [],
        edges_before: 0,
        edges_after: 0,
        edges_added: 0,
        existing_total: 0,
        spec_hash: 'hash',
        ingest_stats: {},
        ingest_result: { adapter: 'openapi', ready: true, issues: [] },
        ingest_supported: true,
        readiness_report: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      collection_id: 'catalog',
      name: 'Catalog',
      tool_count: requestUrl.endsWith('/sources') ? 1 : 0,
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }, async () => {
    const source = {
      spec: {
        openapi: '3.0.3',
        info: { title: 'Catalog', version: '1.0.0' },
        paths: {},
      },
    };
    const collections = await listApiCollections('https://xgen.example', 'auth-value');
    assert.equal(collections[0].collection_id, 'existing');
    await previewOpenApiSource(
      'https://xgen.example',
      'auth-value',
      source,
      { targetCollectionId: 'existing', label: 'catalog' },
    );
    await createApiCollection('https://xgen.example', 'auth-value', {
      collectionId: 'catalog',
      name: 'Catalog',
      baseUrl: 'https://api.example',
      authProfileId: 'profile-1',
      domainPatterns: ['api.example'],
    });
    await addOpenApiSource('https://xgen.example', 'auth-value', 'catalog/name', {
      ...source,
      label: 'catalog',
    });
    await deleteApiCollection('https://xgen.example', 'auth-value', 'catalog/name');
  });

  assert.equal(observed.length, 5);
  assert.equal(observed[0].requestUrl, 'https://xgen.example/api/tools/api-collections');
  assert.equal(observed[0].init.headers.Authorization, 'Bearer auth-value');
  assert.equal(
    observed[1].requestUrl,
    'https://xgen.example/api/tools/api-collections/preview',
  );
  assert.equal(observed[1].body.format_hint, 'openapi');
  assert.deepEqual(observed[1].body.required_capabilities, [
    'input_schema',
    'output_schema',
  ]);
  assert.equal(observed[1].body.target_collection_id, 'existing');
  assert.equal(observed[2].body.auth_profile_id, 'profile-1');
  assert.deepEqual(observed[2].body.domain_patterns, ['api.example']);
  assert.equal(
    observed[3].requestUrl,
    'https://xgen.example/api/tools/api-collections/catalog%2Fname/sources',
  );
  assert.equal(observed[3].body.auto_enrich, false);
  assert.equal(observed[4].init.method, 'DELETE');
  assert.equal(
    observed[4].requestUrl,
    'https://xgen.example/api/tools/api-collections/catalog%2Fname',
  );

  await withMockFetch(
    async () => new Response(JSON.stringify({
      detail: {
        message: 'unsupported source',
        ingest_result: { ready: false },
      },
    }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    }),
    async () => {
      await assert.rejects(
        () => previewOpenApiSource(
          'https://xgen.example',
          '',
          { sourceUrl: 'https://api.example/swagger-ui' },
        ),
        /OpenAPI 미리보기 실패: 422 unsupported source/,
      );
    },
  );
}

async function main() {
  await testManifestPermissionContract();
  const { analyzeTrace, cleanup } = await loadTraceAnalyzer();
  const {
    buildTraceRegistrationPayload,
    cleanup: cleanupRegistration,
  } = await loadTraceRegistration();
  const {
    importHarArchive,
    cleanup: cleanupHarImporter,
  } = await loadHarImporter();
  const {
    createCollectionFromTrace,
    mergeCollectionFromTrace,
    listApiCollections,
    previewOpenApiSource,
    createApiCollection,
    addOpenApiSource,
    deleteApiCollection,
    cleanup: cleanupApi,
  } = await loadApiClient();
  try {
    testTraceFiltering(analyzeTrace);
    testAnalyticsHeavyCaptureKeepsPrimaryApiHost(analyzeTrace);
    testAuthHostDoesNotStealPrimaryHost(analyzeTrace);
    testPathTemplating(analyzeTrace);
    testSingleNumericPathIsConservative(analyzeTrace);
    testGraphqlOperationsRemainDistinct(analyzeTrace);
    testRestQueryFieldAndHeterogeneousArray(analyzeTrace);
    testMultipartAndSchemaVariation(analyzeTrace);
    testPollingIsCollapsed(analyzeTrace);
    testPostBodySample(analyzeTrace);
    testObservedEdges(analyzeTrace);
    testTraceRegistrationPayload(analyzeTrace, buildTraceRegistrationPayload);
    testTraceRegistrationPayloadHardening(analyzeTrace, buildTraceRegistrationPayload);
    testTraceRegistrationPayloadCaps(buildTraceRegistrationPayload);
    testPrivacySafeHarImport(
      importHarArchive,
      analyzeTrace,
      buildTraceRegistrationPayload,
    );
    testHarImportValidationAndCaps(importHarArchive);
    await testCollectionFromTraceApi(createCollectionFromTrace, mergeCollectionFromTrace);
    await testOpenApiCollectionApi({
      listApiCollections,
      previewOpenApiSource,
      createApiCollection,
      addOpenApiSource,
      deleteApiCollection,
    });
  } finally {
    await cleanup();
    await cleanupRegistration();
    await cleanupHarImporter();
    await cleanupApi();
  }

  console.log(
    'PathFinder verification passed: permission manifest, trace analysis, registration payload, API client.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
