import type {
  CaptureProvenance,
  CaptureRejectionReason,
  CapturedApi,
  CapturedBodyKind,
  CapturedFileField,
  CapturedGraphqlOperation,
  CapturedRequestMetadata,
  CapturedResponseMetadata,
} from './api-hook-types';

const MAX_BODY_CHARS = 100 * 1024;
const MAX_URL_CHARS = 8 * 1024;
const MAX_HEADERS = 80;
const MAX_HEADER_NAME_CHARS = 128;
const MAX_HEADER_VALUE_CHARS = 4 * 1024;
const MAX_FIELD_PATHS = 100;
const MAX_FIELD_PATH_CHARS = 500;
const MAX_LIMITATIONS = 20;
const MAX_LIMITATION_CHARS = 120;
const MAX_FILE_FIELDS = 40;
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CAPTURE_FUTURE_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const BODY_KINDS = new Set<CapturedBodyKind>([
  'none',
  'json',
  'graphql',
  'form_urlencoded',
  'multipart',
  'text',
  'binary',
  'unknown',
]);
const GRAPHQL_OPERATION_TYPES = new Set([
  'query',
  'mutation',
  'subscription',
  'unknown',
]);

export type CaptureValidationResult =
  | { ok: true; capture: CapturedApi }
  | { ok: false; reason: CaptureRejectionReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function normalizeHttpUrl(value: unknown, baseUrl?: string): string | null {
  const raw = boundedString(value, MAX_URL_CHARS);
  if (!raw) return null;
  try {
    const parsed = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeHeaders(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const headers: Record<string, string> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_HEADERS)) {
    if (
      !key
      || key.length > MAX_HEADER_NAME_CHARS
      || typeof child !== 'string'
      || child.length > MAX_HEADER_VALUE_CHARS
    ) {
      return null;
    }
    headers[key] = child;
  }
  return headers;
}

function normalizeStringList(
  value: unknown,
  maxItems: number,
  maxChars: number,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== 'string' || item.length > maxChars) return null;
    result.push(item);
  }
  return result;
}

function normalizeFileField(value: unknown): CapturedFileField | null {
  if (!isRecord(value)) return null;
  const fieldPath = boundedString(value.fieldPath, MAX_FIELD_PATH_CHARS);
  if (!fieldPath) return null;
  const contentType = value.contentType == null
    ? undefined
    : boundedString(value.contentType, 256) ?? undefined;
  const size = value.size == null
    ? undefined
    : typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
      ? Math.min(Math.round(value.size), Number.MAX_SAFE_INTEGER)
      : undefined;
  // File names can carry customer identifiers. The schema only needs the field path,
  // MIME type and size, so the untrusted fileName value is intentionally discarded.
  return {
    fieldPath,
    ...(contentType ? { contentType } : {}),
    ...(size != null ? { size } : {}),
  };
}

function normalizeGraphql(value: unknown): CapturedGraphqlOperation | undefined {
  if (
    !isRecord(value)
    || typeof value.operationType !== 'string'
    || !GRAPHQL_OPERATION_TYPES.has(value.operationType)
  ) return undefined;
  const operationName = value.operationName == null
    ? undefined
    : boundedString(value.operationName, 160) ?? undefined;
  return {
    operationType: value.operationType as CapturedGraphqlOperation['operationType'],
    ...(operationName ? { operationName } : {}),
  };
}

function normalizeRequestMetadata(value: unknown): CapturedRequestMetadata | null {
  if (!isRecord(value) || !BODY_KINDS.has(value.bodyKind as CapturedBodyKind)) return null;
  const fieldPaths = normalizeStringList(
    value.fieldPaths,
    MAX_FIELD_PATHS,
    MAX_FIELD_PATH_CHARS,
  );
  if (!fieldPaths || !Array.isArray(value.fileFields)) return null;
  const fileFields: CapturedFileField[] = [];
  for (const raw of value.fileFields.slice(0, MAX_FILE_FIELDS)) {
    const file = normalizeFileField(raw);
    if (!file) return null;
    fileFields.push(file);
  }
  const limitations = value.limitations == null
    ? []
    : normalizeStringList(value.limitations, MAX_LIMITATIONS, MAX_LIMITATION_CHARS);
  if (!limitations) return null;
  const graphql = normalizeGraphql(value.graphql);
  if (value.graphql != null && !graphql) return null;
  return {
    bodyKind: value.bodyKind as CapturedBodyKind,
    fieldPaths,
    fileFields,
    ...(graphql ? { graphql } : {}),
    ...(limitations.length > 0 ? { limitations } : {}),
  };
}

function normalizeResponseMetadata(value: unknown): CapturedResponseMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const limitations = value.limitations == null
    ? []
    : normalizeStringList(value.limitations, MAX_LIMITATIONS, MAX_LIMITATION_CHARS);
  if (!limitations) return undefined;
  return {
    bodyCaptured: value.bodyCaptured === true,
    bodyTruncated: value.bodyTruncated === true,
    limitations,
  };
}

function normalizeBody(value: unknown): string | null | 'oversized' | 'invalid' {
  if (value == null) return null;
  if (typeof value !== 'string') return 'invalid';
  return value.length <= MAX_BODY_CHARS ? value : 'oversized';
}

function normalizeProvenance(value: unknown): CaptureProvenance {
  const transport = isRecord(value) && ['fetch', 'xhr'].includes(String(value.transport))
    ? value.transport as 'fetch' | 'xhr'
    : 'unknown';
  return {
    source: 'page_hook',
    trust: 'untrusted_page_event',
    transport,
  };
}

export function normalizeCapturedApi(
  value: unknown,
  options: { baseUrl?: string; now?: number } = {},
): CaptureValidationResult {
  if (!isRecord(value)) return { ok: false, reason: 'invalid_payload' };

  const requestBody = normalizeBody(value.requestBody);
  const responseBody = normalizeBody(value.responseBody);
  if (requestBody === 'oversized' || responseBody === 'oversized') {
    return { ok: false, reason: 'oversized_payload' };
  }
  if (requestBody === 'invalid' || responseBody === 'invalid') {
    return { ok: false, reason: 'invalid_payload' };
  }

  const url = normalizeHttpUrl(value.url, options.baseUrl);
  if (!url) return { ok: false, reason: 'unsupported_url' };

  const method = typeof value.method === 'string' ? value.method.toUpperCase() : '';
  const now = options.now ?? Date.now();
  const timestamp = value.timestamp;
  const responseStatus = value.responseStatus;
  const duration = value.duration;
  const requestHeaders = normalizeHeaders(value.requestHeaders);
  const responseHeaders = normalizeHeaders(value.responseHeaders);
  const requestMetadata = value.requestMetadata == null
    ? undefined
    : normalizeRequestMetadata(value.requestMetadata);
  const responseMetadata = normalizeResponseMetadata(value.responseMetadata);
  const id = boundedString(value.id, 160);
  const requestContentType = value.requestContentType == null
    ? undefined
    : boundedString(value.requestContentType, 256) ?? undefined;
  const contentType = boundedString(value.contentType, 256);

  if (
    !id
    || !/^[A-Z][A-Z0-9_-]{0,15}$/.test(method)
    || typeof timestamp !== 'number'
    || !Number.isFinite(timestamp)
    || timestamp < now - MAX_CAPTURE_AGE_MS
    || timestamp > now + MAX_CAPTURE_FUTURE_MS
    || typeof responseStatus !== 'number'
    || !Number.isInteger(responseStatus)
    || responseStatus < 0
    || responseStatus > 599
    || typeof duration !== 'number'
    || !Number.isFinite(duration)
    || duration < 0
    || duration > MAX_DURATION_MS
    || !requestHeaders
    || !responseHeaders
    || (value.requestMetadata != null && !requestMetadata)
    || (value.responseMetadata != null && !responseMetadata)
    || (value.requestContentType != null && requestContentType == null)
    || contentType == null
    || (
      responseMetadata != null
      && (
        (responseMetadata.bodyCaptured && responseBody == null)
        || (!responseMetadata.bodyCaptured && responseBody != null)
      )
    )
    || (responseStatus === 0 && responseBody != null)
  ) {
    return { ok: false, reason: 'invalid_payload' };
  }

  return {
    ok: true,
    capture: {
      id,
      tabId: 0,
      timestamp,
      url,
      method,
      requestHeaders,
      requestBody,
      ...(requestContentType ? { requestContentType } : {}),
      ...(requestMetadata ? { requestMetadata } : {}),
      responseStatus,
      responseHeaders,
      responseBody,
      ...(responseMetadata ? { responseMetadata } : {}),
      contentType,
      duration,
      provenance: normalizeProvenance(value.provenance),
    },
  };
}
