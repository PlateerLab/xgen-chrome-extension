import type { PreparedOpenApiSource } from './openapi-import';
import { isSensitiveKey } from './trace-registration';

const MAX_INTROSPECTION_BYTES = 20 * 1024 * 1024;

interface GraphQLTypeRef {
  name?: unknown;
}

interface GraphQLType {
  name?: unknown;
  fields?: unknown;
}

interface GraphQLSchema {
  queryType?: GraphQLTypeRef | null;
  mutationType?: GraphQLTypeRef | null;
  subscriptionType?: GraphQLTypeRef | null;
  types?: unknown;
}

export interface PreparedGraphQLSource extends PreparedOpenApiSource {
  sourceName: string;
  endpointUrl: string;
  summary: {
    queryCount: number;
    mutationCount: number;
    subscriptionCount: number;
    typeCount: number;
    omittedErrorCount: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeGraphQLEndpoint(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('GraphQL 실행 endpoint를 입력해주세요.');

  let endpoint: URL;
  try {
    endpoint = new URL(trimmed);
  } catch {
    throw new Error('GraphQL endpoint는 올바른 절대 URL이어야 합니다.');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('GraphQL endpoint는 HTTP 또는 HTTPS만 지원합니다.');
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('GraphQL endpoint에 계정정보나 fragment를 포함할 수 없습니다.');
  }
  for (const key of endpoint.searchParams.keys()) {
    if (isSensitiveKey(key)) {
      throw new Error('GraphQL endpoint URL에 token, API key 같은 인증값을 넣지 마세요.');
    }
  }
  return endpoint;
}

function operationCount(
  schema: GraphQLSchema,
  typeIndex: Map<string, GraphQLType>,
  root: GraphQLTypeRef | null | undefined,
): number {
  const name = typeof root?.name === 'string' ? root.name : '';
  const fields = typeIndex.get(name)?.fields;
  return Array.isArray(fields) ? fields.length : 0;
}

export function prepareGraphQLIntrospection(
  source: unknown,
  endpointValue: string,
  sourceName = 'graphql-introspection.json',
): PreparedGraphQLSource {
  const endpoint = normalizeGraphQLEndpoint(endpointValue);
  const document = asRecord(source);
  const data = asRecord(document?.data);
  const schemaValue = data?.__schema ?? document?.__schema;
  const schema = asRecord(schemaValue) as GraphQLSchema | null;
  if (!schema || !Array.isArray(schema.types)) {
    throw new Error('표준 GraphQL introspection 응답(data.__schema)이 아닙니다.');
  }

  const types = schema.types.filter(
    (entry): entry is GraphQLType => Boolean(asRecord(entry)),
  );
  const typeIndex = new Map(
    types
      .filter((entry) => typeof entry.name === 'string')
      .map((entry) => [String(entry.name), entry]),
  );
  const errors = Array.isArray(document?.errors) ? document.errors : [];
  const sanitized: Record<string, unknown> = {
    data: { __schema: schemaValue },
  };
  if (errors.length) {
    sanitized.errors = Array.from(
      { length: errors.length },
      () => ({ message: 'Introspection error details omitted by Pathfinder.' }),
    );
  }

  return {
    name: `${endpoint.hostname} GraphQL`,
    host: endpoint.hostname.toLowerCase(),
    baseUrl: endpoint.origin,
    spec: sanitized,
    endpointUrl: endpoint.toString(),
    summary: {
      queryCount: operationCount(schema, typeIndex, schema.queryType),
      mutationCount: operationCount(schema, typeIndex, schema.mutationType),
      subscriptionCount: operationCount(schema, typeIndex, schema.subscriptionType),
      typeCount: types.length,
      omittedErrorCount: errors.length,
    },
    sourceName,
  };
}

export async function prepareGraphQLIntrospectionFile(
  file: File,
  endpointUrl: string,
): Promise<PreparedGraphQLSource> {
  if (file.size > MAX_INTROSPECTION_BYTES) {
    throw new Error('GraphQL introspection JSON은 20MB 이하여야 합니다.');
  }
  let source: unknown;
  try {
    source = JSON.parse(await file.text());
  } catch {
    throw new Error('GraphQL introspection 파일이 올바른 JSON이 아닙니다.');
  }
  return prepareGraphQLIntrospection(source, endpointUrl, file.name);
}
