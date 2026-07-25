import {
  API_CHAT_ENDPOINT,
  API_COLLECTION_RUN,
  API_PATHFINDER_GREET,
  API_PATHFINDER_RESOLVE,
  API_PROVIDERS_ENDPOINT,
} from './constants';
import type {
  AiChatRequest, CollectionRunEvent, CollectionRunRequest,
  PathFinderEvent, SiteInfo, SSEEvent,
} from './types';

export interface ProviderInfo {
  provider: string;
  models: string[];
  available: boolean;
}

export async function fetchProviders(
  serverUrl: string,
  token: string,
): Promise<ProviderInfo[]> {
  const url = `${serverUrl}${API_PROVIDERS_ENDPOINT}`;
  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Providers API error: ${response.status}`);
  }

  return response.json();
}

export async function* streamChat(
  serverUrl: string,
  token: string,
  request: AiChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const url = `${serverUrl}${API_CHAT_ENDPOINT}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      if (data === '[DONE]') return;

      try {
        yield JSON.parse(data) as SSEEvent;
      } catch {
        // skip malformed JSON
      }
    }
  }
}

// ── Collection: /run (Stage 1~4 통합 — NL → intent → plan → exec → response) ──

export async function* streamCollectionRun(
  serverUrl: string,
  token: string,
  collectionId: string,
  body: CollectionRunRequest,
  signal?: AbortSignal,
): AsyncGenerator<CollectionRunEvent> {
  const url = `${serverUrl}${API_COLLECTION_RUN(collectionId)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`collection run error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      try {
        yield JSON.parse(data) as CollectionRunEvent;
      } catch {
        // skip malformed JSON
      }
    }
  }
}

// ── Tool Collections ──

export interface FromTraceTool {
  method: string;
  templatedPath: string;
  pathParams: string[];
  queryParamKeys: string[];
  /** 캡처 시 본 query 값 — 호출 시 default로 사용 (enum/설정 자동 채움). */
  querySample?: Record<string, string>;
  requestBodySample?: unknown;
  responseSample?: unknown;
  label: string;
  sampleCount: number;
  aiMetadata?: {
    source?: string;
    canonical_action?: string;
    primary_resource?: string;
    one_line_summary?: string;
    when_to_use?: string;
    keywords?: string[];
    input_fields?: string[];
    output_fields?: string[];
    produces_semantics?: { semantic: string; field?: string; json_path?: string }[];
    consumes_semantics?: { semantic: string; field: string; kind?: 'data' | 'context' }[];
  };
  sampleMeta?: {
    redacted?: boolean;
    truncated?: boolean;
    droppedQueryKeyCount?: number;
  };
  /** Pathfinder 관찰 품질/transport evidence. 구버전 XGEN은 안전하게 무시한다. */
  captureMetadata?: unknown;
}

export interface FromTraceEdge {
  fromToolId: string;
  toToolId: string;
  confidence: number;
  valueEvidence?: {
    sourceFieldPath: string;
    targetFieldPath: string;
    valueType: 'string' | 'number';
  };
}

export interface FromTraceRequest {
  host: string;
  tools: FromTraceTool[];
  edges: FromTraceEdge[];
  name?: string;
  authProfileId?: string;
}

export interface FromTraceConflict {
  status: 409;
  collectionId: string;
  name: string;
  message: string;
}

export interface FromTraceSuccess {
  status: 200 | 201;
  collection: Record<string, unknown>;
}

export type FromTraceResult = FromTraceSuccess | FromTraceConflict;

export interface ApiCollectionSummary {
  collection_id: string;
  name: string;
  tool_count?: number;
  source_count?: number;
  auth_profile_id?: string | null;
}

export interface OpenApiSourceInput {
  sourceUrl?: string;
  spec?: Record<string, unknown>;
}

export interface OpenApiPreviewResult {
  incoming_tool_count: number;
  conflicts: string[];
  edges_before: number;
  edges_after: number;
  edges_added: number;
  existing_total: number;
  spec_hash: string;
  ingest_stats: Record<string, unknown>;
  ingest_result: {
    adapter?: string;
    ready?: boolean;
    issues?: Array<{
      severity?: string;
      code?: string;
      message?: string;
    }>;
    capabilities?: Record<string, unknown>;
    api_collection_execution_supported?: boolean;
  };
  ingest_supported: boolean;
  readiness_report?: {
    summary?: {
      readiness_score?: number;
      status?: string;
      tool_count?: number;
    };
    issues?: Array<{
      severity?: string;
      code?: string;
      message?: string;
    }>;
  } | null;
}

export interface CreateApiCollectionInput {
  collectionId: string;
  name: string;
  description?: string;
  baseUrl?: string;
  authProfileId?: string;
  domainPatterns?: string[];
}

export interface AddOpenApiSourceInput extends OpenApiSourceInput {
  label: string;
}

export interface MCPStationSession {
  session_id: string;
  session_name?: string;
  status?: string;
  mcp_initialized?: boolean;
  server_type?: string;
  tool_count?: number;
  is_shared?: boolean;
}

export interface MCPSourcePreview {
  incoming_tool_count: number;
  conflicts: string[];
  existing_total: number;
  ingest_supported: boolean;
  ingest_stats?: Record<string, unknown>;
  ingest_result?: {
    ready?: boolean;
    issues?: Array<{
      severity?: string;
      code?: string;
      message?: string;
    }>;
  };
  source_context?: {
    session_count?: number;
    session_ids?: string[];
  };
}

export interface MCPSourceRequest {
  label: string;
  sessionIds: string[];
  requiredCapabilities?: string[];
  autoEnrich?: boolean;
  enrichLlmSpec?: string;
}

async function apiError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null);
  const detail = body?.detail ?? body;
  const message = typeof detail === 'string'
    ? detail
    : typeof detail?.message === 'string'
      ? detail.message
      : typeof detail?.ingest_result?.issues?.[0]?.message === 'string'
        ? detail.ingest_result.issues[0].message
      : response.statusText;
  return new Error(`${fallback}: ${response.status} ${message}`.trim());
}

function authenticatedJsonHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function openApiSourceBody(source: OpenApiSourceInput): Record<string, unknown> {
  return {
    ...(source.sourceUrl ? { source_url: source.sourceUrl } : {}),
    ...(source.spec ? { spec: source.spec } : {}),
    format_hint: 'openapi',
    required_capabilities: ['input_schema', 'output_schema'],
  };
}

export async function listApiCollections(
  serverUrl: string,
  token: string,
): Promise<ApiCollectionSummary[]> {
  const response = await fetch(`${serverUrl}/api/tools/api-collections`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw await apiError(response, 'Collection 목록 조회 실패');
  return response.json();
}

export async function fetchMCPStationSessions(
  serverUrl: string,
  token: string,
): Promise<MCPStationSession[]> {
  const response = await fetch(`${serverUrl}/api/mcp/sessions`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw await apiError(response, 'MCP 세션 목록 조회 실패');
  const payload = await response.json() as
    MCPStationSession[] | { sessions?: MCPStationSession[]; options?: MCPStationSession[] };
  if (Array.isArray(payload)) return payload;
  return payload.sessions ?? payload.options ?? [];
}

function mcpSourceBody(payload: MCPSourceRequest): Record<string, unknown> {
  return {
    label: payload.label,
    session_ids: payload.sessionIds,
    required_capabilities: payload.requiredCapabilities ?? ['input_schema'],
    auto_enrich: payload.autoEnrich ?? false,
    ...(payload.enrichLlmSpec ? { enrich_llm_spec: payload.enrichLlmSpec } : {}),
  };
}

export async function previewMCPCollectionSource(
  serverUrl: string,
  token: string,
  collectionId: string,
  payload: MCPSourceRequest,
): Promise<MCPSourcePreview> {
  const response = await fetch(
    `${serverUrl}/api/tools/api-collections/${encodeURIComponent(collectionId)}/mcp-sources/preview`,
    {
      method: 'POST',
      headers: authenticatedJsonHeaders(token),
      body: JSON.stringify(mcpSourceBody(payload)),
    },
  );
  if (!response.ok) throw await apiError(response, 'MCP source 미리보기 실패');
  return response.json();
}

export async function addMCPCollectionSource(
  serverUrl: string,
  token: string,
  collectionId: string,
  payload: MCPSourceRequest,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${serverUrl}/api/tools/api-collections/${encodeURIComponent(collectionId)}/mcp-sources`,
    {
      method: 'POST',
      headers: authenticatedJsonHeaders(token),
      body: JSON.stringify(mcpSourceBody(payload)),
    },
  );
  if (!response.ok) throw await apiError(response, 'MCP source 등록 실패');
  return response.json();
}

export async function previewOpenApiSource(
  serverUrl: string,
  token: string,
  source: OpenApiSourceInput,
  options: { targetCollectionId?: string; label?: string } = {},
): Promise<OpenApiPreviewResult> {
  const response = await fetch(`${serverUrl}/api/tools/api-collections/preview`, {
    method: 'POST',
    headers: authenticatedJsonHeaders(token),
    body: JSON.stringify({
      ...openApiSourceBody(source),
      ...(options.targetCollectionId
        ? { target_collection_id: options.targetCollectionId }
        : {}),
      label: options.label || 'preview',
      on_conflict: 'prefix',
    }),
  });
  if (!response.ok) throw await apiError(response, 'OpenAPI 미리보기 실패');
  return response.json();
}

export async function createApiCollection(
  serverUrl: string,
  token: string,
  input: CreateApiCollectionInput,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${serverUrl}/api/tools/api-collections`, {
    method: 'POST',
    headers: authenticatedJsonHeaders(token),
    body: JSON.stringify({
      collection_id: input.collectionId,
      name: input.name,
      description: input.description || '',
      tags: ['pathfinder', 'openapi'],
      base_url: input.baseUrl || '',
      ...(input.authProfileId ? { auth_profile_id: input.authProfileId } : {}),
      visibility: 'private',
      domain_patterns: input.domainPatterns || [],
    }),
  });
  if (!response.ok) throw await apiError(response, 'Collection 생성 실패');
  return response.json();
}

export async function addOpenApiSource(
  serverUrl: string,
  token: string,
  collectionId: string,
  input: AddOpenApiSourceInput,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${serverUrl}/api/tools/api-collections/${encodeURIComponent(collectionId)}/sources`,
    {
      method: 'POST',
      headers: authenticatedJsonHeaders(token),
      body: JSON.stringify({
        ...openApiSourceBody(input),
        label: input.label,
        on_conflict: 'prefix',
        auto_enrich: false,
      }),
    },
  );
  if (!response.ok) throw await apiError(response, 'OpenAPI source 등록 실패');
  return response.json();
}

export async function deleteApiCollection(
  serverUrl: string,
  token: string,
  collectionId: string,
): Promise<void> {
  const response = await fetch(
    `${serverUrl}/api/tools/api-collections/${encodeURIComponent(collectionId)}`,
    {
      method: 'DELETE',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!response.ok) throw await apiError(response, '빈 Collection 정리 실패');
}

function buildFromTraceBody(payload: FromTraceRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    host: payload.host,
    tools: payload.tools,
    edges: payload.edges,
  };
  if (payload.name) body.name = payload.name;
  if (payload.authProfileId) body.auth_profile_id = payload.authProfileId;
  return body;
}

export async function createCollectionFromTrace(
  serverUrl: string,
  token: string,
  payload: FromTraceRequest,
): Promise<FromTraceResult> {
  const url = `${serverUrl}/api/tools/api-collections/from-trace`;
  const body = buildFromTraceBody(payload);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    const detail = await response.json().catch(() => ({}));
    const d = detail?.detail ?? detail;
    return {
      status: 409,
      collectionId: d?.collection_id ?? '',
      name: d?.name ?? '',
      message: d?.message ?? d?.hint ?? `Conflict: ${response.statusText}`,
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Collection create failed: ${response.status} ${text}`);
  }
  const json = await response.json();
  return { status: 201, collection: json };
}

export async function mergeCollectionFromTrace(
  serverUrl: string,
  token: string,
  collectionId: string,
  payload: FromTraceRequest,
): Promise<FromTraceSuccess> {
  const encodedCollectionId = encodeURIComponent(collectionId);
  const url = `${serverUrl}/api/tools/api-collections/${encodedCollectionId}/from-trace`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(buildFromTraceBody(payload)),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Collection merge failed: ${response.status} ${text}`);
  }
  const json = await response.json();
  return { status: 200, collection: json };
}

// ── PathFinder ──

export async function resolveSite(
  serverUrl: string,
  token: string,
  url: string,
): Promise<SiteInfo> {
  const endpoint = `${serverUrl}${API_PATHFINDER_RESOLVE}?url=${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`PathFinder resolve error: ${response.status}`);
  }
  return response.json();
}

export async function* streamGreet(
  serverUrl: string,
  token: string,
  url: string,
  options?: { provider?: string; model?: string; topK?: number; signal?: AbortSignal },
): AsyncGenerator<PathFinderEvent> {
  const endpoint = `${serverUrl}${API_PATHFINDER_GREET}`;
  const body: Record<string, unknown> = { url };
  if (options?.provider) body.provider = options.provider;
  if (options?.model) body.model = options.model;
  if (options?.topK) body.top_k = options.topK;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`PathFinder greet error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      try {
        yield JSON.parse(data) as PathFinderEvent;
      } catch {
        // skip malformed JSON
      }
    }
  }
}
