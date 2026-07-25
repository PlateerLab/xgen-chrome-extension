import { parse as parseYaml } from 'yaml';
import type { OpenApiSourceInput } from '../../shared/api';
import { isSensitiveKey } from './trace-registration';

const MAX_OPENAPI_FILE_BYTES = 5 * 1024 * 1024;

export interface PreparedOpenApiSource extends OpenApiSourceInput {
  name: string;
  host: string;
  baseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function openApiSlug(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function absoluteHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function sensitiveUrlIssues(spec: Record<string, unknown>): string[] {
  const issues = new Set<string>();
  const visited = new WeakSet<object>();
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{
    value: spec,
    path: '$',
    depth: 0,
  }];
  let inspected = 0;
  while (stack.length > 0 && inspected < 10_000) {
    const current = stack.pop()!;
    inspected += 1;
    if (current.depth > 20 || !current.value || typeof current.value !== 'object') {
      continue;
    }
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => stack.push({
        value: child,
        path: `${current.path}[${index}]`,
        depth: current.depth + 1,
      }));
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      const path = `${current.path}.${key}`;
      if (
        typeof child === 'string'
        && ['url', '$ref', 'authorizationurl', 'tokenurl', 'refreshurl'].includes(
          key.toLowerCase(),
        )
      ) {
        const url = absoluteHttpUrl(child);
        if (url?.username || url?.password) issues.add(`${path}: URL 자격정보`);
        const sensitiveKeys = url
          ? [...url.searchParams.keys()].filter(isSensitiveKey)
          : [];
        if (sensitiveKeys.length > 0) issues.add(`${path}: 민감 query key`);
      }
      if (child && typeof child === 'object') {
        stack.push({ value: child, path, depth: current.depth + 1 });
      }
    }
  }
  return [...issues].slice(0, 10);
}

function sourceIdentityFromSpec(
  spec: Record<string, unknown>,
  fileName: string,
): Pick<PreparedOpenApiSource, 'name' | 'host' | 'baseUrl'> {
  const info = isRecord(spec.info) ? spec.info : {};
  const title = typeof info.title === 'string' ? info.title.trim() : '';
  let serverUrl = '';
  if (Array.isArray(spec.servers) && isRecord(spec.servers[0])) {
    serverUrl = typeof spec.servers[0].url === 'string' ? spec.servers[0].url : '';
  } else if (typeof spec.host === 'string') {
    const scheme = Array.isArray(spec.schemes) && typeof spec.schemes[0] === 'string'
      ? spec.schemes[0]
      : 'https';
    const basePath = typeof spec.basePath === 'string' ? spec.basePath : '';
    serverUrl = `${scheme}://${spec.host}${basePath}`;
  }
  const parsed = absoluteHttpUrl(serverUrl);
  const fallbackName = fileName.replace(/\.(json|ya?ml)$/i, '') || 'OpenAPI';
  return {
    name: title || fallbackName,
    host: parsed?.hostname || '',
    baseUrl: parsed?.toString().replace(/\/$/, '') || '',
  };
}

export function prepareOpenApiUrl(raw: string): PreparedOpenApiSource {
  const url = absoluteHttpUrl(raw.trim());
  if (!url) throw new Error('HTTP 또는 HTTPS OpenAPI/Swagger URL을 입력해주세요.');
  if (url.username || url.password) {
    throw new Error('URL에 사용자명이나 비밀번호를 포함할 수 없습니다.');
  }
  const sensitiveQueryKeys = [...url.searchParams.keys()].filter(isSensitiveKey);
  if (sensitiveQueryKeys.length > 0) {
    throw new Error(
      `OpenAPI URL에서 민감 query key를 제거해주세요: ${sensitiveQueryKeys.join(', ')}`,
    );
  }
  url.hash = '';
  return {
    sourceUrl: url.toString(),
    name: url.hostname,
    host: url.hostname,
    baseUrl: url.origin,
  };
}

export async function prepareOpenApiFile(file: File): Promise<PreparedOpenApiSource> {
  if (file.size > MAX_OPENAPI_FILE_BYTES) {
    throw new Error('OpenAPI 파일은 5MB 이하여야 합니다.');
  }
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = parseYaml(text, {
      maxAliasCount: 20,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new Error(
      `JSON/YAML 파싱 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || (!parsed.openapi && !parsed.swagger)) {
    throw new Error('OpenAPI 또는 Swagger 문서가 아닙니다.');
  }
  const urlIssues = sensitiveUrlIssues(parsed);
  if (urlIssues.length > 0) {
    throw new Error(`문서 URL에서 민감정보를 제거해주세요: ${urlIssues.join(', ')}`);
  }
  return {
    spec: parsed,
    ...sourceIdentityFromSpec(parsed, file.name),
  };
}
