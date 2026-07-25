import type { PreparedOpenApiSource } from './openapi-import';
import {
  createSampleStats,
  isSensitiveKey,
  sanitizeStringValue,
} from './trace-registration';

const MAX_POSTMAN_FILE_BYTES = 10 * 1024 * 1024;
const MAX_POSTMAN_ITEMS = 500;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_VARIANTS = 20;
const MAX_DESCRIPTION_CHARS = 2_000;
const SUPPORTED_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+*-]+$/;
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VARIABLE_REF = /\{\{([^{}]+)\}\}/g;

type RecordValue = Record<string, unknown>;

export interface PostmanImportIssue {
  severity: 'info' | 'warning';
  code: string;
  message: string;
  item?: string;
}

export interface PostmanImportSummary {
  collectionVersion: '2.0' | '2.1' | 'unknown';
  totalRequests: number;
  importedOperations: number;
  mergedVariants: number;
  skippedRequests: number;
  scriptCount: number;
  unresolvedVariables: string[];
  issues: PostmanImportIssue[];
}

export interface PreparedPostmanSource extends PreparedOpenApiSource {
  summary: PostmanImportSummary;
}

export interface PostmanImportOptions {
  baseUrlOverride?: string;
}

export class PostmanImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostmanImportError';
  }
}

interface RequestContext {
  folderPath: string[];
  inheritedAuth?: RecordValue | null;
}

interface NormalizedRequest {
  name: string;
  description: string;
  method: string;
  serverUrl: string;
  path: string;
  parameters: RecordValue[];
  requestBody?: RecordValue;
  responses: Record<string, RecordValue>;
  auth?: RecordValue | null;
  folderPath: string[];
  scriptCount: number;
  graphqlOperationName?: string;
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function descriptionText(value: unknown): string {
  const raw = typeof value === 'string'
    ? value
    : isRecord(value) && typeof value.content === 'string'
      ? value.content
      : '';
  if (!raw) return '';
  const stats = createSampleStats();
  return sanitizeStringValue(raw, MAX_DESCRIPTION_CHARS, stats);
}

function safeDisplayText(value: unknown, fallback: string): string {
  return descriptionText(value).trim().slice(0, 300) || fallback;
}

function countEvents(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((event) => (
    isRecord(event)
    && (event.listen === 'test' || event.listen === 'prerequest')
  )).length;
}

function variableMap(value: unknown): Map<string, unknown> {
  const variables = new Map<string, unknown>();
  if (!Array.isArray(value)) return variables;
  for (const entry of value) {
    if (!isRecord(entry) || entry.disabled === true) continue;
    const key = asString(entry.key || entry.id).trim();
    if (!key || isSensitiveKey(key)) continue;
    variables.set(key, entry.value);
  }
  return variables;
}

function safeBaseUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PostmanImportError(`${label}은 http/https 절대 URL이어야 합니다.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PostmanImportError(`${label}은 http/https만 지원합니다.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PostmanImportError(`${label}에서 자격정보, query 또는 fragment를 제거해주세요.`);
  }
  return url;
}

function collectionVersion(info: RecordValue): PostmanImportSummary['collectionVersion'] {
  const schema = asString(info.schema);
  if (/\/v2\.1\.0\//.test(schema)) return '2.1';
  if (/\/v2\.0\.0\//.test(schema)) return '2.0';
  return 'unknown';
}

function detectCollectionBaseUrl(
  variables: Map<string, unknown>,
  override?: string,
): URL | undefined {
  if (override?.trim()) return safeBaseUrl(override, 'Base URL');
  const candidates = [...variables.entries()]
    .filter(([key]) => /^(?:base[_-]?url|api[_-]?url|server[_-]?url|host)$/i.test(key));
  for (const [, value] of candidates) {
    if (typeof value !== 'string') continue;
    try {
      return safeBaseUrl(value, 'Postman base URL variable');
    } catch {
      // Other candidates or an explicit UI override may still resolve the collection.
    }
  }
  return undefined;
}

function requestUrlRaw(request: RecordValue): string {
  if (typeof request.url === 'string') return request.url;
  if (!isRecord(request.url)) return '';
  if (typeof request.url.raw === 'string') return request.url.raw;

  const protocol = asString(request.url.protocol) || 'https';
  const host = Array.isArray(request.url.host)
    ? request.url.host.map(asString).filter(Boolean).join('.')
    : asString(request.url.host);
  const port = asString(request.url.port);
  const path = Array.isArray(request.url.path)
    ? request.url.path.map((part) => (
        typeof part === 'string'
          ? part
          : isRecord(part)
            ? asString(part.value)
            : ''
      )).filter(Boolean).join('/')
    : asString(request.url.path);
  return `${protocol}://${host}${port ? `:${port}` : ''}/${path}`;
}

function resolveUrlVariables(
  rawUrl: string,
  variables: Map<string, unknown>,
  baseUrl: URL | undefined,
  unresolved: Set<string>,
): string {
  let result = rawUrl.trim();
  result = result.replace(VARIABLE_REF, (match, rawName: string, offset: number) => {
    const name = rawName.trim();
    const value = variables.get(name);
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      try {
        return safeBaseUrl(value, `Postman variable ${name}`).toString().replace(/\/$/, '');
      } catch {
        unresolved.add(name);
        return match;
      }
    }
    if (offset === 0 && baseUrl) {
      return baseUrl.toString().replace(/\/$/, '');
    }
    unresolved.add(name);
    return `{${name}}`;
  });

  result = result.replace(/(^|\/):([A-Za-z_][A-Za-z0-9_.-]*)/g, '$1{$2}');
  if (/^https?:\/\/\{[^}]+\}/i.test(result) && baseUrl) {
    const slash = result.indexOf('/', result.indexOf('://') + 3);
    result = `${baseUrl.origin}${slash >= 0 ? result.slice(slash) : '/'}`;
  }
  if (result.startsWith('/') && baseUrl) {
    result = `${baseUrl.origin}${result}`;
  }
  return result;
}

function restoreTemplateBraces(pathname: string): string {
  return pathname
    .replace(/%7B/gi, '{')
    .replace(/%7D/gi, '}') || '/';
}

function templatizeLiteralIds(pathname: string): string {
  let index = 0;
  return `/${pathname.split('/').filter(Boolean).map((segment) => {
    if (/^\{[A-Za-z_][A-Za-z0-9_.-]*\}$/.test(segment)) return segment;
    const decoded = (() => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    })();
    const idLike = /^\d{6,}$/.test(decoded)
      || /^[0-9a-f]{16,}$/i.test(decoded)
      || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded)
      || /^sk-(?:live-|test-|proj-)?[A-Za-z0-9_-]{12,}$/i.test(decoded)
      || /^gh[pousr]_[A-Za-z0-9]{20,}$/i.test(decoded);
    const stats = createSampleStats();
    sanitizeStringValue(decoded, Math.max(decoded.length, 1), stats);
    if (!idLike && !stats.redacted) return segment;
    index += 1;
    return `{value${index > 1 ? index : ''}}`;
  }).join('/')}`;
}

function schemaSignature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(schemaSignature).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${schemaSignature(value[key])}`
  )).join(',')}}`;
}

function inferJsonSchema(value: unknown, depth = 0): RecordValue {
  if (depth >= MAX_SCHEMA_DEPTH) return {};
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const itemSchemas = value.slice(0, 20).map((item) => inferJsonSchema(item, depth + 1));
    const unique = [...new Map(itemSchemas.map((schema) => [
      schemaSignature(schema),
      schema,
    ])).values()];
    return {
      type: 'array',
      ...(unique.length === 1
        ? { items: unique[0] }
        : unique.length > 1
          ? { items: { oneOf: unique } }
          : { items: {} }),
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, 200);
    return {
      type: 'object',
      properties: Object.fromEntries(entries.map(([key, child]) => [
        key.slice(0, 200),
        inferJsonSchema(child, depth + 1),
      ])),
    };
  }
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'number' };
  }
  return { type: 'string' };
}

function parseJsonSchemaFromText(raw: string): RecordValue {
  try {
    return inferJsonSchema(JSON.parse(raw));
  } catch {
    return { type: 'string' };
  }
}

function headerEntries(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.filter((header): header is RecordValue => (
    isRecord(header)
    && header.disabled !== true
    && typeof header.key === 'string'
  ));
}

function headerValue(headers: RecordValue[], name: string): string {
  const header = headers.find((entry) => (
    asString(entry.key).toLowerCase() === name.toLowerCase()
  ));
  return asString(header?.value);
}

function normalizedMediaType(raw: string, fallback: string): string {
  const value = raw.split(';', 1)[0].trim();
  return MEDIA_TYPE.test(value) ? value : fallback;
}

function requestBody(body: unknown, headers: RecordValue[]): RecordValue | undefined {
  if (!isRecord(body) || body.disabled === true) return undefined;
  const mode = asString(body.mode);
  const contentType = normalizedMediaType(
    headerValue(headers, 'content-type'),
    mode === 'urlencoded'
      ? 'application/x-www-form-urlencoded'
      : mode === 'formdata'
        ? 'multipart/form-data'
        : mode === 'file'
          ? 'application/octet-stream'
          : 'application/json',
  );
  let schema: RecordValue | undefined;

  if (mode === 'raw' && typeof body.raw === 'string') {
    schema = parseJsonSchemaFromText(body.raw);
  } else if (mode === 'urlencoded' && Array.isArray(body.urlencoded)) {
    schema = {
      type: 'object',
      properties: Object.fromEntries(body.urlencoded
        .filter((entry): entry is RecordValue => (
          isRecord(entry) && entry.disabled !== true && typeof entry.key === 'string'
        ))
        .slice(0, 200)
        .map((entry) => [asString(entry.key), { type: 'string' }])),
    };
  } else if (mode === 'formdata' && Array.isArray(body.formdata)) {
    schema = {
      type: 'object',
      properties: Object.fromEntries(body.formdata
        .filter((entry): entry is RecordValue => (
          isRecord(entry) && entry.disabled !== true && typeof entry.key === 'string'
        ))
        .slice(0, 200)
        .map((entry) => [
          asString(entry.key),
          entry.type === 'file'
            ? { type: 'string', format: 'binary' }
            : { type: 'string' },
        ])),
    };
  } else if (mode === 'file') {
    schema = { type: 'string', format: 'binary' };
  } else if (mode === 'graphql' && isRecord(body.graphql)) {
    const variables = typeof body.graphql.variables === 'string'
      ? parseJsonSchemaFromText(body.graphql.variables)
      : inferJsonSchema(body.graphql.variables);
    schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        variables,
      },
      required: ['query'],
    };
  }

  if (!schema) return undefined;
  return {
    required: true,
    content: {
      [contentType]: { schema },
    },
  };
}

function graphqlOperationName(body: unknown): string | undefined {
  if (!isRecord(body) || body.mode !== 'graphql' || !isRecord(body.graphql)) return undefined;
  const query = asString(body.graphql.query);
  return query.match(/\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/)?.[1];
}

function responseMap(
  value: unknown,
  issues: PostmanImportIssue[],
  itemName: string,
): Record<string, RecordValue> {
  const responses: Record<string, RecordValue> = {};
  if (!Array.isArray(value)) return responses;

  for (const raw of value.slice(0, 50)) {
    if (!isRecord(raw)) continue;
    const code = typeof raw.code === 'number' && raw.code >= 100 && raw.code <= 599
      ? String(raw.code)
      : 'default';
    const headers = headerEntries(raw.header);
    const body = typeof raw.body === 'string' ? raw.body : '';
    const contentType = normalizedMediaType(
      headerValue(headers, 'content-type'),
      'application/json',
    );
    const schema = body ? parseJsonSchemaFromText(body) : undefined;
    const description = descriptionText(raw.status) || `HTTP ${code}`;
    const existing = responses[code];
    if (!existing) {
      responses[code] = {
        description,
        ...(schema ? { content: { [contentType]: { schema } } } : {}),
      };
      continue;
    }
    if (!schema) continue;
    const existingContent = isRecord(existing.content) ? existing.content : {};
    const media = isRecord(existingContent[contentType])
      ? existingContent[contentType] as RecordValue
      : {};
    const existingSchema = isRecord(media.schema) ? media.schema : undefined;
    const schemas = existingSchema && Array.isArray(existingSchema.oneOf)
      ? existingSchema.oneOf.filter(isRecord)
      : existingSchema
        ? [existingSchema]
        : [];
    const duplicate = schemas.some((candidate) => (
      schemaSignature(candidate) === schemaSignature(schema)
    ));
    if (!duplicate && schemas.length < MAX_SCHEMA_VARIANTS) {
      schemas.push(schema);
    } else if (
      !duplicate
      && schemas.length >= MAX_SCHEMA_VARIANTS
      && !issues.some((issue) => (
        issue.code === 'schema_variation_limit_reached' && issue.item === itemName
      ))
    ) {
      issues.push({
        severity: 'warning',
        code: 'schema_variation_limit_reached',
        message: `response schema variation은 status별 ${MAX_SCHEMA_VARIANTS}개까지만 보존합니다.`,
        item: itemName,
      });
    }
    existing.content = {
      ...existingContent,
      [contentType]: {
        schema: schemas.length === 1 ? schemas[0] : { oneOf: schemas },
      },
    };
  }
  return responses;
}

function queryParameters(
  request: RecordValue,
  parsedUrl: URL,
  issues: PostmanImportIssue[],
  itemName: string,
): RecordValue[] {
  const entries: RecordValue[] = isRecord(request.url) && Array.isArray(request.url.query)
    ? request.url.query.filter((entry): entry is RecordValue => (
        isRecord(entry) && entry.disabled !== true && typeof entry.key === 'string'
      ))
    : [...new Set([...parsedUrl.searchParams.keys()])].map((key) => ({ key }));

  return entries.flatMap((entry) => {
    const key = asString(entry.key).trim();
    if (!key) return [];
    if (isSensitiveKey(key)) {
      issues.push({
        severity: 'warning',
        code: 'sensitive_query_parameter_omitted',
        message: `민감 query parameter ${key}는 auth 요구사항으로 별도 확인해야 합니다.`,
        item: itemName,
      });
      return [];
    }
    return [{
      name: key,
      in: 'query',
      required: false,
      schema: { type: 'string' },
      ...(descriptionText(entry.description)
        ? { description: descriptionText(entry.description) }
        : {}),
    }];
  });
}

function pathParameters(path: string, request: RecordValue): RecordValue[] {
  const declared = new Map<string, RecordValue>();
  if (isRecord(request.url) && Array.isArray(request.url.variable)) {
    for (const variable of request.url.variable) {
      if (!isRecord(variable) || variable.disabled === true) continue;
      const name = asString(variable.key || variable.id).trim();
      if (!name) continue;
      declared.set(name, {
        name,
        in: 'path',
        required: true,
        schema: {
          type: ['number', 'boolean'].includes(asString(variable.type))
            ? asString(variable.type)
            : 'string',
        },
        ...(descriptionText(variable.description)
          ? { description: descriptionText(variable.description) }
          : {}),
      });
    }
  }
  for (const match of path.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g)) {
    if (!declared.has(match[1])) {
      declared.set(match[1], {
        name: match[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    }
  }
  return [...declared.values()];
}

function headerParameters(headers: RecordValue[]): RecordValue[] {
  return headers.flatMap((entry) => {
    const name = asString(entry.key).trim();
    const lower = name.toLowerCase();
    if (
      !name
      || ['content-type', 'accept', 'authorization', 'cookie'].includes(lower)
      || isSensitiveKey(name)
    ) {
      return [];
    }
    return [{
      name,
      in: 'header',
      required: false,
      schema: { type: 'string' },
      ...(descriptionText(entry.description)
        ? { description: descriptionText(entry.description) }
        : {}),
    }];
  });
}

function authAttributes(auth: RecordValue): Map<string, unknown> {
  const type = asString(auth.type);
  const entries = Array.isArray(auth[type]) ? auth[type] : [];
  return new Map(entries.filter(isRecord).map((entry) => [
    asString(entry.key),
    entry.value,
  ]));
}

function authSecurity(
  auth: RecordValue | null | undefined,
  schemes: Record<string, RecordValue>,
  issues: PostmanImportIssue[],
  itemName: string,
): RecordValue[] | undefined {
  if (!auth || auth.type === 'noauth') return undefined;
  const type = asString(auth.type);
  const attributes = authAttributes(auth);
  let scheme: RecordValue | undefined;
  let identity = type;

  if (type === 'bearer' || type === 'oauth2') {
    scheme = { type: 'http', scheme: 'bearer' };
    identity = 'bearer';
    if (type === 'oauth2') {
      issues.push({
        severity: 'info',
        code: 'oauth2_flow_not_imported',
        message: 'OAuth2 token 값과 flow 설정은 저장하지 않고 Bearer 요구사항만 보존했습니다.',
        item: itemName,
      });
    }
  } else if (type === 'basic') {
    scheme = { type: 'http', scheme: 'basic' };
  } else if (type === 'digest') {
    scheme = { type: 'http', scheme: 'digest' };
  } else if (type === 'apikey') {
    const name = asString(attributes.get('key')).trim();
    const location = asString(attributes.get('in')).toLowerCase();
    if (
      name
      && name.length <= 120
      && (location !== 'header' || HTTP_TOKEN.test(name))
      && ['header', 'query'].includes(location)
    ) {
      scheme = { type: 'apiKey', in: location, name };
      identity = `apikey-${location}-${name}`;
    }
  }

  if (!scheme) {
    issues.push({
      severity: 'warning',
      code: 'unsupported_auth_type',
      message: `Postman auth ${type || 'unknown'}은 자동 변환하지 않았습니다.`,
      item: itemName,
    });
    return undefined;
  }
  const schemeName = `postman_${identity}`
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .slice(0, 100);
  schemes[schemeName] = scheme;
  return [{ [schemeName]: [] }];
}

function operationIdBase(name: string, method: string, path: string): string {
  const words = `${method} ${name || path}`
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const camel = words.map((word, index) => (
    index === 0
      ? word.toLowerCase()
      : word.charAt(0).toUpperCase() + word.slice(1)
  )).join('');
  return (/^[A-Za-z_]/.test(camel) ? camel : `operation${camel}`).slice(0, 180);
}

function uniqueOperationId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix += 1;
  const result = `${base}${suffix}`;
  used.add(result);
  return result;
}

function normalizeRequest(
  item: RecordValue,
  context: RequestContext,
  variables: Map<string, unknown>,
  baseUrl: URL | undefined,
  summary: PostmanImportSummary,
): NormalizedRequest | undefined {
  const itemName = safeDisplayText(item.name, 'Unnamed request');
  const request = typeof item.request === 'string'
    ? { url: item.request, method: 'GET' }
    : isRecord(item.request)
      ? item.request
      : null;
  if (!request) return undefined;
  const method = (asString(request.method) || 'GET').toLowerCase();
  if (!SUPPORTED_METHODS.has(method)) {
    summary.issues.push({
      severity: 'warning',
      code: 'unsupported_http_method',
      message: `HTTP method ${method.toUpperCase()}은 OpenAPI operation으로 변환하지 않았습니다.`,
      item: itemName,
    });
    return undefined;
  }

  const rawUrl = requestUrlRaw(request);
  if (!rawUrl) {
    summary.issues.push({
      severity: 'warning',
      code: 'missing_request_url',
      message: 'request URL이 없어 건너뛰었습니다.',
      item: itemName,
    });
    return undefined;
  }
  const unresolved = new Set<string>();
  const resolved = resolveUrlVariables(rawUrl, variables, baseUrl, unresolved);
  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    summary.unresolvedVariables.push(...unresolved);
    summary.issues.push({
      severity: 'warning',
      code: 'unresolved_request_url',
      message: 'URL host를 해석할 수 없습니다. Base URL을 지정해주세요.',
      item: itemName,
    });
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.username || parsed.password) {
    summary.issues.push({
      severity: 'warning',
      code: 'url_credentials_omitted',
      message: 'URL 자격정보가 포함된 request를 건너뛰었습니다.',
      item: itemName,
    });
    return undefined;
  }

  summary.unresolvedVariables.push(...unresolved);
  const headers = headerEntries(request.header);
  const rawPath = restoreTemplateBraces(parsed.pathname);
  const path = templatizeLiteralIds(rawPath);
  const requestAuth = isRecord(request.auth)
    ? request.auth
    : request.auth === null
      ? context.inheritedAuth
      : context.inheritedAuth;
  return {
    name: itemName,
    description: descriptionText(item.description || request.description),
    method,
    serverUrl: parsed.origin,
    path,
    parameters: [
      ...pathParameters(path, request),
      ...queryParameters(request, parsed, summary.issues, itemName),
      ...headerParameters(headers),
    ],
    requestBody: requestBody(request.body, headers),
    responses: responseMap(item.response, summary.issues, itemName),
    auth: requestAuth,
    folderPath: context.folderPath,
    scriptCount: countEvents(item.event) + countEvents(request.event),
    graphqlOperationName: graphqlOperationName(request.body),
  };
}

function mergeOperationVariant(
  existing: RecordValue,
  incoming: RecordValue,
  variantName: string,
): boolean {
  let schemaVariantsTruncated = false;
  const variants = Array.isArray(existing['x-postman-variants'])
    ? existing['x-postman-variants'] as unknown[]
    : [];
  if (!variants.includes(variantName)) variants.push(variantName);
  existing['x-postman-variants'] = variants;

  const existingServers = Array.isArray(existing.servers)
    ? existing.servers.filter(isRecord)
    : [];
  const incomingServers = Array.isArray(incoming.servers)
    ? incoming.servers.filter(isRecord)
    : [];
  const serverUrls = new Set(existingServers.map((server) => asString(server.url)));
  for (const server of incomingServers) {
    const url = asString(server.url);
    if (url && !serverUrls.has(url)) {
      existingServers.push(server);
      serverUrls.add(url);
    }
  }
  if (existingServers.length > 0) existing.servers = existingServers;

  const existingSecurity = Array.isArray(existing.security)
    ? existing.security.filter(isRecord)
    : [];
  const incomingSecurity = Array.isArray(incoming.security)
    ? incoming.security.filter(isRecord)
    : [];
  const securityKeys = new Set(existingSecurity.map(schemaSignature));
  for (const requirement of incomingSecurity) {
    const signature = schemaSignature(requirement);
    if (!securityKeys.has(signature)) {
      existingSecurity.push(requirement);
      securityKeys.add(signature);
    }
  }
  if (existingSecurity.length > 0) existing.security = existingSecurity;

  const existingParameters = Array.isArray(existing.parameters)
    ? existing.parameters.filter(isRecord)
    : [];
  const incomingParameters = Array.isArray(incoming.parameters)
    ? incoming.parameters.filter(isRecord)
    : [];
  const parameterKeys = new Set(existingParameters.map((parameter) => (
    `${asString(parameter.in)}:${asString(parameter.name).toLowerCase()}`
  )));
  for (const parameter of incomingParameters) {
    const key = `${asString(parameter.in)}:${asString(parameter.name).toLowerCase()}`;
    if (!parameterKeys.has(key)) {
      existingParameters.push(parameter);
      parameterKeys.add(key);
    }
  }
  if (existingParameters.length > 0) existing.parameters = existingParameters;

  const mergeSchema = (left: unknown, right: unknown): RecordValue | undefined => {
    if (!isRecord(right)) return isRecord(left) ? left : undefined;
    if (!isRecord(left)) return right;
    const candidates = [
      ...(Array.isArray(left.oneOf) ? left.oneOf.filter(isRecord) : [left]),
      ...(Array.isArray(right.oneOf) ? right.oneOf.filter(isRecord) : [right]),
    ];
    const unique: RecordValue[] = [];
    const signatures = new Set<string>();
    for (const candidate of candidates) {
      const signature = schemaSignature(candidate);
      if (signatures.has(signature)) continue;
      if (unique.length >= MAX_SCHEMA_VARIANTS) {
        schemaVariantsTruncated = true;
        continue;
      }
      unique.push(candidate);
      signatures.add(signature);
    }
    return unique.length === 1 ? unique[0] : { oneOf: unique };
  };
  const mergeContent = (left: unknown, right: unknown): RecordValue => {
    const output = isRecord(left) ? { ...left } : {};
    if (!isRecord(right)) return output;
    for (const [mediaType, rawMedia] of Object.entries(right)) {
      const incomingMedia = isRecord(rawMedia) ? rawMedia : {};
      const existingMedia = isRecord(output[mediaType])
        ? output[mediaType] as RecordValue
        : {};
      output[mediaType] = {
        ...existingMedia,
        ...incomingMedia,
        schema: mergeSchema(existingMedia.schema, incomingMedia.schema),
      };
    }
    return output;
  };

  if (isRecord(incoming.requestBody)) {
    const existingBody = isRecord(existing.requestBody) ? existing.requestBody : {};
    existing.requestBody = {
      ...existingBody,
      required: Boolean(existingBody.required || incoming.requestBody.required),
      content: mergeContent(existingBody.content, incoming.requestBody.content),
    };
  }

  const incomingResponses = isRecord(incoming.responses) ? incoming.responses : {};
  const existingResponses = isRecord(existing.responses) ? existing.responses : {};
  for (const [code, response] of Object.entries(incomingResponses)) {
    if (!existingResponses[code]) {
      existingResponses[code] = response;
      continue;
    }
    const existingResponse = isRecord(existingResponses[code])
      ? existingResponses[code] as RecordValue
      : {};
    const incomingResponse = isRecord(response) ? response : {};
    existingResponses[code] = {
      ...existingResponse,
      content: mergeContent(existingResponse.content, incomingResponse.content),
    };
  }
  existing.responses = existingResponses;
  return schemaVariantsTruncated;
}

function unwrapCollection(source: unknown): RecordValue {
  if (isRecord(source) && isRecord(source.collection)) return source.collection;
  if (isRecord(source)) return source;
  throw new PostmanImportError('Postman Collection JSON 객체가 아닙니다.');
}

export function importPostmanCollection(
  source: unknown,
  options: PostmanImportOptions = {},
): PreparedPostmanSource {
  const collection = unwrapCollection(source);
  if (!isRecord(collection.info) || !Array.isArray(collection.item)) {
    throw new PostmanImportError('Postman Collection의 info와 item 배열을 찾을 수 없습니다.');
  }
  const name = safeDisplayText(collection.info.name, 'Postman Collection');
  const version = collectionVersion(collection.info);
  const variables = variableMap(collection.variable);
  const baseUrl = detectCollectionBaseUrl(variables, options.baseUrlOverride);
  const summary: PostmanImportSummary = {
    collectionVersion: version,
    totalRequests: 0,
    importedOperations: 0,
    mergedVariants: 0,
    skippedRequests: 0,
    scriptCount: countEvents(collection.event),
    unresolvedVariables: [],
    issues: [],
  };
  if (version === 'unknown') {
    summary.issues.push({
      severity: 'warning',
      code: 'unknown_collection_version',
      message: 'Collection v2.0/v2.1 schema가 아니므로 호환 가능한 필드만 읽었습니다.',
    });
  }

  const normalized: NormalizedRequest[] = [];
  const walk = (
    items: unknown[],
    context: RequestContext,
  ) => {
    for (const raw of items) {
      if (summary.totalRequests >= MAX_POSTMAN_ITEMS) {
        summary.issues.push({
          severity: 'warning',
          code: 'request_limit_reached',
          message: `${MAX_POSTMAN_ITEMS}개 이후 request는 가져오지 않았습니다.`,
        });
        return;
      }
      if (!isRecord(raw)) continue;
      if (Array.isArray(raw.item)) {
        summary.scriptCount += countEvents(raw.event);
        walk(raw.item, {
          folderPath: [
            ...context.folderPath,
            safeDisplayText(raw.name, ''),
          ].filter(Boolean),
          inheritedAuth: isRecord(raw.auth) ? raw.auth : context.inheritedAuth,
        });
        continue;
      }
      if (!('request' in raw)) continue;
      summary.totalRequests += 1;
      const request = normalizeRequest(raw, context, variables, baseUrl, summary);
      if (request) normalized.push(request);
      else summary.skippedRequests += 1;
    }
  };
  walk(collection.item, {
    folderPath: [],
    inheritedAuth: isRecord(collection.auth) ? collection.auth : undefined,
  });

  if (normalized.length === 0) {
    const unresolved = [...new Set(summary.unresolvedVariables)];
    if (unresolved.length > 0 && !options.baseUrlOverride) {
      throw new PostmanImportError(
        `URL host 변수를 해석할 수 없습니다: ${unresolved.join(', ')}. Base URL을 입력해주세요.`,
      );
    }
    throw new PostmanImportError('가져올 수 있는 HTTP request가 없습니다.');
  }

  const paths: Record<string, RecordValue> = {};
  const schemes: Record<string, RecordValue> = {};
  const servers = [...new Set(normalized.map((request) => request.serverUrl))];
  const usedOperationIds = new Set<string>();

  for (const request of normalized) {
    summary.scriptCount += request.scriptCount;
    const pathItem = paths[request.path] || {};
    const existing = isRecord(pathItem[request.method])
      ? pathItem[request.method] as RecordValue
      : undefined;
    const operationId = uniqueOperationId(
      operationIdBase(
        request.graphqlOperationName || request.name,
        request.method,
        request.path,
      ),
      usedOperationIds,
    );
    const responses = Object.keys(request.responses).length > 0
      ? request.responses
      : { default: { description: 'Response schema was not saved in Postman.' } };
    const security = authSecurity(request.auth, schemes, summary.issues, request.name);
    const operation: RecordValue = {
      operationId,
      summary: request.name.slice(0, 300),
      ...(request.description ? { description: request.description } : {}),
      ...(request.parameters.length > 0 ? { parameters: request.parameters } : {}),
      ...(request.requestBody ? { requestBody: request.requestBody } : {}),
      responses,
      servers: [{ url: request.serverUrl }],
      ...(security ? { security } : {}),
      'x-pathfinder-source': {
        kind: 'postman_collection',
        version: 1,
        collection_format: version,
        folder_path: request.folderPath,
        sample_values_persisted: false,
        scripts_executed: false,
      },
      'x-postman-variants': [request.name],
    };
    if (existing) {
      const schemaVariantsTruncated = mergeOperationVariant(
        existing,
        operation,
        request.name,
      );
      if (
        schemaVariantsTruncated
        && !summary.issues.some((issue) => issue.code === 'schema_variation_limit_reached')
      ) {
        summary.issues.push({
          severity: 'warning',
          code: 'schema_variation_limit_reached',
          message: `operation schema variation은 위치별 ${MAX_SCHEMA_VARIANTS}개까지만 보존합니다.`,
          item: request.name,
        });
      }
      summary.mergedVariants += 1;
    } else {
      pathItem[request.method] = operation;
      paths[request.path] = pathItem;
      summary.importedOperations += 1;
    }
  }

  summary.unresolvedVariables = [...new Set(summary.unresolvedVariables)].sort();
  if (summary.scriptCount > 0) {
    summary.issues.push({
      severity: 'info',
      code: 'scripts_not_executed',
      message: `pre-request/test script ${summary.scriptCount}개는 실행하거나 저장하지 않았습니다.`,
    });
  }
  if (servers.length > 1) {
    summary.issues.push({
      severity: 'info',
      code: 'multiple_hosts_preserved',
      message: `${servers.length}개 API host를 operation-level servers로 보존했습니다.`,
    });
  }

  const primary = new URL(servers[0]);
  const spec: RecordValue = {
    openapi: '3.1.0',
    info: {
      title: name.slice(0, 300),
      version: '1.0.0',
      description: descriptionText(collection.info.description)
        || 'Imported from Postman Collection without sample values.',
      'x-pathfinder-import': {
        kind: 'postman_collection',
        collection_format: version,
        request_count: summary.totalRequests,
        sample_values_persisted: false,
      },
    },
    servers: servers.map((url) => ({ url })),
    paths,
    ...(Object.keys(schemes).length > 0
      ? { components: { securitySchemes: schemes } }
      : {}),
  };

  return {
    spec,
    name,
    host: primary.hostname,
    baseUrl: primary.origin,
    summary,
  };
}

export async function preparePostmanFile(
  file: File,
  options: PostmanImportOptions = {},
): Promise<PreparedPostmanSource> {
  if (file.size > MAX_POSTMAN_FILE_BYTES) {
    throw new PostmanImportError('Postman Collection 파일은 10MB 이하여야 합니다.');
  }
  let source: unknown;
  try {
    source = JSON.parse(await file.text());
  } catch (error) {
    throw new PostmanImportError(
      `Postman JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return importPostmanCollection(source, options);
}
