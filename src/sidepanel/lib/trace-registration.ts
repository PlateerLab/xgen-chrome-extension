import type { FromTraceRequest } from '../../shared/api';
import type { TraceAnalysis } from './trace-analyzer';

const MAX_TRACE_TOOLS = 50;
const MAX_TRACE_EDGES = 200;
const MAX_QUERY_PARAM_KEYS = 80;
const MAX_QUERY_VALUE_CHARS = 500;
const MAX_SAMPLE_JSON_CHARS = 16_000;
const MAX_SAMPLE_STRING_CHARS = 2_000;
const MAX_SAMPLE_ARRAY_ITEMS = 20;
const MAX_SAMPLE_OBJECT_KEYS = 80;
const MAX_SAMPLE_DEPTH = 8;

const REDACTED_VALUE = '[REDACTED]';
const TRUNCATED_VALUE = '[TRUNCATED]';
const SENSITIVE_KEY_RE = /(^|[_-])(authorization|cookie|password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|session|jwt|credential|client[_-]?secret)($|[_-])/i;
const SENSITIVE_VALUE_PATTERNS = [
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    marker: '[REDACTED:EMAIL]',
  },
  {
    pattern: /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g,
    marker: '[REDACTED:PHONE]',
  },
  {
    pattern: /\b\d{6}[-\s]\d{7}\b/g,
    marker: '[REDACTED:IDENTIFIER]',
  },
  {
    pattern: /\b\d{12,19}\b/g,
    marker: '[REDACTED:LONG_NUMBER]',
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    marker: '[REDACTED:JWT]',
  },
] as const;

interface SampleStats {
  redacted: boolean;
  truncated: boolean;
  droppedQueryKeys: Set<string>;
}

export interface TraceRegistrationOptions {
  includeSamples?: boolean;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

function truncateString(value: string, maxChars: number, stats: SampleStats): string {
  if (value.length <= maxChars) return value;
  stats.truncated = true;
  return `${value.slice(0, maxChars)}${TRUNCATED_VALUE}`;
}

function sanitizeStringValue(value: string, maxChars: number, stats: SampleStats): string {
  let sanitized = value;
  for (const { pattern, marker } of SENSITIVE_VALUE_PATTERNS) {
    const replaced = sanitized.replace(pattern, marker);
    if (replaced !== sanitized) {
      stats.redacted = true;
      sanitized = replaced;
    }
  }
  return truncateString(sanitized, maxChars, stats);
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function valueKind(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function sanitizeSampleValue(value: unknown, stats: SampleStats, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizeStringValue(value, MAX_SAMPLE_STRING_CHARS, stats);
  if (depth >= MAX_SAMPLE_DEPTH) {
    stats.truncated = true;
    return TRUNCATED_VALUE;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SAMPLE_ARRAY_ITEMS) stats.truncated = true;
    return value
      .slice(0, MAX_SAMPLE_ARRAY_ITEMS)
      .map((item) => sanitizeSampleValue(item, stats, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_SAMPLE_OBJECT_KEYS) stats.truncated = true;
    for (const [key, child] of entries.slice(0, MAX_SAMPLE_OBJECT_KEYS)) {
      const safeKey = truncateString(key, 120, stats);
      if (isSensitiveKey(key)) {
        stats.redacted = true;
        out[safeKey] = REDACTED_VALUE;
      } else {
        out[safeKey] = sanitizeSampleValue(child, stats, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function sanitizeSample(value: unknown, stats: SampleStats): unknown {
  const sanitized = sanitizeSampleValue(value, stats);
  if (jsonLength(sanitized) <= MAX_SAMPLE_JSON_CHARS) return sanitized;

  stats.truncated = true;
  const preview = JSON.stringify(sanitized).slice(0, MAX_SAMPLE_JSON_CHARS);
  return {
    truncated: true,
    originalType: valueKind(value),
    preview,
  };
}

function sanitizeQuery(
  queryParamKeys: string[],
  querySample: Record<string, string>,
  stats: SampleStats,
): { queryParamKeys: string[]; querySample: Record<string, string> } {
  const safeKeys: string[] = [];
  const safeKeySet = new Set<string>();
  for (const key of queryParamKeys.slice(0, MAX_QUERY_PARAM_KEYS)) {
    if (isSensitiveKey(key)) {
      stats.redacted = true;
      stats.droppedQueryKeys.add(key);
      continue;
    }
    const safeKey = truncateString(key, 120, stats);
    safeKeys.push(safeKey);
    safeKeySet.add(safeKey);
  }

  const safeSample: Record<string, string> = {};
  for (const [key, value] of Object.entries(querySample)) {
    if (isSensitiveKey(key)) {
      stats.redacted = true;
      stats.droppedQueryKeys.add(key);
      continue;
    }
    const safeKey = truncateString(key, 120, stats);
    if (!safeKeySet.has(safeKey) && safeKeys.length < MAX_QUERY_PARAM_KEYS) {
      safeKeys.push(safeKey);
      safeKeySet.add(safeKey);
    }
    if (safeKeySet.has(safeKey)) {
      safeSample[safeKey] = sanitizeStringValue(String(value), MAX_QUERY_VALUE_CHARS, stats);
    }
  }

  return { queryParamKeys: safeKeys, querySample: safeSample };
}

export function buildTraceRegistrationPayload(
  analysis: TraceAnalysis,
  selectedToolIds: Iterable<string>,
  authProfileId?: string,
  options: TraceRegistrationOptions = {},
): FromTraceRequest {
  if (!analysis.primaryHost) {
    throw new Error('host를 식별할 수 없어 등록할 수 없습니다.');
  }

  const selected = new Set(selectedToolIds);
  const selectedTools = analysis.tools
    .filter((tool) => selected.has(tool.id))
    .slice(0, MAX_TRACE_TOOLS);
  const includedToolIds = new Set(selectedTools.map((tool) => tool.id));
  const includeSamples = options.includeSamples !== false;
  const selectedEdges = analysis.edges.filter(
    (edge) => includedToolIds.has(edge.fromToolId) && includedToolIds.has(edge.toToolId),
  ).slice(0, MAX_TRACE_EDGES);

  return {
    host: analysis.primaryHost,
    tools: selectedTools.map((tool) => {
      const stats: SampleStats = {
        redacted: false,
        truncated: false,
        droppedQueryKeys: new Set<string>(),
      };
      const query = sanitizeQuery(
        tool.queryParamKeys,
        includeSamples ? tool.querySample : {},
        stats,
      );
      const requestBodySample = !includeSamples || tool.requestBodySample == null
        ? undefined
        : sanitizeSample(tool.requestBodySample, stats);
      const responseSample = !includeSamples || tool.responseSample == null
        ? undefined
        : sanitizeSample(tool.responseSample, stats);
      const aiMetadata = tool.aiMetadata == null
        ? undefined
        : sanitizeSample(tool.aiMetadata, stats);
      const label = truncateString(tool.label, 200, stats);
      const sampleMeta = (stats.redacted || stats.truncated || stats.droppedQueryKeys.size > 0)
        ? {
            ...(stats.redacted ? { redacted: true } : {}),
            ...(stats.truncated ? { truncated: true } : {}),
            ...(stats.droppedQueryKeys.size > 0 ? { droppedQueryKeyCount: stats.droppedQueryKeys.size } : {}),
          }
        : undefined;

      return {
        method: tool.method,
        templatedPath: tool.templatedPath,
        pathParams: tool.pathParams.slice(0, 20),
        queryParamKeys: query.queryParamKeys,
        querySample: query.querySample,
        ...(requestBodySample !== undefined ? { requestBodySample } : {}),
        ...(responseSample !== undefined ? { responseSample } : {}),
        label,
        sampleCount: tool.sampleCount,
        ...(aiMetadata !== undefined ? { aiMetadata: aiMetadata as NonNullable<typeof tool.aiMetadata> } : {}),
        ...(sampleMeta ? { sampleMeta } : {}),
      };
    }),
    edges: selectedEdges.map((edge) => ({
      fromToolId: edge.fromToolId,
      toToolId: edge.toToolId,
      confidence: edge.confidence,
      valueEvidence: edge.valueEvidence,
    })),
    ...(authProfileId ? { authProfileId } : {}),
  };
}
