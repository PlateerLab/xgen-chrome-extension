import { streamChat } from '../api';
import type { AiChatRequest } from '../types';
import { buildExtractionUserMessage } from './prompts';
import type { ProductDraft } from './types';

export interface EnrichInput {
  serverUrl: string;
  token: string;
  provider: string;
  model: string;
  draft: ProductDraft;
  pageSnippet: string;
  signal?: AbortSignal;
}

export interface EnrichPatch {
  title?: string;
  description?: string;
  brand?: string;
  modelName?: string;
  manufacturer?: string;
  origin?: string;
  options?: { name: string; values: string[] }[];
  categoryHints?: string[];
}

/** ```json fences나 앞뒤 잡문장 제거하고 첫 JSON 객체 추출. */
function extractFirstJsonObject(text: string): string | null {
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

function sanitizePatch(raw: unknown): EnrichPatch {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const patch: EnrichPatch = {};

  const str = (k: string): string | undefined => {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    return undefined;
  };

  patch.title = str('title');
  patch.description = str('description');
  patch.brand = str('brand');
  patch.modelName = str('modelName');
  patch.manufacturer = str('manufacturer');
  patch.origin = str('origin');

  const options = obj.options;
  if (Array.isArray(options)) {
    const cleaned = options
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map((o) => ({
        name: typeof o.name === 'string' ? o.name : '',
        values: Array.isArray(o.values) ? o.values.filter((v): v is string => typeof v === 'string') : [],
      }))
      .filter((o) => o.name && o.values.length > 0);
    if (cleaned.length > 0) patch.options = cleaned;
  }

  const hints = obj.categoryHints;
  if (Array.isArray(hints)) {
    const cleaned = hints.filter((h): h is string => typeof h === 'string' && h.trim().length > 0);
    if (cleaned.length > 0) patch.categoryHints = cleaned;
  }

  return patch;
}

export async function enrichProductDraft(input: EnrichInput): Promise<EnrichPatch> {
  const userContent = buildExtractionUserMessage(input.draft, input.pageSnippet);
  const request: AiChatRequest = {
    messages: [{ role: 'user', content: userContent }],
    provider: input.provider,
    model: input.model,
  };

  let buffer = '';
  for await (const event of streamChat(input.serverUrl, input.token, request, input.signal)) {
    if (event.type === 'token') {
      buffer += event.content;
    } else if (event.type === 'error') {
      throw new Error(event.content || 'streamChat error');
    } else if (event.type === 'done') {
      break;
    }
  }

  const json = extractFirstJsonObject(buffer);
  if (!json) {
    throw new Error('LLM 응답에서 JSON 객체를 찾을 수 없습니다.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}`);
  }

  return sanitizePatch(parsed);
}
