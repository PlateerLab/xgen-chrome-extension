import { streamChat } from '../api';
import type { AiChatRequest } from '../types';
import {
  buildComparisonPrompt,
  buildDetailCorePrompt,
  buildDetailExtrasPrompt,
  buildInsightPrompt,
  type ComparisonContent,
  type DetailCoreContent,
  type DetailExtrasContent,
  type InsightContent,
} from './demo-prompts';
import type { ProductDraft } from './types';

export interface StreamConfig {
  serverUrl: string;
  token: string;
  provider: string;
  model: string;
}

/** 누적된 텍스트에서 가장 바깥 JSON 객체만 추출. ```json fence와 앞뒤 잡문 제거. */
export function extractFirstJsonObject(text: string): string | null {
  const stripped = text.replace(/```json\s*|\s*```/g, '').trim();
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

/** 진행 중 partial JSON에서 특정 string field의 누적 값 추출 (스트리밍 표시용).
 *  완벽하지 않지만 detailBodyHtml 같은 큰 텍스트 필드를 점진적으로 보여줄 때 유용. */
export function tryExtractStringField(buffer: string, fieldName: string): string | undefined {
  const re = new RegExp(`"${fieldName}"\\s*:\\s*"`);
  const m = re.exec(buffer);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  let result = '';
  let i = start;
  let escape = false;
  while (i < buffer.length) {
    const ch = buffer[i];
    if (escape) {
      // 단순 디코드: \n, \t, \", \\ 정도. 나머진 그대로.
      if (ch === 'n') result += '\n';
      else if (ch === 't') result += '\t';
      else if (ch === '"') result += '"';
      else if (ch === '\\') result += '\\';
      else if (ch === '/') result += '/';
      else result += ch;
      escape = false;
    } else if (ch === '\\') {
      escape = true;
    } else if (ch === '"') {
      return result;
    } else {
      result += ch;
    }
    i++;
  }
  // 닫는 따옴표가 아직 안 옴 → 진행 중 부분 텍스트 반환
  return result;
}

export interface StreamCallbacks<T> {
  /** 토큰 추가될 때마다 호출. partial JSON에서 추출한 부분 데이터를 표시할 수 있게 buffer 전체 제공. */
  onProgress?: (buffer: string) => void;
  /** 스트림 완료 + JSON 파싱 성공. */
  onComplete?: (parsed: T) => void;
  /** 스트림 실패. */
  onError?: (err: Error) => void;
}

interface RunOptions<T> {
  /** JSON 파싱 실패 시 buffer에서 부분 데이터 추출 (응답 잘림 fallback). */
  extractPartial?: (buffer: string) => Partial<T> | null;
}

async function runStream<T>(
  config: StreamConfig,
  prompt: string,
  signal: AbortSignal,
  callbacks: StreamCallbacks<T>,
  options: RunOptions<T> = {},
): Promise<void> {
  const request: AiChatRequest = {
    messages: [{ role: 'user', content: prompt }],
    provider: config.provider,
    model: config.model,
  };

  let buffer = '';
  try {
    for await (const event of streamChat(config.serverUrl, config.token, request, signal)) {
      if (signal.aborted) return;
      if (event.type === 'token') {
        buffer += event.content;
        callbacks.onProgress?.(buffer);
      } else if (event.type === 'error') {
        throw new Error(event.content || 'streamChat error');
      } else if (event.type === 'done') {
        break;
      }
    }
    const json = extractFirstJsonObject(buffer);
    if (json) {
      try {
        const parsed = JSON.parse(json) as T;
        callbacks.onComplete?.(parsed);
        return;
      } catch (parseErr) {
        console.warn('[demo-streams] JSON.parse 실패, partial fallback 시도:', parseErr);
      }
    } else {
      console.warn(
        '[demo-streams] 닫는 brace 못 찾음 — 응답 잘림 추정. buffer 길이:', buffer.length,
        '\n끝부분:', buffer.slice(-300),
      );
    }

    // Fallback — partial 추출
    if (options.extractPartial) {
      const partial = options.extractPartial(buffer);
      if (partial && Object.keys(partial).length > 0) {
        callbacks.onComplete?.(partial as T);
        return;
      }
    }
    throw new Error('LLM 응답이 잘리거나 형식이 깨졌습니다. 다시 시도해주세요.');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/** 단순 string array 부분 추출 — JSON 잘려도 동작. */
function extractStringArrayField(buffer: string, fieldName: string): string[] | undefined {
  // open bracket까지만 매칭, close는 buffer 끝/잘림 허용
  const re = new RegExp(`"${fieldName}"\\s*:\\s*\\[([\\s\\S]*?)(?:\\]|$)`);
  const m = re.exec(buffer);
  if (!m) return undefined;
  const inner = m[1];
  const items: string[] = [];
  const reStr = /"((?:[^"\\]|\\.)*)"/g;
  let sm: RegExpExecArray | null;
  while ((sm = reStr.exec(inner)) !== null) {
    items.push(sm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  return items.length > 0 ? items : undefined;
}

/** Detail Core 응답이 잘렸을 때 hero/body/sellingPoints/keywords 부분 추출. */
function extractPartialDetailCore(buffer: string): Partial<DetailCoreContent> {
  const result: Partial<DetailCoreContent> = {};
  const headline = tryExtractStringField(buffer, 'heroHeadline');
  if (headline) result.heroHeadline = headline;
  const sub = tryExtractStringField(buffer, 'heroSubheadline');
  if (sub) result.heroSubheadline = sub;
  const body = tryExtractStringField(buffer, 'detailBodyHtml');
  if (body) result.detailBodyHtml = body;
  const sp = extractStringArrayField(buffer, 'sellingPoints');
  if (sp) result.sellingPoints = sp;
  const kw = extractStringArrayField(buffer, 'relatedKeywords');
  if (kw) result.relatedKeywords = kw;
  return result;
}

export function streamDetailCore(
  config: StreamConfig,
  draft: ProductDraft,
  signal: AbortSignal,
  callbacks: StreamCallbacks<DetailCoreContent>,
): Promise<void> {
  return runStream(config, buildDetailCorePrompt(draft), signal, callbacks, {
    extractPartial: extractPartialDetailCore,
  });
}

export function streamDetailExtras(
  config: StreamConfig,
  draft: ProductDraft,
  signal: AbortSignal,
  callbacks: StreamCallbacks<DetailExtrasContent>,
): Promise<void> {
  return runStream(config, buildDetailExtrasPrompt(draft), signal, callbacks);
}

export function streamInsight(
  config: StreamConfig,
  draft: ProductDraft,
  signal: AbortSignal,
  callbacks: StreamCallbacks<InsightContent>,
): Promise<void> {
  return runStream(config, buildInsightPrompt(draft), signal, callbacks);
}

export function streamComparison(
  config: StreamConfig,
  drafts: ProductDraft[],
  signal: AbortSignal,
  callbacks: StreamCallbacks<ComparisonContent>,
): Promise<void> {
  return runStream(config, buildComparisonPrompt(drafts), signal, callbacks);
}
