import type { PreparedOpenApiSource } from './openapi-import';
import {
  createSampleStats,
  sanitizeStringValue,
} from './trace-registration';

export type ManualHttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

export type ManualParameterLocation = 'path' | 'query' | 'header' | 'cookie';
export type ManualSchemaType = 'string' | 'integer' | 'number' | 'boolean' | 'array';
export type ManualAuthType = 'none' | 'bearer' | 'basic' | 'apiKeyHeader' | 'apiKeyQuery' | 'cookie';

export interface ManualToolParameter {
  name: string;
  location: ManualParameterLocation;
  schemaType: ManualSchemaType;
  required?: boolean;
  description?: string;
}

export interface ManualToolContractInput {
  endpointUrl: string;
  method: ManualHttpMethod;
  operationId?: string;
  summary: string;
  description?: string;
  parameters?: ManualToolParameter[];
  requestSchemaText?: string;
  responseSchemaText?: string;
  requestContentType?: string;
  responseContentType?: string;
  responseStatus?: string;
  authType?: ManualAuthType;
  authName?: string;
}

export interface ManualToolContractSource extends PreparedOpenApiSource {
  operationId: string;
  warnings: string[];
}

const MAX_SCHEMA_TEXT_CHARS = 100_000;
const MAX_SCHEMA_NODES = 2_000;
const MAX_SCHEMA_DEPTH = 24;
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const OPERATION_ID = /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/;
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/;
const RESPONSE_STATUS = /^(?:[1-5][0-9]{2}|default)$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+*-]+$/;
const SAMPLE_KEYWORDS = new Set(['example', 'examples', 'default', 'x-example']);
const MANUAL_SECRET_LITERAL_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}\b/i,
  /\bsk-(?:live-|test-|proj-)?[A-Za-z0-9_-]{12,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertNoSensitiveLiteral(value: string, label: string): void {
  const stats = createSampleStats();
  sanitizeStringValue(value, Math.max(value.length, 1), stats);
  if (
    stats.redacted
    || MANUAL_SECRET_LITERAL_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    throw new Error(`${label}에 개인정보 또는 인증정보로 보이는 값이 있습니다. 실제 값 대신 설명만 입력해주세요.`);
  }
}

function parseAbsoluteEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw.trim());
  } catch {
    throw new Error('endpoint URL은 http 또는 https 절대 URL이어야 합니다.');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('endpoint URL은 http 또는 https만 지원합니다.');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('endpoint URL에 사용자명이나 비밀번호를 포함할 수 없습니다.');
  }
  if (endpoint.search) {
    throw new Error('endpoint URL에 query 값을 넣지 말고 parameter로 선언해주세요.');
  }
  if (endpoint.hash) {
    throw new Error('endpoint URL에 fragment를 포함할 수 없습니다.');
  }
  return endpoint;
}

function words(value: string): string[] {
  return value
    .replace(/[{}]/g, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function upperCamel(value: string): string {
  return words(value)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function deriveOperationId(method: ManualHttpMethod, pathname: string): string {
  const suffix = upperCamel(pathname) || 'Root';
  return `${method.toLowerCase()}${suffix}`.slice(0, 200);
}

function templatePathname(endpoint: URL): string {
  return endpoint.pathname
    .replace(/%7B/gi, '{')
    .replace(/%7D/gi, '}') || '/';
}

function schemaForParameter(type: ManualSchemaType): Record<string, unknown> {
  if (type === 'array') {
    return { type: 'array', items: { type: 'string' } };
  }
  return { type };
}

function sanitizeSchema(
  value: unknown,
  warnings: Set<string>,
  propertyName = '',
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('JSON Schema 최상위 값은 객체여야 합니다.');
  }

  let nodes = 0;
  const visit = (current: unknown, depth: number, currentProperty: string): unknown => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) {
      throw new Error(`JSON Schema는 ${MAX_SCHEMA_NODES}개 노드 이하여야 합니다.`);
    }
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new Error(`JSON Schema 깊이는 ${MAX_SCHEMA_DEPTH} 이하여야 합니다.`);
    }
    if (Array.isArray(current)) {
      return current.map((child) => visit(child, depth + 1, currentProperty));
    }
    if (!isRecord(current)) {
      if (typeof current === 'string') {
        assertNoSensitiveLiteral(current, 'JSON Schema');
      }
      return current;
    }

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current)) {
      if (SAMPLE_KEYWORDS.has(key.toLowerCase())) {
        warnings.add('JSON Schema의 example/default 값은 개인정보 보호를 위해 제외했습니다.');
        continue;
      }
      if (key === '$ref' && typeof child === 'string' && !child.startsWith('#/')) {
        throw new Error('수동 contract의 JSON Schema는 외부 $ref를 지원하지 않습니다.');
      }
      if (
        (key === 'enum' || key === 'const')
        && /authorization|cookie|password|secret|token|api[-_]?key/i.test(currentProperty)
      ) {
        throw new Error(`민감 필드 ${currentProperty}에는 enum/const 실제 값을 넣을 수 없습니다.`);
      }
      const nextProperty = key === 'properties'
        ? currentProperty
        : currentProperty;
      if (key === 'properties' && isRecord(child)) {
        const properties: Record<string, unknown> = {};
        for (const [property, schema] of Object.entries(child)) {
          properties[property] = visit(schema, depth + 1, property);
        }
        output[key] = properties;
      } else {
        output[key] = visit(child, depth + 1, nextProperty);
      }
    }
    return output;
  };

  return visit(value, 0, propertyName) as Record<string, unknown>;
}

function parseSchemaText(
  raw: string | undefined,
  label: string,
  warnings: Set<string>,
): Record<string, unknown> | undefined {
  const text = raw?.trim() || '';
  if (!text) return undefined;
  if (text.length > MAX_SCHEMA_TEXT_CHARS) {
    throw new Error(`${label} JSON Schema는 100KB 이하여야 합니다.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label} JSON Schema 파싱 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return sanitizeSchema(parsed, warnings);
}

function normalizedMediaType(value: string | undefined, fallback: string): string {
  const mediaType = value?.trim() || fallback;
  if (!MEDIA_TYPE.test(mediaType)) {
    throw new Error(`올바르지 않은 content type입니다: ${mediaType}`);
  }
  return mediaType;
}

function normalizedStatus(value: string | undefined): string {
  const status = value?.trim() || '200';
  if (!RESPONSE_STATUS.test(status)) {
    throw new Error('response status는 100-599 또는 default여야 합니다.');
  }
  return status;
}

function securityScheme(
  authType: ManualAuthType,
  authName: string,
): Record<string, unknown> | undefined {
  if (authType === 'none') return undefined;
  if (authType === 'bearer') return { type: 'http', scheme: 'bearer' };
  if (authType === 'basic') return { type: 'http', scheme: 'basic' };

  const name = authName.trim();
  if (!name || !HTTP_TOKEN.test(name)) {
    throw new Error('API key/cookie 인증 이름은 유효한 HTTP token이어야 합니다.');
  }
  if (authType === 'apiKeyHeader') return { type: 'apiKey', in: 'header', name };
  if (authType === 'apiKeyQuery') return { type: 'apiKey', in: 'query', name };
  return { type: 'apiKey', in: 'cookie', name };
}

function normalizeParameters(
  parameters: ManualToolParameter[],
  pathNames: string[],
): Array<Record<string, unknown>> {
  const normalized = new Map<string, Record<string, unknown>>();

  for (const raw of parameters) {
    const name = raw.name.trim();
    if (!name) continue;
    if (!PARAMETER_NAME.test(name)) {
      throw new Error(`올바르지 않은 parameter 이름입니다: ${name}`);
    }
    if (raw.location === 'header' && !HTTP_TOKEN.test(name)) {
      throw new Error(`올바르지 않은 header 이름입니다: ${name}`);
    }
    const key = `${raw.location}:${name.toLowerCase()}`;
    if (normalized.has(key)) {
      throw new Error(`중복 parameter가 있습니다: ${raw.location} ${name}`);
    }
    const description = raw.description?.trim();
    if (description) assertNoSensitiveLiteral(description, `${name} 설명`);
    normalized.set(key, {
      name,
      in: raw.location,
      required: raw.location === 'path' ? true : Boolean(raw.required),
      schema: schemaForParameter(raw.schemaType),
      ...(description ? { description } : {}),
    });
  }

  for (const pathName of pathNames) {
    const key = `path:${pathName.toLowerCase()}`;
    if (!normalized.has(key)) {
      normalized.set(key, {
        name: pathName,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    }
  }

  for (const parameter of normalized.values()) {
    if (parameter.in === 'path' && !pathNames.includes(String(parameter.name))) {
      throw new Error(`path parameter {${parameter.name}}가 endpoint path에 없습니다.`);
    }
  }
  return [...normalized.values()];
}

export function buildManualToolContractSource(
  input: ManualToolContractInput,
): ManualToolContractSource {
  const endpoint = parseAbsoluteEndpoint(input.endpointUrl);
  const pathname = templatePathname(endpoint);
  let privacyPath = pathname;
  try {
    privacyPath = decodeURIComponent(pathname);
  } catch {
    throw new Error('endpoint path에 올바르지 않은 URL 인코딩이 있습니다.');
  }
  assertNoSensitiveLiteral(privacyPath, 'endpoint path');
  const summary = input.summary.trim();
  if (!summary) throw new Error('도구 설명을 입력해주세요.');
  if (summary.length > 300) throw new Error('도구 설명은 300자 이하여야 합니다.');
  assertNoSensitiveLiteral(summary, '도구 설명');

  const description = input.description?.trim() || '';
  if (description.length > 2_000) throw new Error('상세 설명은 2,000자 이하여야 합니다.');
  if (description) assertNoSensitiveLiteral(description, '상세 설명');

  const operationId = input.operationId?.trim()
    || deriveOperationId(input.method, pathname);
  if (!OPERATION_ID.test(operationId)) {
    throw new Error('operationId는 영문/밑줄로 시작하고 영문, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.');
  }

  const pathNames = [...pathname.matchAll(/\{([^}/]+)\}/g)].map((match) => match[1]);
  if (new Set(pathNames).size !== pathNames.length) {
    throw new Error('endpoint path에 중복 path parameter가 있습니다.');
  }
  for (const name of pathNames) {
    if (!PARAMETER_NAME.test(name)) {
      throw new Error(`올바르지 않은 path parameter 이름입니다: ${name}`);
    }
  }

  const warnings = new Set<string>();
  const requestSchema = parseSchemaText(input.requestSchemaText, '요청', warnings);
  const responseSchema = parseSchemaText(input.responseSchemaText, '응답', warnings);
  const requestContentType = normalizedMediaType(
    input.requestContentType,
    'application/json',
  );
  const responseContentType = normalizedMediaType(
    input.responseContentType,
    'application/json',
  );
  const responseStatus = normalizedStatus(input.responseStatus);
  const parameters = normalizeParameters(input.parameters || [], pathNames);
  const authType = input.authType || 'none';
  const authScheme = securityScheme(authType, input.authName || '');

  const operation: Record<string, unknown> = {
    operationId,
    summary,
    ...(description ? { description } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestSchema
      ? {
          requestBody: {
            required: true,
            content: {
              [requestContentType]: { schema: requestSchema },
            },
          },
        }
      : {}),
    responses: {
      [responseStatus]: {
        description: responseStatus === '204' ? 'No Content' : 'Response',
        ...(responseSchema && responseStatus !== '204'
          ? {
              content: {
                [responseContentType]: { schema: responseSchema },
              },
            }
          : {}),
      },
    },
    ...(authScheme ? { security: [{ pathfinderManualAuth: [] }] } : {}),
    'x-pathfinder-source': {
      kind: 'manual_contract',
      version: 1,
      sample_values_persisted: false,
    },
  };

  const spec: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: `${endpoint.hostname} manual tools`,
      version: '1.0.0',
      description: 'Created with Pathfinder manual tool contract editor.',
    },
    servers: [{ url: endpoint.origin }],
    paths: {
      [pathname]: {
        [input.method.toLowerCase()]: operation,
      },
    },
    ...(authScheme
      ? {
          components: {
            securitySchemes: {
              pathfinderManualAuth: authScheme,
            },
          },
        }
      : {}),
  };

  return {
    spec,
    name: `${endpoint.hostname} · ${operationId}`,
    host: endpoint.hostname,
    baseUrl: endpoint.origin,
    operationId,
    warnings: [...warnings],
  };
}
