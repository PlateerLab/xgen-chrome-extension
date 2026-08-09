import type { CapturedApi, ToolContent } from './api-hook-types';

const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_KEYS = 80;
const MAX_FIELD_PATHS = 100;
const MAX_KEY_CHARS = 120;
const MAX_TEXT_CHARS = 200;
const SENSITIVE_QUERY_KEY_RE = /(^|[_-])(authorization|cookie|password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|session|jwt|credential|client[_-]?secret)($|[_-])/i;

const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);
const HTTP_METHODS = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
]);

function boundedText(value: unknown, maxChars = MAX_TEXT_CHARS): string {
  return typeof value === 'string' ? value.slice(0, maxChars) : '';
}

function boundedKey(value: string): string {
  return value.slice(0, MAX_KEY_CHARS);
}

function structuralSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= MAX_SCHEMA_DEPTH) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof source.type === 'string' && JSON_SCHEMA_TYPES.has(source.type)) {
    out.type = source.type;
  }
  if (typeof source.format === 'string' && /^[a-z0-9._-]{1,40}$/i.test(source.format)) {
    out.format = source.format;
  }
  if (source.additionalProperties === false || source.additionalProperties === true) {
    out.additionalProperties = source.additionalProperties;
  }
  if (source.items && typeof source.items === 'object') {
    out.items = structuralSchema(source.items, depth + 1);
  }
  if (source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source.properties as Record<string, unknown>)
      .slice(0, MAX_SCHEMA_KEYS)) {
      properties[boundedKey(key)] = structuralSchema(child, depth + 1);
    }
    out.properties = properties;
  }
  if (Array.isArray(source.required)) {
    out.required = source.required
      .filter((item): item is string => typeof item === 'string')
      .slice(0, MAX_SCHEMA_KEYS)
      .map(boundedKey);
  }
  return out;
}

function schemaFromObservedValue(value: unknown, depth = 0): Record<string, unknown> {
  if (depth >= MAX_SCHEMA_DEPTH) return {};
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const sample = value.find((item) => item !== null);
    return {
      type: 'array',
      ...(sample === undefined ? {} : { items: schemaFromObservedValue(sample, depth + 1) }),
    };
  }
  if (typeof value === 'object') {
    const properties: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_SCHEMA_KEYS)) {
      properties[boundedKey(key)] = schemaFromObservedValue(child, depth + 1);
    }
    return { type: 'object', properties, required: [] };
  }
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'number' };
  }
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

function mergeObservedSchema(
  observed: Record<string, unknown>,
  existing: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth >= MAX_SCHEMA_DEPTH) return observed;
  const result: Record<string, unknown> = { ...observed };
  if (typeof existing.format === 'string' && observed.type === 'string') {
    result.format = existing.format;
  }

  const observedProperties = observed.properties;
  const existingProperties = existing.properties;
  if (observedProperties && typeof observedProperties === 'object' && !Array.isArray(observedProperties)) {
    const merged: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(observedProperties as Record<string, unknown>)) {
      const existingChild = existingProperties
        && typeof existingProperties === 'object'
        && !Array.isArray(existingProperties)
        ? (existingProperties as Record<string, unknown>)[key]
        : undefined;
      merged[key] = mergeObservedSchema(
        child as Record<string, unknown>,
        existingChild && typeof existingChild === 'object'
          ? existingChild as Record<string, unknown>
          : {},
        depth + 1,
      );
    }
    result.properties = merged;
    const observedKeys = new Set(Object.keys(merged));
    result.required = Array.isArray(existing.required)
      ? existing.required.filter((key): key is string => (
          typeof key === 'string' && observedKeys.has(key)
        ))
      : [];
  }

  if (
    observed.items && typeof observed.items === 'object'
    && existing.items && typeof existing.items === 'object'
  ) {
    result.items = mergeObservedSchema(
      observed.items as Record<string, unknown>,
      existing.items as Record<string, unknown>,
      depth + 1,
    );
  }
  return result;
}

export function buildValueFreeRequestSchema(
  existingSchema: unknown,
  capturedRequestBody?: string | null,
): Record<string, unknown> {
  const existing = structuralSchema(existingSchema);
  if (!capturedRequestBody) return existing;
  try {
    const observed = schemaFromObservedValue(JSON.parse(capturedRequestBody));
    return mergeObservedSchema(observed, existing);
  } catch {
    return existing;
  }
}

export function normalizeLegacyApiUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') throw new Error('api_url is required');
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('api_url must use http or https');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function safeApiHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  // Authentication and business-specific static headers require an explicit user
  // confirmation flow. The legacy picker has none, so only structural content type
  // is retained; auth headers are resolved through the linked auth profile.
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (normalized !== 'content-type' || typeof child !== 'string') continue;
    headers['Content-Type'] = safeMimeType(child);
  }
  return headers;
}

function safeMimeType(value: unknown): string {
  if (typeof value !== 'string') return 'application/json';
  const mime = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    ? mime
    : 'application/json';
}

function safeTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(120, Math.max(1, Math.round(value)))
    : 30;
}

export function buildValueFreeLegacyToolContent(
  toolData: Record<string, unknown>,
  matchedCapture?: CapturedApi,
): ToolContent {
  const apiUrl = normalizeLegacyApiUrl(toolData.api_url);
  const apiMethod = boundedText(toolData.api_method, 12).toUpperCase() || 'GET';
  if (!HTTP_METHODS.has(apiMethod)) throw new Error('api_method is not supported');
  const functionName = boundedText(toolData.function_name, 120) || 'api_tool';
  const bodyType = safeMimeType(
    matchedCapture?.requestContentType || toolData.body_type,
  );

  return {
    function_name: functionName,
    function_id: `tool_${Date.now().toString(36)}`,
    description: `${apiMethod} ${new URL(apiUrl).pathname}`.slice(0, MAX_TEXT_CHARS),
    api_url: apiUrl,
    api_method: apiMethod,
    api_header: safeApiHeaders(toolData.api_header),
    api_body: buildValueFreeRequestSchema(toolData.api_body, matchedCapture?.requestBody),
    // Legacy element-picker registration has no user confirmation step for literal values.
    // Never persist either AI-provided or captured values as static defaults.
    static_body: {},
    body_type: bodyType,
    api_timeout: safeTimeout(toolData.api_timeout),
    is_query_string: toolData.is_query_string === true,
    response_filter: toolData.response_filter === true,
    html_parser: toolData.html_parser === true,
    response_filter_path: boundedText(toolData.response_filter_path),
    response_filter_field: boundedText(toolData.response_filter_field),
    status: 'active',
    metadata: {
      source: 'pathfinder_legacy_element_picker',
      sample_values_persisted: false,
    },
  };
}

function collectFieldPaths(value: unknown, max = MAX_FIELD_PATHS): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (!path || seen.has(path) || paths.length >= max) return;
    seen.add(path);
    paths.push(path.slice(0, 500));
  };
  const walk = (node: unknown, prefix: string, depth: number) => {
    if (node == null || paths.length >= max || depth >= MAX_SCHEMA_DEPTH) return;
    if (Array.isArray(node)) {
      if (node.length === 0) add(prefix);
      for (const child of node.slice(0, 5)) walk(child, `${prefix}[]`, depth + 1);
      return;
    }
    if (typeof node !== 'object') {
      add(prefix);
      return;
    }
    const entries = Object.entries(node as Record<string, unknown>).slice(0, MAX_SCHEMA_KEYS);
    if (entries.length === 0) add(prefix);
    for (const [key, child] of entries) {
      const path = prefix ? `${prefix}.${boundedKey(key)}` : boundedKey(key);
      if (child != null && typeof child === 'object') walk(child, path, depth + 1);
      else add(path);
    }
  };
  walk(value, '', 0);
  return paths;
}

function fieldPathsFromJsonText(value?: string | null): string[] {
  if (!value) return [];
  try {
    return collectFieldPaths(JSON.parse(value));
  } catch {
    return [];
  }
}

function structuralUrl(rawUrl: string): { url: string; queryParamKeys: string[] } {
  try {
    const parsed = new URL(rawUrl);
    const queryParamKeys = [...new Set(parsed.searchParams.keys())]
      .filter((key) => !SENSITIVE_QUERY_KEY_RE.test(key))
      .slice(0, MAX_SCHEMA_KEYS)
      .map(boundedKey);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return { url: parsed.toString(), queryParamKeys };
  } catch {
    return { url: '', queryParamKeys: [] };
  }
}

export function summarizeCapturedApiForCommand(api: CapturedApi): Record<string, unknown> {
  const target = structuralUrl(api.url);
  return {
    id: api.id,
    method: api.method,
    url: target.url,
    query_param_keys: target.queryParamKeys,
    status: api.responseStatus,
    duration_ms: api.duration,
    request: {
      content_type: api.requestContentType || '',
      body_kind: api.requestMetadata?.bodyKind || (api.requestBody ? 'unknown' : 'none'),
      body_present: Boolean(api.requestBody),
      field_paths: (api.requestMetadata?.fieldPaths || fieldPathsFromJsonText(api.requestBody))
        .slice(0, MAX_FIELD_PATHS),
      file_field_paths: (api.requestMetadata?.fileFields || [])
        .map((file) => file.fieldPath)
        .slice(0, MAX_FIELD_PATHS),
    },
    response: {
      content_type: api.contentType,
      body_present: Boolean(api.responseBody),
      field_paths: fieldPathsFromJsonText(api.responseBody),
    },
    capture_context: api.captureContext
      ? {
          kind: api.captureContext.kind,
          frameId: api.captureContext.frameId,
          ...(api.captureContext.frameOrigin
            ? { frameOrigin: api.captureContext.frameOrigin }
            : {}),
        }
      : undefined,
    sample_values_persisted: false,
  };
}
