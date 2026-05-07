import { useEffect, useState } from 'react';
import { streamComparison, type StreamConfig } from '../../shared/product/demo-streams';
import type { ComparisonContent } from '../../shared/product/demo-prompts';
import type { ProductDraft } from '../../shared/product/types';
import type { ExtensionMessage } from '../../shared/types';
import type { StreamPhase, SideState } from './useDemoStreams';

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

const initial: SideState<ComparisonContent> = { phase: 'idle', partial: {} };

export function useComparisonStream(drafts: ProductDraft[] | null): SideState<ComparisonContent> {
  const [state, setState] = useState<SideState<ComparisonContent>>(initial);

  useEffect(() => {
    if (!drafts || drafts.length < 2) return;
    setState({ phase: 'loading-config', partial: {} });
    const ctrl = new AbortController();

    (async () => {
      const config = await fetchConfig();
      if (!config) {
        setState({ phase: 'error', partial: {}, error: 'XGEN 로그인이 필요합니다.' });
        return;
      }
      setState({ phase: 'streaming', partial: {} });
      void streamComparison(config, drafts, ctrl.signal, {
        onComplete: (parsed) => setState({ phase: 'done', partial: parsed, result: parsed }),
        onError: (err) => setState({ phase: 'error', partial: {}, error: err.message }),
      });
    })().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ phase: 'error', partial: {}, error: msg });
    });

    return () => ctrl.abort();
  }, [drafts]);

  return state;
}

export type { StreamPhase };
