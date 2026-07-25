import type {
  CapturedApi,
  CapturedBodyKind,
  CapturedFileField,
  CapturedRequestMetadata,
} from '../../shared/api-hook-types';
import {
  createSampleStats,
  isSensitiveKey,
  sanitizeSample,
  sanitizeStringValue,
  type SampleStats,
} from './trace-registration';

const MAX_HAR_ENTRIES = 500;
const MAX_BODY_TEXT_CHARS = 100_000;
const MAX_HEADER_VALUE_CHARS = 1_000;
const MAX_URL_VALUE_CHARS = 500;
const MAX_FIELD_PATHS = 100;

interface HarNameValue {
  name?: unknown;
  value?: unknown;
}

interface HarPostParam extends HarNameValue {
  fileName?: unknown;
  contentType?: unknown;
}

interface HarPostData {
  mimeType?: unknown;
  text?: unknown;
  params?: unknown;
}

interface HarContent {
  mimeType?: unknown;
  text?: unknown;
  encoding?: unknown;
}

interface HarEntry {
  startedDateTime?: unknown;
  time?: unknown;
  request?: {
    method?: unknown;
    url?: unknown;
    headers?: unknown;
    postData?: HarPostData;
  };
  response?: {
    status?: unknown;
    headers?: unknown;
    content?: HarContent;
  };
}

export interface HarImportSummary {
  totalEntries: number;
  importedEntries: number;
  skippedEntries: number;
  redacted: boolean;
  truncated: boolean;
  droppedSensitiveQueryKeys: number;
}

export interface HarImportResult {
  apis: CapturedApi[];
  summary: HarImportSummary;
}

export class HarImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarImportError';
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toNameValues(value: unknown): HarNameValue[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is HarNameValue => Boolean(entry && typeof entry === 'object'))
    : [];
}

function safeHeaders(value: unknown, stats: SampleStats): Record<string, string> {
  const output: Record<string, string> = {};
  for (const header of toNameValues(value).slice(0, 100)) {
    const name = asString(header.name).trim().toLowerCase();
    if (!name) continue;
    if (isSensitiveKey(name) || name === 'set-cookie' || name === 'proxy-authorization') {
      stats.redacted = true;
      continue;
    }
    output[name] = sanitizeStringValue(
      asString(header.value),
      MAX_HEADER_VALUE_CHARS,
      stats,
    );
  }
  return output;
}

function safeUrl(value: unknown, stats: SampleStats): string | null {
  const raw = asString(value);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) {
    stats.redacted = true;
    url.username = '';
    url.password = '';
  }

  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveKey(key)) {
      stats.redacted = true;
      stats.droppedQueryKeys.add(key);
      url.searchParams.delete(key);
      continue;
    }
    const values = url.searchParams.getAll(key);
    url.searchParams.delete(key);
    for (const item of values) {
      url.searchParams.append(
        key,
        sanitizeStringValue(item, MAX_URL_VALUE_CHARS, stats),
      );
    }
  }

  const safeSegments = url.pathname.split('/').map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Keep malformed percent escapes as text and sanitize them below.
    }
    return encodeURIComponent(sanitizeStringValue(decoded, MAX_URL_VALUE_CHARS, stats));
  });
  url.pathname = safeSegments.join('/');
  url.hash = '';
  return url.toString();
}

function bodyKind(contentType: string, hasBody: boolean): CapturedBodyKind {
  const mime = contentType.toLowerCase();
  if (!hasBody) return 'none';
  if (mime.includes('graphql')) return 'graphql';
  if (mime.includes('json') || mime.includes('+json')) return 'json';
  if (mime.includes('x-www-form-urlencoded')) return 'form_urlencoded';
  if (mime.includes('multipart/form-data')) return 'multipart';
  if (mime.startsWith('text/')) return 'text';
  return 'unknown';
}

function collectFieldPaths(
  value: unknown,
  prefix = '',
  output: string[] = [],
  depth = 0,
): string[] {
  if (output.length >= MAX_FIELD_PATHS || depth > 8) return output;
  if (Array.isArray(value)) {
    if (value.length === 0 && prefix) output.push(`${prefix}[]`);
    for (const item of value.slice(0, 5)) {
      collectFieldPaths(item, `${prefix}[]`, output, depth + 1);
    }
    return [...new Set(output)].slice(0, MAX_FIELD_PATHS);
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      collectFieldPaths(child, path, output, depth + 1);
      if (output.length >= MAX_FIELD_PATHS) break;
    }
    return [...new Set(output)].slice(0, MAX_FIELD_PATHS);
  }
  if (prefix) output.push(prefix);
  return [...new Set(output)].slice(0, MAX_FIELD_PATHS);
}

function parseJsonText(text: string): unknown | null {
  if (!text.trim() || text.length > MAX_BODY_TEXT_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeContentText(content: HarContent, stats: SampleStats): string {
  const text = asString(content.text);
  if (!text) return '';
  if (text.length > MAX_BODY_TEXT_CHARS) {
    stats.truncated = true;
    return '';
  }
  if (asString(content.encoding).toLowerCase() !== 'base64') return text;
  try {
    const binary = atob(text);
    if (binary.length > MAX_BODY_TEXT_CHARS) {
      stats.truncated = true;
      return '';
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    if (decoded.length > MAX_BODY_TEXT_CHARS) {
      stats.truncated = true;
      return '';
    }
    return decoded;
  } catch {
    return '';
  }
}

function safeJsonBody(
  text: string,
  stats: SampleStats,
): { serialized: string | null; value: unknown | null } {
  if (text.length > MAX_BODY_TEXT_CHARS) {
    stats.truncated = true;
    return { serialized: null, value: null };
  }
  const parsed = parseJsonText(text);
  if (parsed === null) return { serialized: null, value: null };
  const sanitized = sanitizeSample(parsed, stats);
  return {
    serialized: JSON.stringify(sanitized),
    value: sanitized,
  };
}

function safeFormBody(
  params: unknown,
  stats: SampleStats,
): {
  serialized: string | null;
  value: Record<string, unknown> | null;
  fileFields: CapturedFileField[];
} {
  if (!Array.isArray(params) || params.length === 0) {
    return { serialized: null, value: null, fileFields: [] };
  }
  const body: Record<string, unknown> = {};
  const fileFields: CapturedFileField[] = [];
  for (const rawParam of params.slice(0, 100)) {
    if (!rawParam || typeof rawParam !== 'object') continue;
    const param = rawParam as HarPostParam;
    const name = asString(param.name).slice(0, 120);
    if (!name) continue;
    if (isSensitiveKey(name)) {
      stats.redacted = true;
      body[name] = '[REDACTED]';
      continue;
    }
    const fileName = asString(param.fileName);
    if (fileName) {
      stats.redacted = true;
      const contentType = asString(param.contentType).slice(0, 200);
      fileFields.push({
        fieldPath: name,
        ...(contentType ? { contentType } : {}),
      });
      body[name] = {
        $file: true,
        ...(contentType ? { contentType } : {}),
      };
      continue;
    }
    body[name] = sanitizeStringValue(asString(param.value), 2_000, stats);
  }
  const sanitized = sanitizeSample(body, stats) as Record<string, unknown>;
  return {
    serialized: JSON.stringify(sanitized),
    value: sanitized,
    fileFields,
  };
}

function requestBody(
  postData: HarPostData | undefined,
  stats: SampleStats,
): {
  serialized: string | null;
  contentType: string;
  metadata?: CapturedRequestMetadata;
} {
  if (!postData || typeof postData !== 'object') {
    return { serialized: null, contentType: '' };
  }
  const contentType = asString(postData.mimeType).slice(0, 200);
  const kind = bodyKind(contentType, Boolean(postData.text || postData.params));
  let serialized: string | null = null;
  let value: unknown | null = null;
  let fileFields: CapturedFileField[] = [];

  if (kind === 'json' || kind === 'graphql') {
    ({ serialized, value } = safeJsonBody(asString(postData.text), stats));
  } else if (kind === 'form_urlencoded' || kind === 'multipart') {
    const form = safeFormBody(postData.params, stats);
    serialized = form.serialized;
    value = form.value;
    fileFields = form.fileFields;
    if (!serialized && kind === 'form_urlencoded') {
      const formValues: Record<string, string> = {};
      const search = new URLSearchParams(asString(postData.text));
      for (const [key, rawValue] of search.entries()) {
        if (isSensitiveKey(key)) {
          stats.redacted = true;
          continue;
        }
        formValues[key] = sanitizeStringValue(rawValue, 2_000, stats);
      }
      value = sanitizeSample(formValues, stats);
      serialized = JSON.stringify(value);
    }
  } else if (postData.text) {
    // Arbitrary text/binary HAR bodies may contain credentials and do not provide
    // reliable contract structure, so only their presence is recorded.
    stats.redacted = true;
  }

  return {
    serialized,
    contentType,
    metadata: {
      bodyKind: kind,
      fieldPaths: collectFieldPaths(value),
      fileFields,
      ...(!serialized && postData.text
        ? { limitations: ['har_unstructured_request_body_omitted'] }
        : {}),
    },
  };
}

function responseBody(
  content: HarContent | undefined,
  stats: SampleStats,
): { serialized: string | null; contentType: string } {
  if (!content || typeof content !== 'object') {
    return { serialized: null, contentType: '' };
  }
  const contentType = asString(content.mimeType).slice(0, 200);
  const kind = bodyKind(contentType, Boolean(content.text));
  if (kind !== 'json' && kind !== 'graphql') {
    if (content.text) stats.redacted = true;
    return { serialized: null, contentType };
  }
  const text = decodeContentText(content, stats);
  return {
    serialized: safeJsonBody(text, stats).serialized,
    contentType,
  };
}

function extractEntries(source: unknown): HarEntry[] {
  if (!source || typeof source !== 'object') {
    throw new HarImportError('HAR JSON 객체가 아닙니다.');
  }
  const log = (source as { log?: unknown }).log;
  if (!log || typeof log !== 'object') {
    throw new HarImportError('HAR log 객체를 찾을 수 없습니다.');
  }
  const entries = (log as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new HarImportError('HAR log.entries 배열을 찾을 수 없습니다.');
  }
  return entries.filter((entry): entry is HarEntry => Boolean(entry && typeof entry === 'object'));
}

export function importHarArchive(source: unknown, tabId = 0): HarImportResult {
  const entries = extractEntries(source);
  const stats = createSampleStats();
  const apis: CapturedApi[] = [];

  for (const [index, entry] of entries.slice(0, MAX_HAR_ENTRIES).entries()) {
    const request = entry.request;
    const response = entry.response;
    if (!request || !response) continue;
    const url = safeUrl(request.url, stats);
    const method = asString(request.method).toUpperCase();
    if (!url || !method || method === 'CONNECT') continue;

    const requestPayload = requestBody(request.postData, stats);
    const responsePayload = responseBody(response.content, stats);
    const timestamp = Date.parse(asString(entry.startedDateTime));
    apis.push({
      id: `har-${index}-${Number.isFinite(timestamp) ? timestamp : index}`,
      tabId,
      timestamp: Number.isFinite(timestamp) ? timestamp : index,
      url,
      method,
      requestHeaders: safeHeaders(request.headers, stats),
      requestBody: requestPayload.serialized,
      ...(requestPayload.contentType
        ? { requestContentType: requestPayload.contentType }
        : {}),
      ...(requestPayload.metadata ? { requestMetadata: requestPayload.metadata } : {}),
      responseStatus: asFiniteNumber(response.status),
      responseHeaders: safeHeaders(response.headers, stats),
      responseBody: responsePayload.serialized,
      contentType: responsePayload.contentType,
      duration: Math.max(0, asFiniteNumber(entry.time)),
      origin: 'user',
    });
  }

  if (entries.length > MAX_HAR_ENTRIES) stats.truncated = true;
  if (apis.length === 0) {
    throw new HarImportError('가져올 수 있는 HTTP/HTTPS 요청이 없습니다.');
  }
  return {
    apis,
    summary: {
      totalEntries: entries.length,
      importedEntries: apis.length,
      skippedEntries: entries.length - apis.length,
      redacted: stats.redacted,
      truncated: stats.truncated,
      droppedSensitiveQueryKeys: stats.droppedQueryKeys.size,
    },
  };
}
