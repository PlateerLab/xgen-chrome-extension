import { useEffect, useRef, useState } from 'react';
import {
  streamDetailCore,
  streamDetailExtras,
  streamInsight,
  tryExtractStringField,
  type StreamConfig,
} from '../../shared/product/demo-streams';
import type {
  DetailContent,
  DetailCoreContent,
  DetailExtrasContent,
  InsightContent,
} from '../../shared/product/demo-prompts';
import type { ProductDraft } from '../../shared/product/types';
import type { ExtensionMessage } from '../../shared/types';

export type StreamPhase = 'idle' | 'loading-config' | 'streaming' | 'done' | 'error';

export interface SideState<T> {
  phase: StreamPhase;
  partial: T;            // partial JSON에서 뽑은 부분 (스트리밍 효과용)
  partialBody?: string;  // detail의 detailBodyHtml만 진행 중 노출
  result?: T;            // 완료 후 파싱된 결과
  error?: string;
}

const initialDetail: SideState<DetailContent> = { phase: 'idle', partial: {} };
const initialInsight: SideState<InsightContent> = { phase: 'idle', partial: {} };

interface ChatConfigResponse {
  type: 'CHAT_CONFIG';
  serverUrl: string;
  authToken: string;
  provider: string;
  model: string;
}

async function fetchConfig(): Promise<StreamConfig | null> {
  const res = (await chrome.runtime.sendMessage({ type: 'GET_CHAT_CONFIG' } satisfies ExtensionMessage)) as
    | ChatConfigResponse
    | undefined;
  if (!res?.serverUrl || !res.authToken) return null;
  return {
    serverUrl: res.serverUrl,
    token: res.authToken,
    provider: res.provider,
    model: res.model,
  };
}

export function useDemoStreams(draft: ProductDraft | null) {
  const [detail, setDetail] = useState<SideState<DetailContent>>(initialDetail);
  const [insight, setInsight] = useState<SideState<InsightContent>>(initialInsight);
  const coreCtrlRef = useRef<AbortController | null>(null);
  const extrasCtrlRef = useRef<AbortController | null>(null);
  const insightCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!draft) return;

    setDetail({ phase: 'loading-config', partial: {} });
    setInsight({ phase: 'loading-config', partial: {} });

    const coreCtrl = new AbortController();
    const extrasCtrl = new AbortController();
    const insightCtrl = new AbortController();
    coreCtrlRef.current = coreCtrl;
    extrasCtrlRef.current = extrasCtrl;
    insightCtrlRef.current = insightCtrl;

    (async () => {
      const config = await fetchConfig();
      if (!config) {
        const err = 'XGEN 로그인이 필요합니다.';
        setDetail({ phase: 'error', partial: {}, error: err });
        setInsight({ phase: 'error', partial: {}, error: err });
        return;
      }

      setDetail((s) => ({ ...s, phase: 'streaming' }));
      setInsight((s) => ({ ...s, phase: 'streaming' }));

      // Detail Core (필수 — hero/body/sellingPoints) — 짧음, 잘림 위험 낮음
      const corePromise = streamDetailCore(config, draft, coreCtrl.signal, {
        onProgress: (buffer) => {
          const partialBody = tryExtractStringField(buffer, 'detailBodyHtml');
          setDetail((s) => ({ ...s, partialBody }));
        },
        onComplete: (core) => {
          setDetail((s) => ({
            ...s,
            partial: { ...s.partial, ...core },
            result: { ...(s.result ?? {}), ...core } as DetailContent,
          }));
        },
        onError: (err) => {
          setDetail((s) => ({ ...s, error: err.message }));
        },
      });

      // Detail Extras (보조 — reviews/qna). 잘려도 화면엔 영향 없음.
      const extrasPromise = streamDetailExtras(config, draft, extrasCtrl.signal, {
        onComplete: (extras) => {
          setDetail((s) => ({
            ...s,
            partial: { ...s.partial, ...extras },
            result: { ...(s.result ?? {}), ...extras } as DetailContent,
          }));
        },
        onError: (err) => {
          // Extras 실패는 silently 무시 (Core 있으면 화면 표시됨)
          console.warn('[useDemoStreams] extras 실패 (silent):', err.message);
        },
      });

      // 두 detail 호출 모두 끝나면 phase=done. Core 실패면 error로 마감.
      Promise.allSettled([corePromise, extrasPromise]).then(() => {
        setDetail((s) => {
          if (s.error && !s.result) {
            return { ...s, phase: 'error' };
          }
          return { ...s, phase: 'done' };
        });
      });

      void streamInsight(config, draft, insightCtrl.signal, {
        onComplete: (parsed) => {
          setInsight({ phase: 'done', partial: parsed, result: parsed });
        },
        onError: (err) => {
          setInsight({ phase: 'error', partial: {}, error: err.message });
        },
      });
    })().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      setDetail({ phase: 'error', partial: {}, error: msg });
      setInsight({ phase: 'error', partial: {}, error: msg });
    });

    return () => {
      coreCtrl.abort();
      extrasCtrl.abort();
      insightCtrl.abort();
    };
  }, [draft]);

  const cancel = () => {
    coreCtrlRef.current?.abort();
    extrasCtrlRef.current?.abort();
    insightCtrlRef.current?.abort();
  };

  return { detail, insight, cancel };
}

export type { DetailCoreContent, DetailExtrasContent };
