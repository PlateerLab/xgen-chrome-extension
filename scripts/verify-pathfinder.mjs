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
  captureContext,
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
    ...(captureContext ? { captureContext } : {}),
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

async function loadLegacyToolRegistration() {
  const sourcePath = path.join(repoRoot, 'src/shared/legacy-tool-registration.ts');
  const source = await readFile(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: sourcePath,
  });

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-legacy-tool-'));
  const outputPath = path.join(tmpDir, 'legacy-tool-registration.mjs');
  await writeFile(outputPath, compiled.outputText, 'utf8');
  const mod = await import(pathToFileURL(outputPath).href);
  return {
    buildValueFreeLegacyToolContent: mod.buildValueFreeLegacyToolContent,
    summarizeCapturedApiForCommand: mod.summarizeCapturedApiForCommand,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

async function loadPlanArguments() {
  const sourcePath = path.join(repoRoot, 'src/shared/plan-arguments.ts');
  const source = await readFile(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: sourcePath,
  });

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-plan-args-'));
  const outputPath = path.join(tmpDir, 'plan-arguments.mjs');
  await writeFile(outputPath, compiled.outputText, 'utf8');
  const mod = await import(pathToFileURL(outputPath).href);
  return {
    findFirstMissingPlanArgument: mod.findFirstMissingPlanArgument,
    findSuspiciousRuntimeArgument: mod.findSuspiciousRuntimeArgument,
    isStepBinding: mod.isStepBinding,
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

async function loadManualToolContractBuilder() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-manual-contract-'));
  const registrationSourcePath = path.join(
    repoRoot,
    'src/sidepanel/lib/trace-registration.ts',
  );
  const builderSourcePath = path.join(
    repoRoot,
    'src/sidepanel/lib/manual-tool-contract.ts',
  );
  const compilerOptions = {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  };
  const registration = ts.transpileModule(
    await readFile(registrationSourcePath, 'utf8'),
    { compilerOptions, fileName: registrationSourcePath },
  );
  const builder = ts.transpileModule(
    await readFile(builderSourcePath, 'utf8'),
    { compilerOptions, fileName: builderSourcePath },
  );
  await writeFile(
    path.join(tmpDir, 'trace-registration.mjs'),
    registration.outputText,
    'utf8',
  );
  await writeFile(
    path.join(tmpDir, 'manual-tool-contract.mjs'),
    builder.outputText.replace(
      /from ['"]\.\/trace-registration['"]/g,
      "from './trace-registration.mjs'",
    ),
    'utf8',
  );
  const mod = await import(
    pathToFileURL(path.join(tmpDir, 'manual-tool-contract.mjs')).href
  );
  return {
    buildManualToolContractSource: mod.buildManualToolContractSource,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

async function loadPostmanImporter() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-postman-'));
  const registrationSourcePath = path.join(
    repoRoot,
    'src/sidepanel/lib/trace-registration.ts',
  );
  const importerSourcePath = path.join(
    repoRoot,
    'src/sidepanel/lib/postman-import.ts',
  );
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
    path.join(tmpDir, 'postman-import.mjs'),
    importer.outputText.replace(
      /from ['"]\.\/trace-registration['"]/g,
      "from './trace-registration.mjs'",
    ),
    'utf8',
  );
  const mod = await import(pathToFileURL(path.join(tmpDir, 'postman-import.mjs')).href);
  return {
    importPostmanCollection: mod.importPostmanCollection,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

async function loadGraphQLIntrospectionImporter() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-graphql-'));
  const registrationSourcePath = path.join(
    repoRoot,
    'src/sidepanel/lib/trace-registration.ts',
  );
  const sourcePath = path.join(
    repoRoot,
    'src/sidepanel/lib/graphql-introspection.ts',
  );
  const compilerOptions = {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  };
  const registration = ts.transpileModule(
    await readFile(registrationSourcePath, 'utf8'),
    { compilerOptions, fileName: registrationSourcePath },
  );
  const compiled = ts.transpileModule(
    await readFile(sourcePath, 'utf8'),
    {
      compilerOptions,
      fileName: sourcePath,
    },
  );
  await writeFile(
    path.join(tmpDir, 'trace-registration.mjs'),
    registration.outputText,
    'utf8',
  );
  const outputPath = path.join(tmpDir, 'graphql-introspection.mjs');
  await writeFile(
    outputPath,
    compiled.outputText.replace(
      /from ['"]\.\/trace-registration['"]/g,
      "from './trace-registration.mjs'",
    ),
    'utf8',
  );
  const mod = await import(pathToFileURL(outputPath).href);
  return {
    normalizeGraphQLEndpoint: mod.normalizeGraphQLEndpoint,
    prepareGraphQLIntrospection: mod.prepareGraphQLIntrospection,
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

  const capabilitiesSourcePath = path.join(
    repoRoot,
    'src/shared/xgen-capabilities.ts',
  );
  const capabilitiesCompiled = ts.transpileModule(
    await readFile(capabilitiesSourcePath, 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
      fileName: capabilitiesSourcePath,
    },
  );
  await writeFile(
    path.join(tmpDir, 'xgen-capabilities.mjs'),
    capabilitiesCompiled.outputText,
    'utf8',
  );

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
  const apiOutput = apiCompiled.outputText
    .replace("from './constants'", "from './constants.mjs'")
    .replace(
      "from './xgen-capabilities'",
      "from './xgen-capabilities.mjs'",
    );
  await writeFile(path.join(tmpDir, 'api.mjs'), apiOutput, 'utf8');

  const mod = await import(pathToFileURL(path.join(tmpDir, 'api.mjs')).href);
  return {
    createCollectionFromTrace: mod.createCollectionFromTrace,
    mergeCollectionFromTrace: mod.mergeCollectionFromTrace,
    listApiCollections: mod.listApiCollections,
    getApiCollection: mod.getApiCollection,
    previewOpenApiSource: mod.previewOpenApiSource,
    previewCollectionSource: mod.previewCollectionSource,
    createApiCollection: mod.createApiCollection,
    addOpenApiSource: mod.addOpenApiSource,
    addCollectionSource: mod.addCollectionSource,
    deleteApiCollection: mod.deleteApiCollection,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

async function loadXgenCapabilities() {
  const sourcePath = path.join(repoRoot, 'src/shared/xgen-capabilities.ts');
  const source = await readFile(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: sourcePath,
  });
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-capabilities-'));
  const outputPath = path.join(tmpDir, 'xgen-capabilities.mjs');
  await writeFile(outputPath, compiled.outputText, 'utf8');
  const mod = await import(pathToFileURL(outputPath).href);
  return {
    diagnoseXgenCompatibility: mod.diagnoseXgenCompatibility,
    assertXgenCompatibility: mod.assertXgenCompatibility,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

async function loadAuthProfileResolution() {
  const sourcePath = path.join(
    repoRoot,
    'src/background/auth-profile-resolution.ts',
  );
  const source = await readFile(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: sourcePath,
  });
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-auth-'));
  const outputPath = path.join(tmpDir, 'auth-profile-resolution.mjs');
  await writeFile(outputPath, compiled.outputText, 'utf8');
  const mod = await import(pathToFileURL(outputPath).href);
  return {
    canonicalAuthServiceId: mod.canonicalAuthServiceId,
    jwtUserId: mod.jwtUserId,
    xgenAuthHeaders: mod.xgenAuthHeaders,
    matchCollectionAuthProfile: mod.matchCollectionAuthProfile,
    matchExactAuthProfile: mod.matchExactAuthProfile,
    isPathfinderManagedProfile: mod.isPathfinderManagedProfile,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

async function loadPermissions() {
  const sourcePath = path.join(repoRoot, 'src/shared/permissions.ts');
  const source = await readFile(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: sourcePath,
  });
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'xgen-pathfinder-permissions-'));
  const outputPath = path.join(tmpDir, 'permissions.mjs');
  await writeFile(outputPath, compiled.outputText, 'utf8');
  const mod = await import(pathToFileURL(outputPath).href);
  return {
    requestHostPermissions: mod.requestHostPermissions,
    cleanup: () => rm(tmpDir, { recursive: true, force: true }),
  };
}

async function testFramePermissionPolicy(requestHostPermissions) {
  const originalChrome = globalThis.chrome;
  const grantedOrigins = new Set(['https://portal.customer.example/*']);
  globalThis.chrome = {
    permissions: {
      contains: async ({ origins, permissions }) => (
        permissions?.includes('cookies')
          ? false
          : (origins ?? []).every((origin) => grantedOrigins.has(origin))
      ),
      request: async ({ origins }) => {
        if (origins?.includes('https://portal.customer.example/*')) {
          grantedOrigins.add('https://portal.customer.example/*');
          return true;
        }
        return false;
      },
    },
  };
  try {
    const partial = await requestHostPermissions([
      'https://portal.customer.example/workspace',
      'https://embedded.vendor.example/frame',
    ]);
    assert.equal(partial.ready, true);
    assert.deepEqual(
      partial.missingOriginPatterns,
      ['https://embedded.vendor.example/*'],
    );

    grantedOrigins.clear();
    const deniedTop = await requestHostPermissions([
      'https://denied.customer.example/workspace',
    ]);
    assert.equal(deniedTop.ready, false);
    assert.equal(deniedTop.reason, 'host_permission_required');
  } finally {
    globalThis.chrome = originalChrome;
  }
}

function testAuthProfileResolution({
  canonicalAuthServiceId,
  jwtUserId,
  xgenAuthHeaders,
  matchCollectionAuthProfile,
  matchExactAuthProfile,
  isPathfinderManagedProfile,
}) {
  assert.equal(
    canonicalAuthServiceId('https://api-bo-dev.x2bee.com:443/path'),
    'api-bo-dev_x2bee_com',
  );

  const jwtPayload = Buffer.from(JSON.stringify({ sub: '27' }))
    .toString('base64url');
  const token = `header.${jwtPayload}.signature`;
  assert.equal(jwtUserId(token), '27');
  assert.deepEqual(xgenAuthHeaders(token), {
    Authorization: `Bearer ${token}`,
    'X-User-ID': '27',
  });
  assert.equal(jwtUserId('opaque-token'), undefined);

  const linked = matchCollectionAuthProfile('api.customer.example', [
    {
      collection_id: 'wildcard',
      domain_patterns: ['*.customer.example'],
      auth_profile_id: 'wildcard_profile',
    },
    {
      collection_id: 'exact',
      domain_patterns: ['api.customer.example'],
      auth_profile_id: 'exact_profile',
    },
  ]);
  assert.equal(linked.status, 'matched');
  assert.equal(linked.authProfileId, 'exact_profile');
  assert.equal(linked.collectionId, 'exact');

  const ambiguous = matchCollectionAuthProfile('api.customer.example', [
    {
      collection_id: 'first',
      domain_patterns: ['api.customer.example'],
      auth_profile_id: 'first_profile',
    },
    {
      collection_id: 'second',
      domain_patterns: ['api.customer.example'],
      auth_profile_id: 'second_profile',
    },
  ]);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual(ambiguous.candidateIds, ['first_profile', 'second_profile']);

  const exact = matchExactAuthProfile('api-bo-dev.x2bee.com', [
    {
      service_id: 'api_other_system',
      name: 'api other system',
      status: 'active',
    },
    {
      service_id: 'api-bo-dev_x2bee_com',
      name: 'api-bo-dev.x2bee.com (자동 생성)',
      status: 'active',
    },
  ]);
  assert.equal(exact.status, 'matched');
  assert.equal(exact.authProfileId, 'api-bo-dev_x2bee_com');

  assert.equal(
    matchExactAuthProfile('api-bo-dev.x2bee.com', [{
      service_id: 'api_unrelated',
      name: 'API shared profile',
      status: 'active',
    }]).status,
    'missing',
    'a generic shared prefix must not auto-link an unrelated auth profile',
  );
  assert.equal(
    matchExactAuthProfile('api-bo-dev.x2bee.com', [{
      service_id: 'operator_profile',
      name: 'api-bo-dev.x2bee.com (운영자 관리)',
      status: 'active',
    }]).status,
    'missing',
    'an operator-named profile must not be mistaken for the legacy auto profile',
  );
  assert.equal(
    matchExactAuthProfile('api.customer.example', [{
      service_id: 'customer_example',
      name: 'customer.example (자동 생성)',
      status: 'active',
    }]).status,
    'missing',
    'a parent-domain profile must not auto-link to an arbitrary subdomain',
  );
  assert.equal(isPathfinderManagedProfile({
    service_id: 'api-bo-dev_x2bee_com',
    name: 'api-bo-dev.x2bee.com (자동 생성)',
    status: 'active',
  }, 'api-bo-dev.x2bee.com'), true);
  assert.equal(isPathfinderManagedProfile({
    service_id: 'api-bo-dev_x2bee_com',
    name: '운영자 프로필',
    description: 'do not overwrite',
    status: 'active',
  }, 'api-bo-dev.x2bee.com'), false);
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

function testFrameCaptureEvidence(analyzeTrace, buildTraceRegistrationPayload) {
  const analysis = analyzeTrace([
    captured({
      id: 'iframe-detail',
      timestamp: 1,
      url: 'https://bo.x2bee.com/api/frame/v1/detail?itemId=10001',
      responseBody: { itemId: '10001', name: 'iframe item' },
      captureContext: {
        kind: 'subframe',
        frameId: 7,
        frameOrigin: 'https://bo.x2bee.com',
      },
    }),
  ]);
  const tool = analysis.tools[0];
  assert.deepEqual(tool.captureMetadata.frameKinds, ['subframe']);
  assert.deepEqual(tool.captureMetadata.frameOrigins, ['https://bo.x2bee.com']);
  const payload = buildTraceRegistrationPayload(
    analysis,
    analysis.tools.map((candidate) => candidate.id),
  );
  assert.deepEqual(payload.tools[0].captureMetadata.frameKinds, ['subframe']);
  assert.deepEqual(
    payload.tools[0].captureMetadata.frameOrigins,
    ['https://bo.x2bee.com'],
  );
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

function testLegacyToolRegistrationHardening({
  buildValueFreeLegacyToolContent,
  summarizeCapturedApiForCommand,
}) {
  const loginCapture = captured({
    id: 'legacy-login',
    timestamp: 10,
    method: 'POST',
    url: 'https://shop.example.com/api/login?keyword=keep&accessToken=query-secret-must-not-persist',
    requestContentType: 'application/json; charset=utf-8',
    requestMetadata: {
      bodyKind: 'json',
      fieldPaths: ['username', 'password', 'profile.email'],
      fileFields: [],
    },
    requestBody: {
      username: 'runtime-user-must-not-persist',
      password: 'runtime-password-must-not-persist',
      profile: { email: 'private@example.com' },
    },
    responseBody: {
      accessToken: 'response-token-must-not-persist',
      user: { id: 'customer-id-must-not-persist' },
    },
  });

  const content = buildValueFreeLegacyToolContent({
    function_name: 'login_tool',
    api_url: loginCapture.url,
    api_method: 'POST',
    api_header: {
      Authorization: 'Bearer header-secret-must-not-persist',
      Cookie: 'session=cookie-secret-must-not-persist',
      'Content-Type': 'application/json',
    },
    api_body: {
      type: 'object',
      properties: {
        username: { type: 'string', default: 'schema-default-must-not-persist' },
        password: { type: 'string', example: 'schema-example-must-not-persist' },
        imagined: { type: 'string', const: 'hallucinated-value-must-not-persist' },
      },
      required: ['username', 'password', 'imagined'],
    },
    static_body: {
      password: 'static-password-must-not-persist',
    },
    metadata: {
      customerEmail: 'metadata@example.com',
    },
  }, loginCapture);

  const serializedContent = JSON.stringify(content);
  assert.deepEqual(content.static_body, {});
  assert.deepEqual(content.api_header, { 'Content-Type': 'application/json' });
  assert.equal(content.api_url, 'https://shop.example.com/api/login');
  assert.equal(content.body_type, 'application/json');
  assert.deepEqual(
    Object.keys(content.api_body.properties || {}),
    ['username', 'password', 'profile'],
  );
  assert.deepEqual(content.api_body.required, ['username', 'password']);
  assert.equal(content.metadata.sample_values_persisted, false);
  assert.throws(
    () => buildValueFreeLegacyToolContent({
      function_name: 'invalid_method',
      api_url: 'https://shop.example.com/api/items',
      api_method: 'TRACE',
    }),
    /api_method is not supported/,
  );
  for (const secret of [
    'runtime-user-must-not-persist',
    'runtime-password-must-not-persist',
    'private@example.com',
    'query-secret-must-not-persist',
    'header-secret-must-not-persist',
    'cookie-secret-must-not-persist',
    'schema-default-must-not-persist',
    'schema-example-must-not-persist',
    'hallucinated-value-must-not-persist',
    'static-password-must-not-persist',
    'metadata@example.com',
  ]) {
    assert.ok(!serializedContent.includes(secret), `legacy Tool content leaked: ${secret}`);
  }

  const summary = summarizeCapturedApiForCommand(loginCapture);
  const serializedSummary = JSON.stringify(summary);
  assert.equal(summary.url, 'https://shop.example.com/api/login');
  assert.deepEqual(summary.query_param_keys, ['keyword']);
  assert.deepEqual(summary.request.field_paths, ['username', 'password', 'profile.email']);
  assert.ok(summary.response.field_paths.includes('accessToken'));
  assert.equal(summary.sample_values_persisted, false);
  assert.equal('request_body_preview' in summary, false);
  assert.equal('response_body_preview' in summary, false);
  for (const secret of [
    'runtime-user-must-not-persist',
    'runtime-password-must-not-persist',
    'private@example.com',
    'query-secret-must-not-persist',
    'response-token-must-not-persist',
    'customer-id-must-not-persist',
  ]) {
    assert.ok(!serializedSummary.includes(secret), `capture command summary leaked: ${secret}`);
  }
}

async function testSensitiveLoggingContract() {
  const useChatSource = await readFile(
    path.join(repoRoot, 'src/sidepanel/hooks/useChat.ts'),
    'utf8',
  );
  const appSource = await readFile(path.join(repoRoot, 'src/sidepanel/App.tsx'), 'utf8');
  const serviceWorkerSource = await readFile(
    path.join(repoRoot, 'src/background/service-worker.ts'),
    'utf8',
  );

  assert.doesNotMatch(useChatSource, /GET_CHAT_CONFIG 응답:',\s*config\)/);
  assert.doesNotMatch(useChatSource, /RELAY_COMMAND 전송:',\s*event\.type,\s*event\)/);
  assert.doesNotMatch(useChatSource, /intent\.parsed:',\s*ev\)/);
  assert.doesNotMatch(useChatSource, /JSON\.stringify\(plan\)/);
  assert.doesNotMatch(useChatSource, /step\.started args_resolved/);
  assert.doesNotMatch(appSource, /greeting:',\s*pageContext\.url/);
  assert.doesNotMatch(serviceWorkerSource, /RELAY_COMMAND received:',\s*event\.type,\s*event\)/);
  assert.doesNotMatch(serviceWorkerSource, /request_body_preview/);
  assert.doesNotMatch(serviceWorkerSource, /response_body_preview/);
  assert.doesNotMatch(serviceWorkerSource, /aiStaticBody\s*=\s*\{[^\n]*original/);
}

function testPlanArgumentClassification({
  findFirstMissingPlanArgument,
  findSuspiciousRuntimeArgument,
  isStepBinding,
}) {
  assert.equal(isStepBinding('${s1.body.id}'), true);
  assert.equal(isStepBinding(' ${lookup.items[0].goodsNo} '), true);
  assert.equal(isStepBinding('{customerId}'), false);

  const multiStepPlan = {
    steps: [
      {
        tool: 'create_order',
        args: {
          quantity: 0,
          enabled: false,
          tags: [],
          note: 'ready',
        },
      },
      {
        tool: 'get_order',
        args: {
          orderId: '${s1.body.id}',
          nested: { goodsNo: '${s1.body.goodsNo}' },
        },
      },
    ],
  };
  assert.equal(
    findFirstMissingPlanArgument(multiStepPlan),
    null,
    'valid prior-step bindings must not trigger a user question',
  );

  assert.deepEqual(
    findFirstMissingPlanArgument({
      steps: [{ tool: 'create_order', args: { customer: { id: '  ' } } }],
    }),
    { tool: 'create_order', field: 'customer.id' },
  );
  assert.deepEqual(
    findFirstMissingPlanArgument({
      steps: [{ tool: 'create_order', args: { customerId: '{customerId}' } }],
    }),
    { tool: 'create_order', field: 'customerId' },
  );
  assert.equal(
    findSuspiciousRuntimeArgument({ orderId: '${s1.body.id}' }),
    'orderId',
    'an unresolved binding after HTTP failure remains a recovery candidate',
  );
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

function testManualToolContractBuilder(buildManualToolContractSource) {
  const source = buildManualToolContractSource({
    endpointUrl: 'https://api.example.com/orders/{orderId}',
    method: 'GET',
    operationId: 'getOrderDetail',
    summary: '주문 상세를 조회합니다.',
    parameters: [
      {
        name: 'includeItems',
        location: 'query',
        schemaType: 'boolean',
        required: false,
      },
    ],
    responseSchemaText: JSON.stringify({
      type: 'object',
      required: ['orderId', 'items'],
      properties: {
        orderId: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
            },
          },
        },
      },
    }),
    authType: 'bearer',
  });

  assert.equal(source.host, 'api.example.com');
  assert.equal(source.baseUrl, 'https://api.example.com');
  assert.equal(source.operationId, 'getOrderDetail');
  const operation = source.spec.paths['/orders/{orderId}'].get;
  assert.equal(operation.operationId, 'getOrderDetail');
  assert.deepEqual(
    operation.parameters.map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required,
      type: parameter.schema.type,
    })),
    [
      { name: 'includeItems', in: 'query', required: false, type: 'boolean' },
      { name: 'orderId', in: 'path', required: true, type: 'string' },
    ],
  );
  assert.equal(
    operation.responses['200'].content['application/json'].schema
      .properties.items.items.properties.sku.type,
    'string',
  );
  assert.deepEqual(operation.security, [{ pathfinderManualAuth: [] }]);
  assert.deepEqual(
    source.spec.components.securitySchemes.pathfinderManualAuth,
    { type: 'http', scheme: 'bearer' },
  );
  assert.equal(operation['x-pathfinder-source'].sample_values_persisted, false);
  assert.deepEqual(operation['x-pathfinder-source'], {
    kind: 'manual_contract',
    version: 1,
    sample_values_persisted: false,
  });

  const requestSource = buildManualToolContractSource({
    endpointUrl: 'https://api.example.com/orders',
    method: 'POST',
    summary: '주문을 생성합니다.',
    requestSchemaText: JSON.stringify({
      type: 'object',
      properties: {
        sku: { type: 'string', example: 'SKU-1' },
        quantity: { type: 'integer', default: 1 },
      },
    }),
    responseSchemaText: JSON.stringify({ type: 'object' }),
    responseStatus: '201',
    authType: 'apiKeyHeader',
    authName: 'X-API-Key',
  });
  const createOperation = requestSource.spec.paths['/orders'].post;
  assert.equal(requestSource.operationId, 'postOrders');
  assert.equal(
    createOperation.requestBody.content['application/json'].schema
      .properties.sku.example,
    undefined,
  );
  assert.equal(
    createOperation.requestBody.content['application/json'].schema
      .properties.quantity.default,
    undefined,
  );
  assert.equal(requestSource.warnings.length, 1);
  assert.deepEqual(
    requestSource.spec.components.securitySchemes.pathfinderManualAuth,
    { type: 'apiKey', in: 'header', name: 'X-API-Key' },
  );

  assert.throws(
    () => buildManualToolContractSource({
      endpointUrl: 'https://api.example.com/orders?token=secret',
      method: 'GET',
      summary: '주문 조회',
    }),
    /query 값을 넣지 말고 parameter/,
  );
  assert.throws(
    () => buildManualToolContractSource({
      endpointUrl: 'https://api.example.com/orders',
      method: 'GET',
      summary: '문의: customer@example.com',
    }),
    /개인정보 또는 인증정보/,
  );
  assert.throws(
    () => buildManualToolContractSource({
      endpointUrl: 'https://api.example.com/orders',
      method: 'GET',
      summary: 'token sk-proj-abcdefghijklmnopqrst',
    }),
    /개인정보 또는 인증정보/,
  );
  assert.throws(
    () => buildManualToolContractSource({
      endpointUrl: 'https://api.example.com/reset/Bearer%20abcdefghijk',
      method: 'GET',
      summary: '재설정 상태 조회',
    }),
    /개인정보 또는 인증정보/,
  );
  assert.throws(
    () => buildManualToolContractSource({
      endpointUrl: 'https://api.example.com/orders',
      method: 'GET',
      summary: '주문 조회',
      responseSchemaText: '{"type":"object"',
    }),
    /JSON Schema 파싱 실패/,
  );
  assert.throws(
    () => buildManualToolContractSource({
      endpointUrl: 'https://api.example.com/orders',
      method: 'GET',
      summary: '주문 조회',
      responseSchemaText: JSON.stringify({
        $ref: 'https://schemas.example.com/order.json',
      }),
    }),
    /외부 \$ref/,
  );
  assert.throws(
    () => buildManualToolContractSource({
      endpointUrl: 'https://api.example.com/orders/{orderId}',
      method: 'GET',
      summary: '주문 조회',
      parameters: [{
        name: 'otherId',
        location: 'path',
        schemaType: 'string',
      }],
    }),
    /endpoint path에 없습니다/,
  );
  assert.throws(
    () => buildManualToolContractSource({
      endpointUrl: 'https://api.example.com/orders',
      method: 'GET',
      operationId: '주문조회',
      summary: '주문 조회',
    }),
    /operationId는 영문/,
  );
}

function testPrivacySafePostmanImport(importPostmanCollection) {
  const source = importPostmanCollection({
    info: {
      name: 'Commerce API customer@example.com',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description: 'Contact customer@example.com for access.',
    },
    variable: [
      { key: 'baseUrl', value: 'https://api.customer.test/v1' },
      { key: 'accessToken', value: 'postman-token-must-not-persist' },
    ],
    auth: {
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'X-API-Key' },
        { key: 'value', value: 'postman-api-key-must-not-persist' },
        { key: 'in', value: 'header' },
      ],
    },
    event: [{
      listen: 'prerequest',
      script: { exec: ['console.log("must not persist")'] },
    }],
    item: [{
      name: 'Orders +82-10-1234-5678',
      event: [{ listen: 'test', script: { exec: ['pm.test("secret")'] } }],
      item: [
        {
          name: 'Get order customer@example.com',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/orders/:orderId?includeItems=true&accessToken=secret',
              variable: [{ key: 'orderId', value: '123456789012' }],
              query: [
                { key: 'includeItems', value: 'true' },
                { key: 'accessToken', value: 'query-secret' },
              ],
            },
            header: [
              { key: 'Accept', value: 'application/json' },
              { key: 'Authorization', value: 'Bearer header-secret' },
              { key: 'X-Tenant', value: 'tenant-secret' },
            ],
          },
          response: [{
            code: 200,
            status: 'OK',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: JSON.stringify({
              orderId: '123456789012',
              email: 'customer@example.com',
              items: [{ sku: 'SKU-SECRET', quantity: 1 }],
            }),
          }],
        },
        {
          name: 'Get order alternate',
          request: {
            method: 'GET',
            url: '{{baseUrl}}/orders/:orderId',
          },
          response: [{
            code: 200,
            status: 'OK',
            body: JSON.stringify({
              orderId: '987654321098',
              state: 'PAID',
            }),
          }],
        },
        {
          name: 'Create order',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/orders',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: {
              mode: 'raw',
              raw: JSON.stringify({
                sku: 'SKU-MUST-NOT-PERSIST',
                quantity: 2,
                password: 'body-secret',
              }),
            },
          },
          response: [{
            code: 201,
            status: 'Created',
            body: JSON.stringify({ orderId: '123456789012', accepted: true }),
          }],
        },
        {
          name: 'Upload attachment',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/orders/:orderId/files',
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'title', value: 'private title', type: 'text' },
                {
                  key: 'attachment',
                  src: '/home/customer/private.pdf',
                  type: 'file',
                  contentType: 'application/pdf',
                },
              ],
            },
          },
          response: [],
        },
        {
          name: 'Custom method',
          request: {
            method: 'PROPFIND',
            url: '{{baseUrl}}/orders',
          },
        },
      ],
    }],
  });

  assert.equal(source.summary.collectionVersion, '2.1');
  assert.equal(source.summary.totalRequests, 5);
  assert.equal(source.summary.importedOperations, 3);
  assert.equal(source.summary.mergedVariants, 1);
  assert.equal(source.summary.skippedRequests, 1);
  assert.equal(source.summary.scriptCount, 2);
  assert.ok(source.summary.issues.some((issue) => (
    issue.code === 'sensitive_query_parameter_omitted'
  )));
  assert.ok(source.summary.issues.some((issue) => (
    issue.code === 'unsupported_http_method'
  )));
  assert.ok(source.summary.issues.some((issue) => issue.code === 'scripts_not_executed'));

  const getOrder = source.spec.paths['/v1/orders/{orderId}'].get;
  assert.equal(getOrder.parameters.some((parameter) => (
    parameter.name === 'includeItems' && parameter.in === 'query'
  )), true);
  assert.equal(getOrder.parameters.some((parameter) => (
    parameter.name === 'accessToken'
  )), false);
  assert.equal(getOrder.parameters.some((parameter) => (
    parameter.name === 'Authorization'
  )), false);
  assert.equal(getOrder.parameters.some((parameter) => (
    parameter.name === 'X-Tenant' && parameter.in === 'header'
  )), true);
  assert.equal(getOrder['x-postman-variants'].length, 2);
  assert.equal(
    getOrder.responses['200'].content['application/json'].schema.oneOf.length,
    2,
  );
  assert.deepEqual(
    source.spec.components.securitySchemes['postman_apikey-header-X-API-Key'],
    { type: 'apiKey', in: 'header', name: 'X-API-Key' },
  );

  const createOrder = source.spec.paths['/v1/orders'].post;
  assert.equal(
    createOrder.requestBody.content['application/json'].schema.properties.quantity.type,
    'integer',
  );
  assert.equal(
    createOrder.requestBody.content['application/json'].schema.properties.password.type,
    'string',
  );
  const upload = source.spec.paths['/v1/orders/{orderId}/files'].post;
  assert.equal(
    upload.requestBody.content['multipart/form-data'].schema
      .properties.attachment.format,
    'binary',
  );
  assert.equal(upload.responses.default.description.includes('not saved'), true);

  const serialized = JSON.stringify(source);
  for (const secret of [
    'postman-token-must-not-persist',
    'postman-api-key-must-not-persist',
    'header-secret',
    'tenant-secret',
    'query-secret',
    'SKU-MUST-NOT-PERSIST',
    'body-secret',
    'customer@example.com',
    '+82-10-1234-5678',
    '/home/customer/private.pdf',
    'console.log',
    'pm.test',
  ]) {
    assert.ok(!serialized.includes(secret), `Postman artifact leaked ${secret}`);
  }

  assert.throws(
    () => importPostmanCollection({
      info: {
        name: 'Needs Environment',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [{
        name: 'List items',
        request: { method: 'GET', url: '{{missingBaseUrl}}/items' },
      }],
    }),
    /Base URL을 입력/,
  );
  const resolved = importPostmanCollection({
    info: {
      name: 'Needs Environment',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [{
      name: 'List items',
      request: { method: 'GET', url: '{{missingBaseUrl}}/items' },
    }],
  }, {
    baseUrlOverride: 'https://override.example/api',
  });
  assert.ok(resolved.spec.paths['/api/items'].get);

  const v20 = importPostmanCollection({
    info: {
      name: 'Postman v2 compatibility',
      schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json',
    },
    variable: [{ key: 'baseUrl', value: 'https://v20.example.test' }],
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: 'v20-bearer-must-not-persist' }],
    },
    item: [
      {
        name: 'GraphQL customer',
        request: {
          method: 'POST',
          url: '{{baseUrl}}/graphql',
          body: {
            mode: 'graphql',
            graphql: {
              query: 'query GetCustomer($id: ID!) { customer(id: $id) { id name } }',
              variables: JSON.stringify({ id: 'customer-value-must-not-persist' }),
            },
          },
        },
      },
      {
        name: 'Create session',
        request: {
          method: 'POST',
          url: '{{baseUrl}}/sessions',
          body: {
            mode: 'urlencoded',
            urlencoded: [
              { key: 'username', value: 'session-user-must-not-persist' },
              { key: 'rememberMe', value: 'true' },
            ],
          },
        },
      },
      {
        name: 'Upload raw file',
        request: {
          method: 'PUT',
          url: '{{baseUrl}}/files/:fileId',
          body: {
            mode: 'file',
            file: { src: '/private/file-must-not-persist.bin' },
          },
        },
      },
    ],
  });
  assert.equal(v20.summary.collectionVersion, '2.0');
  assert.equal(v20.summary.importedOperations, 3);
  const graphql = v20.spec.paths['/graphql'].post;
  assert.equal(graphql.operationId, 'postGetCustomer');
  assert.equal(
    graphql.requestBody.content['application/json'].schema
      .properties.variables.properties.id.type,
    'string',
  );
  assert.deepEqual(graphql.security, [{ postman_bearer: [] }]);
  assert.equal(
    v20.spec.paths['/sessions'].post.requestBody
      .content['application/x-www-form-urlencoded'].schema
      .properties.rememberMe.type,
    'string',
  );
  assert.equal(
    v20.spec.paths['/files/{fileId}'].put.requestBody
      .content['application/octet-stream'].schema.format,
    'binary',
  );
  const serializedV20 = JSON.stringify(v20);
  for (const secret of [
    'v20-bearer-must-not-persist',
    'customer-value-must-not-persist',
    'session-user-must-not-persist',
    '/private/file-must-not-persist.bin',
    'query GetCustomer',
  ]) {
    assert.ok(!serializedV20.includes(secret), `Postman v2 artifact leaked ${secret}`);
  }

  const bounded = importPostmanCollection({
    info: {
      name: 'Bounded variants',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [{
      name: 'Variant response',
      request: { method: 'GET', url: 'https://bounded.example.test/items' },
      response: Array.from({ length: 25 }, (_, index) => ({
        code: 200,
        status: 'OK',
        body: JSON.stringify({ [`field${index}`]: index }),
      })),
    }],
  });
  assert.equal(
    bounded.spec.paths['/items'].get.responses['200']
      .content['application/json'].schema.oneOf.length,
    20,
  );
  assert.ok(bounded.summary.issues.some((issue) => (
    issue.code === 'schema_variation_limit_reached'
  )));
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

function testGraphQLIntrospectionImport({
  normalizeGraphQLEndpoint,
  prepareGraphQLIntrospection,
}) {
  const imported = prepareGraphQLIntrospection({
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
              { name: 'order', args: [] },
              { name: 'orders', args: [] },
            ],
          },
          {
            kind: 'OBJECT',
            name: 'Mutation',
            fields: [{ name: 'createOrder', args: [] }],
          },
          {
            kind: 'OBJECT',
            name: 'Subscription',
            fields: [{ name: 'orderUpdated', args: [] }],
          },
        ],
      },
    },
    errors: [{
      message: 'Bearer graphql-secret-must-not-persist',
      extensions: {
        token: 'graphql-token-must-not-persist',
        email: 'customer@example.com',
      },
    }],
  }, 'https://graphql.customer.test/v1/graphql', 'schema.json');

  assert.equal(imported.endpointUrl, 'https://graphql.customer.test/v1/graphql');
  assert.equal(imported.baseUrl, 'https://graphql.customer.test');
  assert.equal(imported.host, 'graphql.customer.test');
  assert.equal(imported.sourceName, 'schema.json');
  assert.deepEqual(imported.summary, {
    queryCount: 2,
    mutationCount: 1,
    subscriptionCount: 1,
    typeCount: 3,
    omittedErrorCount: 1,
  });
  assert.equal(imported.spec.data.__schema.queryType.name, 'Query');
  const serialized = JSON.stringify(imported);
  assert.ok(!serialized.includes('graphql-secret-must-not-persist'));
  assert.ok(!serialized.includes('graphql-token-must-not-persist'));
  assert.ok(!serialized.includes('customer@example.com'));
  assert.match(serialized, /error details omitted/i);

  const rootSchema = prepareGraphQLIntrospection({
    __schema: {
      queryType: { name: 'Query' },
      types: [{ kind: 'OBJECT', name: 'Query', fields: [{ name: 'health' }] }],
    },
  }, 'http://localhost:4000/graphql');
  assert.equal(rootSchema.summary.queryCount, 1);

  assert.throws(
    () => normalizeGraphQLEndpoint(
      'https://graphql.customer.test/graphql?access_token=secret',
    ),
    /인증값/,
  );
  assert.throws(
    () => normalizeGraphQLEndpoint('file:///tmp/schema.json'),
    /HTTP 또는 HTTPS/,
  );
  assert.throws(
    () => prepareGraphQLIntrospection(
      { data: { notSchema: {} } },
      'https://graphql.customer.test/graphql',
    ),
    /표준 GraphQL introspection/,
  );
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

async function testGenericCollectionSourceApi({
  getApiCollection,
  previewCollectionSource,
  addCollectionSource,
}) {
  const observed = [];
  await withMockFetch(async (url, init) => {
    observed.push({
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers,
    });
    return new Response(JSON.stringify({
      incoming_tool_count: 2,
      conflicts: [],
      edges_before: 0,
      edges_after: 0,
      edges_added: 0,
      existing_total: 0,
      spec_hash: 'graphql-hash',
      ingest_stats: {},
      ingest_result: {
        adapter: 'graphql-introspection',
        ready: true,
        issues: [],
      },
      ingest_supported: true,
      readiness_report: null,
      tool_count: 2,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, async () => {
    await getApiCollection(
      'https://xgen.example',
      'auth-value',
      'graphql/catalog',
    );
    const source = {
      spec: { data: { __schema: { types: [] } } },
      formatHint: 'graphql-introspection',
      endpointUrl: 'https://api.example/graphql',
      requiredCapabilities: ['input_schema', 'output_schema'],
    };
    await previewCollectionSource(
      'https://xgen.example',
      'auth-value',
      source,
      { targetCollectionId: 'existing', label: 'graphql' },
    );
    await addCollectionSource(
      'https://xgen.example',
      'auth-value',
      'graphql/catalog',
      { ...source, label: 'graphql' },
    );
  });

  assert.equal(observed.length, 3);
  assert.equal(
    observed[0].url,
    'https://xgen.example/api/tools/api-collections/graphql%2Fcatalog',
  );
  assert.equal(observed[0].headers.Authorization, 'Bearer auth-value');
  assert.equal(
    observed[1].url,
    'https://xgen.example/api/tools/api-collections/preview',
  );
  assert.equal(observed[1].headers.Authorization, 'Bearer auth-value');
  assert.equal(observed[1].body.format_hint, 'graphql-introspection');
  assert.equal(observed[1].body.endpoint_url, 'https://api.example/graphql');
  assert.equal(observed[1].body.target_collection_id, 'existing');
  assert.deepEqual(
    observed[1].body.required_capabilities,
    ['input_schema', 'output_schema'],
  );
  assert.equal(
    observed[2].url,
    'https://xgen.example/api/tools/api-collections/graphql%2Fcatalog/sources',
  );
  assert.equal(observed[2].body.label, 'graphql');
  assert.equal(observed[2].body.auto_enrich, false);
}

async function testXgenCompatibilityContract({
  diagnoseXgenCompatibility,
  assertXgenCompatibility,
}) {
  const compatibleManifest = {
    contract: {
      name: 'xgen-pathfinder-api-collection',
      version: 1,
      min_client_version: 1,
      max_client_version: 1,
    },
    engine: { graph_tool_call_version: '0.33.0' },
    capabilities: {
      trace_collection_import: true,
      collection_build_status: true,
      collection_quality_summaries: true,
      collection_search: true,
      collection_plan: true,
      collection_execute: true,
      quality_lab: true,
      auth_profile_resolution: true,
    },
  };
  const compatible = await diagnoseXgenCompatibility(
    'https://xgen.example',
    'auth-value',
    {
      fetchImpl: async (url, init) => {
        assert.equal(
          String(url),
          'https://xgen.example/api/tools/api-collections/capabilities',
        );
        assert.equal(init.headers.Authorization, 'Bearer auth-value');
        return new Response(JSON.stringify(compatibleManifest), { status: 200 });
      },
    },
  );
  assert.equal(compatible.status, 'compatible');
  assert.equal(compatible.compatible, true);
  assert.equal(compatible.backendContractVersion, 1);
  assert.equal(compatible.graphToolCallVersion, '0.33.0');
  assert.doesNotThrow(() => assertXgenCompatibility(compatible));

  const missingCore = await diagnoseXgenCompatibility(
    'https://xgen.example',
    '',
    {
      fetchImpl: async () => new Response(JSON.stringify({
        ...compatibleManifest,
        capabilities: {
          ...compatibleManifest.capabilities,
          trace_collection_import: false,
        },
      }), { status: 200 }),
    },
  );
  assert.equal(missingCore.status, 'backend_outdated');
  assert.deepEqual(missingCore.missingRequiredCapabilities, [
    'trace_collection_import',
  ]);
  assert.throws(
    () => assertXgenCompatibility(missingCore),
    /XGEN backend 업데이트 필요/,
  );

  const extensionOutdated = await diagnoseXgenCompatibility(
    'https://xgen.example',
    '',
    {
      fetchImpl: async () => new Response(JSON.stringify({
        ...compatibleManifest,
        contract: {
          ...compatibleManifest.contract,
          version: 2,
          min_client_version: 2,
          max_client_version: 2,
        },
      }), { status: 200 }),
    },
  );
  assert.equal(extensionOutdated.status, 'extension_outdated');

  const legacyRequests = [];
  const legacy = await diagnoseXgenCompatibility(
    'https://legacy-xgen.example',
    '',
    {
      fetchImpl: async (url, init = {}) => {
        legacyRequests.push({ url: String(url), method: init.method || 'GET' });
        if (String(url).endsWith('/capabilities')) {
          return new Response('', { status: 404 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      },
    },
  );
  assert.equal(legacy.status, 'legacy_unverified');
  assert.equal(legacy.compatible, true);
  assert.ok(legacyRequests.every(({ method }) => method === 'GET'));
  assert.doesNotThrow(() => assertXgenCompatibility(legacy));

  const authRequired = await diagnoseXgenCompatibility(
    'https://xgen.example',
    '',
    {
      fetchImpl: async () => new Response('', { status: 401 }),
    },
  );
  assert.equal(authRequired.status, 'authentication_required');
  assert.equal(authRequired.compatible, false);
}

async function main() {
  await testManifestPermissionContract();
  const { analyzeTrace, cleanup } = await loadTraceAnalyzer();
  const {
    buildTraceRegistrationPayload,
    cleanup: cleanupRegistration,
  } = await loadTraceRegistration();
  const {
    cleanup: cleanupLegacyToolRegistration,
    ...legacyToolRegistration
  } = await loadLegacyToolRegistration();
  const {
    cleanup: cleanupPlanArguments,
    ...planArguments
  } = await loadPlanArguments();
  const {
    importHarArchive,
    cleanup: cleanupHarImporter,
  } = await loadHarImporter();
  const {
    buildManualToolContractSource,
    cleanup: cleanupManualToolContract,
  } = await loadManualToolContractBuilder();
  const {
    importPostmanCollection,
    cleanup: cleanupPostmanImporter,
  } = await loadPostmanImporter();
  const {
    normalizeGraphQLEndpoint,
    prepareGraphQLIntrospection,
    cleanup: cleanupGraphQLImporter,
  } = await loadGraphQLIntrospectionImporter();
  const {
    createCollectionFromTrace,
    mergeCollectionFromTrace,
    listApiCollections,
    getApiCollection,
    previewOpenApiSource,
    previewCollectionSource,
    createApiCollection,
    addOpenApiSource,
    addCollectionSource,
    deleteApiCollection,
    cleanup: cleanupApi,
  } = await loadApiClient();
  const {
    cleanup: cleanupAuthProfileResolution,
    ...authProfileResolution
  } = await loadAuthProfileResolution();
  const {
    requestHostPermissions,
    cleanup: cleanupPermissions,
  } = await loadPermissions();
  const {
    diagnoseXgenCompatibility,
    assertXgenCompatibility,
    cleanup: cleanupXgenCapabilities,
  } = await loadXgenCapabilities();
  try {
    await testXgenCompatibilityContract({
      diagnoseXgenCompatibility,
      assertXgenCompatibility,
    });
    await testFramePermissionPolicy(requestHostPermissions);
    testAuthProfileResolution(authProfileResolution);
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
    testFrameCaptureEvidence(analyzeTrace, buildTraceRegistrationPayload);
    testObservedEdges(analyzeTrace);
    testTraceRegistrationPayload(analyzeTrace, buildTraceRegistrationPayload);
    testTraceRegistrationPayloadHardening(analyzeTrace, buildTraceRegistrationPayload);
    testLegacyToolRegistrationHardening(legacyToolRegistration);
    await testSensitiveLoggingContract();
    testPlanArgumentClassification(planArguments);
    testTraceRegistrationPayloadCaps(buildTraceRegistrationPayload);
    testPrivacySafeHarImport(
      importHarArchive,
      analyzeTrace,
      buildTraceRegistrationPayload,
    );
    testHarImportValidationAndCaps(importHarArchive);
    testManualToolContractBuilder(buildManualToolContractSource);
    testPrivacySafePostmanImport(importPostmanCollection);
    testGraphQLIntrospectionImport({
      normalizeGraphQLEndpoint,
      prepareGraphQLIntrospection,
    });
    await testCollectionFromTraceApi(createCollectionFromTrace, mergeCollectionFromTrace);
    await testOpenApiCollectionApi({
      listApiCollections,
      previewOpenApiSource,
      createApiCollection,
      addOpenApiSource,
      deleteApiCollection,
    });
    await testGenericCollectionSourceApi({
      getApiCollection,
      previewCollectionSource,
      addCollectionSource,
    });
  } finally {
    await cleanup();
    await cleanupRegistration();
    await cleanupLegacyToolRegistration();
    await cleanupPlanArguments();
    await cleanupHarImporter();
    await cleanupManualToolContract();
    await cleanupPostmanImporter();
    await cleanupGraphQLImporter();
    await cleanupApi();
    await cleanupAuthProfileResolution();
    await cleanupPermissions();
    await cleanupXgenCapabilities();
  }

  console.log(
    'PathFinder verification passed: permission manifest, trace analysis, registration payload, API client.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
