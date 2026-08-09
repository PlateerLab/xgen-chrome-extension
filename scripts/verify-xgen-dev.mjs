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
const runCollectionFlow = process.env.PATHFINDER_XGEN_RUN_COLLECTION_FLOW === '1';
const runExecute = process.env.PATHFINDER_XGEN_RUN_EXECUTE === '1';
const runWorkflow = process.env.PATHFINDER_XGEN_RUN_WORKFLOW === '1';
const testGraphQL = process.env.PATHFINDER_XGEN_TEST_GRAPHQL === '1';
const keepCollection = process.env.PATHFINDER_XGEN_KEEP_COLLECTION === '1';
const testTrace = runCollectionFlow
  && process.env.PATHFINDER_XGEN_TEST_TRACE !== '0';
const requiredBackendCapabilities = [
  'trace_collection_import',
  'collection_build_status',
];
const desiredBackendCapabilities = [
  ...requiredBackendCapabilities,
  'collection_quality_summaries',
  'collection_search',
  'collection_plan',
  'collection_execute',
  'quality_lab',
  'auth_profile_resolution',
];

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

async function verifyCapabilityManifest(response) {
  const manifest = await response.json();
  assert.equal(
    manifest?.contract?.name,
    'xgen-pathfinder-api-collection',
    'capability manifest contract name is invalid',
  );
  assert.equal(
    manifest?.contract?.version,
    1,
    'capability manifest contract version is unsupported',
  );
  assert.ok(
    Number.isInteger(manifest?.contract?.min_client_version),
    'capability manifest min_client_version is missing',
  );
  assert.ok(
    Number.isInteger(manifest?.contract?.max_client_version),
    'capability manifest max_client_version is missing',
  );
  assert.ok(
    manifest.contract.min_client_version <= 1
      && manifest.contract.max_client_version >= 1,
    'capability manifest does not support Pathfinder contract v1',
  );

  const missingRequired = requiredBackendCapabilities.filter(
    (capability) => manifest?.capabilities?.[capability] !== true,
  );
  assert.deepEqual(
    missingRequired,
    [],
    `capability manifest is missing required features: ${missingRequired.join(', ')}`,
  );

  const missingDesired = desiredBackendCapabilities.filter(
    (capability) => manifest?.capabilities?.[capability] !== true,
  );
  const endpointContract = manifest?.endpoints?.collection_build_status;
  assert.equal(
    endpointContract?.method,
    'GET',
    'capability manifest collection_build_status method is invalid',
  );
  assert.equal(
    endpointContract?.path,
    '/api/tools/api-collections/{collection_id}',
    'capability manifest collection_build_status path is invalid',
  );

  return {
    contractVersion: manifest.contract.version,
    graphToolCallVersion: manifest?.engine?.graph_tool_call_version ?? null,
    missingDesired,
  };
}

async function jsonRequest(pathname, {
  method = 'GET',
  body,
  expected = [200],
} = {}) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method,
    headers: {
      ...requestHeaders(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (!expected.includes(response.status)) {
    throw new Error(
      `${method} ${pathname}: expected ${expected.join('/')}, got `
      + `${response.status}`,
    );
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  assert.match(contentType, /json/i, `${method} ${pathname}: expected JSON response`);
  return response.json();
}

function openApiAcceptanceFixture() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Pathfinder T2 Read-only Acceptance',
      version: '1.0.0',
    },
    servers: [{ url: serverUrl }],
    paths: {
      '/api/health': {
        get: {
          operationId: 'getPathfinderT2Health',
          summary: 'Get the XGEN service health status',
          tags: ['operations'],
          responses: {
            200: {
              description: 'Service health',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function graphQLAcceptanceFixture() {
  return {
    data: {
      __schema: {
        queryType: { name: 'Query' },
        mutationType: null,
        subscriptionType: null,
        types: [
          {
            kind: 'OBJECT',
            name: 'Query',
            fields: [{
              name: 'health',
              description: 'Get service health',
              args: [],
              type: { kind: 'OBJECT', name: 'Health' },
              isDeprecated: false,
              deprecationReason: null,
            }],
            interfaces: [],
          },
          {
            kind: 'OBJECT',
            name: 'Health',
            fields: [{
              name: 'status',
              args: [],
              type: { kind: 'SCALAR', name: 'String' },
              isDeprecated: false,
              deprecationReason: null,
            }],
            interfaces: [],
          },
          { kind: 'SCALAR', name: 'String' },
        ],
        directives: [],
      },
    },
  };
}

function traceAcceptanceFixture() {
  return {
    host: new URL(serverUrl).hostname,
    tools: [{
      method: 'GET',
      templatedPath: '/api/health',
      pathParams: [],
      queryParamKeys: [],
      querySample: {},
      responseSample: { status: 'ok' },
      label: 'XGEN 서비스 health 상태 조회',
      sampleCount: 1,
      aiMetadata: {
        source: 'pathfinder_trace',
        canonical_action: 'read',
        primary_resource: 'health',
        one_line_summary: 'Read the XGEN service health status',
        when_to_use: 'Use when checking whether the XGEN service is available',
        output_fields: ['status'],
      },
      sampleMeta: {
        redacted: false,
        truncated: false,
        droppedQueryKeyCount: 0,
      },
      captureMetadata: {
        protocol: 'http',
        requestContentTypes: [],
        responseContentTypes: ['application/json'],
        requestBodyKinds: [],
        responseEnvelopePaths: [],
        requestSchemaVariants: [],
        responseSchemaVariants: [{
          signature: 'shape_health_status',
          observedCount: 1,
          fields: [{ path: 'status', type: 'string' }],
        }],
        fileFields: [],
        frameKinds: ['top_frame'],
        frameOrigins: [serverUrl],
        coverageScore: 1,
        confidence: 'high',
        issues: [],
      },
    }],
    edges: [],
  };
}

async function previewSource({
  spec,
  formatHint,
  endpointUrl,
  label,
}) {
  const preview = await jsonRequest('/api/tools/api-collections/preview', {
    method: 'POST',
    body: {
      spec,
      format_hint: formatHint,
      ...(endpointUrl ? { endpoint_url: endpointUrl } : {}),
      required_capabilities: ['input_schema', 'output_schema'],
      label,
      on_conflict: 'prefix',
    },
  });
  assert.equal(preview.ingest_supported, true, `${formatHint}: ingest is not supported`);
  assert.equal(preview.ingest_result?.ready, true, `${formatHint}: adapter is not ready`);
  assert.ok(
    Number(preview.incoming_tool_count || 0) >= 1,
    `${formatHint}: expected at least one tool`,
  );
  return {
    adapter: preview.ingest_result?.adapter || 'unknown',
    toolCount: Number(preview.incoming_tool_count || 0),
    readinessStatus: preview.readiness_report?.summary?.status || null,
    readinessScore: preview.readiness_report?.summary?.readiness_score ?? null,
  };
}

async function readSseEvents(response) {
  assert.ok(response.body, 'run response did not include an SSE body');
  const text = await response.text();
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return { type: 'invalid_sse_json' };
      }
    });
}

async function runReadOnlyExecute(collectionId, target) {
  const response = await fetch(
    `${serverUrl}/api/tools/api-collections/${encodeURIComponent(collectionId)}/run`,
    {
      method: 'POST',
      headers: {
        ...requestHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requirement: 'XGEN 서비스 health 상태를 조회해줘',
        force_target: target,
        top_k: 1,
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  assert.equal(response.status, 200, `read-only execute returned ${response.status}`);
  assert.match(
    response.headers.get('content-type') || '',
    /text\/event-stream/i,
    'read-only execute must return SSE',
  );
  const events = await readSseEvents(response);
  const eventTypes = events.map((event) => event?.type).filter(Boolean);
  assert.ok(eventTypes.includes('intent.parsed'), 'execute did not emit intent.parsed');
  assert.ok(eventTypes.includes('plan.synthesized'), 'execute did not emit plan.synthesized');
  assert.ok(eventTypes.includes('step.completed'), 'execute did not complete the HTTP step');
  assert.ok(eventTypes.includes('response.generated'), 'execute did not generate a response');
  assert.ok(
    !events.some((event) => event?.type === 'error' || event?.type === 'step.failed'),
    `execute emitted a failure event: ${eventTypes.join(', ')}`,
  );
  return { eventTypes };
}

function findNodeSpec(catalog, nodeId) {
  let match = null;
  const visit = (value) => {
    if (match || value == null) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    if (value.id === nodeId && Array.isArray(value.parameters)) {
      match = value;
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(catalog);
  assert.ok(match, `live node catalog is missing ${nodeId}`);
  return structuredClone(match);
}

function workflowNode(spec, id, position) {
  return {
    id,
    position,
    data: {
      functionId: spec.functionId,
      id: spec.id,
      nodeName: spec.nodeName,
      nodeNameKo: spec.nodeNameKo,
      parameters: structuredClone(spec.parameters || []),
      inputs: structuredClone(spec.inputs || []),
      outputs: structuredClone(spec.outputs || []),
    },
  };
}

function setNodeParameter(node, parameterId, value) {
  const parameter = node.data.parameters.find((item) => item.id === parameterId);
  assert.ok(parameter, `${node.data.id} is missing parameter ${parameterId}`);
  parameter.value = value;
}

function workflowEdge(id, sourceNode, sourcePort, sourceType, targetNode, targetPort, targetType) {
  return {
    id,
    source: {
      nodeId: sourceNode,
      portId: sourcePort,
      portType: sourceType,
      type: sourceType,
    },
    target: {
      nodeId: targetNode,
      portId: targetPort,
      portType: targetType,
      type: targetType,
    },
  };
}

function eventContainsFailure(value) {
  if (Array.isArray(value)) return value.some(eventContainsFailure);
  if (!value || typeof value !== 'object') return false;
  const type = String(value.type || value.event || value.kind || '').toLowerCase();
  const status = String(value.status || '').toLowerCase();
  const level = String(value.level || '').toLowerCase();
  if (['error', 'failed', 'step.failed', 'workflow_error', 'execution_error'].includes(type)) {
    return true;
  }
  if (['error', 'failed', 'failure'].includes(status)) return true;
  if (['error', 'fatal'].includes(level)) return true;
  if (value.success === false) return true;
  if (
    Object.prototype.hasOwnProperty.call(value, 'error')
    && value.error != null
    && value.error !== ''
  ) return true;
  return Object.values(value).some(eventContainsFailure);
}

function normalizeToolIdentifier(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

async function verifyWorkflowAcceptance(collectionId, target) {
  const workflowId = `wf_pathfinder_e2e_${Date.now().toString(36)}`;
  const workflowName = 'Pathfinder API Collection Node E2E';
  let created = false;

  try {
    const catalog = await jsonRequest('/api/node/get');
    const input = workflowNode(
      findNodeSpec(catalog, 'input_string'),
      'pathfinder-input',
      { x: 0, y: 200 },
    );
    const loader = workflowNode(
      findNodeSpec(catalog, 'mcp/APICollectionLoader'),
      'pathfinder-api-collection',
      { x: 460, y: 360 },
    );
    const agent = workflowNode(
      findNodeSpec(catalog, 'agents/xgen'),
      'pathfinder-agent',
      { x: 920, y: 200 },
    );
    const output = workflowNode(
      findNodeSpec(catalog, 'tools/print_agent_output'),
      'pathfinder-output',
      { x: 1380, y: 200 },
    );

    const requirement = 'XGEN 서비스 health 상태를 실제 API로 조회해줘.';
    setNodeParameter(input, 'input_str', requirement);
    setNodeParameter(loader, 'collection_id', collectionId);
    setNodeParameter(loader, 'mode', 'direct');
    setNodeParameter(loader, 'bind_threshold', 20);
    setNodeParameter(loader, 'top_k', 3);
    setNodeParameter(agent, 'streaming', false);
    setNodeParameter(agent, 'max_tokens', 800);
    setNodeParameter(agent, 'max_iterations', 6);
    setNodeParameter(
      agent,
      'system_prompt',
      '연결된 API 도구를 반드시 호출해서 XGEN health 상태를 확인하고, '
        + '도구 실행 결과만 간결하게 답하세요.',
    );

    const workflow = {
      workflow_name: workflowName,
      workflow_id: workflowId,
      view: { x: 80, y: 160, scale: 0.72 },
      nodes: [input, loader, agent, output],
      edges: [
        workflowEdge(
          'pathfinder-input-agent',
          input.id,
          'text',
          'STR',
          agent.id,
          'text',
          'STREAM STR|STR',
        ),
        workflowEdge(
          'pathfinder-loader-agent',
          loader.id,
          'tools',
          'TOOL',
          agent.id,
          'tools',
          'TOOL',
        ),
        workflowEdge(
          'pathfinder-agent-output',
          agent.id,
          'result',
          'STR',
          output.id,
          'input_print',
          'STREAM STR|STR',
        ),
      ],
      memos: [],
      interaction_id: 'default',
      description: 'Temporary Pathfinder APICollectionLoader dev acceptance workflow',
    };

    await jsonRequest('/api/agentflow/save', {
      method: 'POST',
      expected: [200],
      body: {
        workflow_name: workflowName,
        workflow_id: workflowId,
        content: workflow,
      },
    });
    created = true;

    const saved = await jsonRequest(`/api/agentflow/load/${encodeURIComponent(workflowId)}`);
    const savedLoader = saved.nodes?.find(
      (node) => node?.data?.id === 'mcp/APICollectionLoader',
    );
    assert.ok(savedLoader, 'saved workflow lost APICollectionLoader');
    assert.equal(
      savedLoader.data.parameters?.find((item) => item.id === 'collection_id')?.value,
      collectionId,
      'saved workflow lost the collection binding',
    );
    assert.equal(saved.nodes?.length, 4, 'saved workflow node count changed');
    assert.equal(saved.edges?.length, 3, 'saved workflow edge count changed');

    const response = await fetch(`${serverUrl}/api/agentflow/execute/based-id/stream`, {
      method: 'POST',
      headers: {
        ...requestHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow_name: workflowName,
        workflow_id: workflowId,
        input_data: requirement,
        interaction_id: `pathfinder-e2e-${Date.now().toString(36)}`,
        include_logs: true,
        include_node_status: true,
        include_tool_events: true,
        response_format: 'stream',
      }),
      signal: AbortSignal.timeout(180_000),
    });
    assert.equal(response.status, 200, `workflow execute returned ${response.status}`);
    assert.match(
      response.headers.get('content-type') || '',
      /text\/event-stream/i,
      'workflow execute must return SSE',
    );
    const events = await readSseEvents(response);
    const serializedEvents = JSON.stringify(events);
    const eventTypes = events
      .map((event) => event?.type || event?.event || event?.status || event?.kind)
      .filter(Boolean);
    assert.ok(events.length > 0, 'workflow execute emitted no SSE events');
    assert.ok(
      normalizeToolIdentifier(serializedEvents).includes(normalizeToolIdentifier(target)),
      `workflow events never observed the normalized target tool ${target}`,
    );
    assert.equal(
      eventContainsFailure(events),
      false,
      'workflow emitted a structured failure event',
    );

    return {
      workflowId,
      nodeCount: saved.nodes.length,
      edgeCount: saved.edges.length,
      collectionId,
      target,
      targetObserved: true,
      eventCount: events.length,
      eventTypes: [...new Set(eventTypes)],
    };
  } finally {
    if (created) {
      await jsonRequest(`/api/agentflow/delete/${encodeURIComponent(workflowId)}`, {
        method: 'DELETE',
        expected: [200],
      });
    }
  }
}

async function verifyCollectionAcceptance() {
  const collectionId = `pathfinder-t2-${Date.now().toString(36)}`;
  const encodedId = encodeURIComponent(collectionId);
  const sourceLabel = 'pathfinder-t2-openapi';
  const openApiSpec = openApiAcceptanceFixture();
  let created = false;
  const acceptance = {
    collectionId,
    kept: keepCollection,
    previews: {},
  };

  try {
    acceptance.previews.openapi = await previewSource({
      spec: openApiSpec,
      formatHint: 'openapi',
      label: sourceLabel,
    });
    if (testGraphQL) {
      acceptance.previews.graphql = await previewSource({
        spec: graphQLAcceptanceFixture(),
        formatHint: 'graphql-introspection',
        endpointUrl: `${serverUrl}/graphql`,
        label: 'pathfinder-t2-graphql',
      });
    }

    await jsonRequest('/api/tools/api-collections', {
      method: 'POST',
      expected: [201],
      body: {
        collection_id: collectionId,
        name: 'Pathfinder T2 Read-only Acceptance',
        description: 'Temporary Pathfinder dev acceptance fixture',
        tags: ['pathfinder', 't2', 'temporary'],
        base_url: serverUrl,
        visibility: 'private',
        domain_patterns: [new URL(serverUrl).hostname],
      },
    });
    created = true;

    if (testTrace) {
      await jsonRequest(`/api/tools/api-collections/${encodedId}/from-trace`, {
        method: 'POST',
        expected: [200],
        body: traceAcceptanceFixture(),
      });
    } else {
      await jsonRequest(`/api/tools/api-collections/${encodedId}/sources`, {
        method: 'POST',
        expected: [201],
        body: {
          label: sourceLabel,
          spec: openApiSpec,
          format_hint: 'openapi',
          required_capabilities: ['input_schema', 'output_schema'],
          on_conflict: 'prefix',
          auto_enrich: false,
        },
      });
    }

    const collection = await jsonRequest(`/api/tools/api-collections/${encodedId}`);
    assert.ok(Number(collection.tool_count || 0) >= 1, 'Collection build produced no tools');
    assert.ok(Number(collection.source_count || 0) >= 1, 'Collection source was not persisted');
    assert.ok(collection.graph_tool_call_version, 'graph-tool-call version metadata is missing');
    assert.ok(collection.collection_graph_version, 'collection graph version metadata is missing');
    assert.ok(collection.readiness_summary, 'readiness summary is missing');
    assert.ok(collection.semantic_summary, 'semantic summary is missing');
    assert.ok(collection.edge_quality_summary, 'edge quality summary is missing');

    const search = await jsonRequest(
      `/api/tools/api-collections/${encodedId}/test-search`,
      {
        method: 'POST',
        body: {
          query: 'XGEN 서비스 health 상태 조회',
          top_k: 3,
          token_budget: 1000,
        },
      },
    );
    assert.ok(Array.isArray(search.results), 'search results must be an array');
    const targetResult = search.results.find(
      (result) => result?.http === 'GET /api/health',
    );
    assert.ok(targetResult?.name, 'health tool was not found in search Top-K');

    const plan = await jsonRequest(
      `/api/tools/api-collections/${encodedId}/synthesize-plan`,
      {
        method: 'POST',
        body: {
          target: targetResult.name,
          goal: 'XGEN 서비스 health 상태 조회',
          entities: {},
          max_depth: 3,
        },
      },
    );
    assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 1, 'plan has no steps');

    acceptance.collection = {
      ingestMode: testTrace ? 'pathfinder_trace' : 'openapi',
      toolCount: Number(collection.tool_count || 0),
      edgeCount: Number(collection.edge_count || 0),
      sourceCount: Number(collection.source_count || 0),
      graphToolCallVersion: collection.graph_tool_call_version,
      collectionGraphVersion: collection.collection_graph_version,
      readinessStatus: collection.readiness_summary?.status || null,
      semanticKnownActionRate:
        collection.semantic_summary?.canonical_action_known_rate ?? null,
    };
    acceptance.search = {
      resultCount: search.results.length,
      target: targetResult.name,
      targetRank: search.results.indexOf(targetResult) + 1,
      graphToolCallVersion: search.graph_tool_call_version || null,
    };
    acceptance.plan = {
      stepCount: plan.steps.length,
      target: targetResult.name,
    };
    if (runExecute) {
      acceptance.execute = await runReadOnlyExecute(collectionId, targetResult.name);
    }
    if (runWorkflow) {
      acceptance.workflow = await verifyWorkflowAcceptance(collectionId, targetResult.name);
    }
    return acceptance;
  } finally {
    if (created && !keepCollection) {
      await jsonRequest(`/api/tools/api-collections/${encodedId}`, {
        method: 'DELETE',
        expected: [204],
      });
    }
  }
}

if (!token && !allowAnonymous) {
  throw new Error(
    'PATHFINDER_XGEN_TOKEN is required. Set PATHFINDER_XGEN_ALLOW_ANONYMOUS=1 for public probes only.',
  );
}

const results = [];
results.push((await probe('/api/health')).result);

let capabilityManifest = null;
if (token) {
  for (const endpoint of contract.endpoints.filter((item) => item.devProbe)) {
    const { response, result } = await probe(endpoint.path);
    results.push(result);
    if (endpoint.id === 'collection_capabilities') {
      capabilityManifest = await verifyCapabilityManifest(response);
    }
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

let collectionAcceptance = null;
if (runExecute && !runCollectionFlow) {
  throw new Error('PATHFINDER_XGEN_RUN_EXECUTE=1 requires PATHFINDER_XGEN_RUN_COLLECTION_FLOW=1');
}
if (runWorkflow && !runCollectionFlow) {
  throw new Error('PATHFINDER_XGEN_RUN_WORKFLOW=1 requires PATHFINDER_XGEN_RUN_COLLECTION_FLOW=1');
}
if (testGraphQL && !runCollectionFlow) {
  throw new Error('PATHFINDER_XGEN_TEST_GRAPHQL=1 requires PATHFINDER_XGEN_RUN_COLLECTION_FLOW=1');
}
if (runCollectionFlow) {
  assert.ok(token, 'Collection acceptance requires PATHFINDER_XGEN_TOKEN');
  collectionAcceptance = await verifyCollectionAcceptance();
}

console.log(JSON.stringify({
  status: 'passed',
  serverOrigin: serverUrl,
  authenticated: Boolean(token),
  userIdHeaderPresent: Boolean(userId),
  openapiVerified: Boolean(openapi),
  capabilityManifest,
  probes: results,
  collectionAcceptance,
}, null, 2));
