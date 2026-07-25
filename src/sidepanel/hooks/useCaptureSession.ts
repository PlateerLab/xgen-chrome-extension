import { useCallback, useEffect, useState } from 'react';
import type { ExtensionMessage } from '../../shared/types';
import type { CapturedApi } from '../../shared/api-hook-types';
import type { HarImportSummary } from '../lib/har-import';

export interface SessionResult {
  apis: CapturedApi[];
  tabId: number;
  durationMs: number;
  source?: 'capture' | 'har';
  sourceName?: string;
  importSummary?: HarImportSummary;
}

export interface CaptureSessionState {
  active: boolean;
  pending: boolean;
  count: number;
  error: string | null;
  result: SessionResult | null;
  start: () => void;
  stop: () => void;
  dismissResult: () => void;
  dismissError: () => void;
}

function tabTarget(tabId: number | null | undefined): { tabId?: number } {
  return typeof tabId === 'number' ? { tabId } : {};
}

export function useCaptureSession(targetTabId?: number | null): CaptureSessionState {
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);

  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      if (message.type === 'CAPTURE_SESSION_STATUS') {
        setActive(message.active);
        setCount(message.count ?? 0);
        setPending(false);
        if (message.error) {
          setError(message.error);
        } else if (message.active) {
          setError(null);
        }
      } else if (message.type === 'CAPTURE_SESSION_RESULT') {
        setActive(false);
        setPending(false);
        setCount(0);
        setError(null);
        setResult({
          apis: message.apis,
          tabId: message.tabId,
          durationMs: message.durationMs,
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // 사이드패널이 stop 이후에 처음 열린 케이스 — 그때는 broadcast를 놓쳤으니
    // SW에 캐시된 결과를 직접 query. 한 번 읽으면 SW가 소비(null)해서 재마운트 시
    // 옛 결과가 다시 노출되지 않는다.
    chrome.runtime
      .sendMessage({ type: 'GET_CAPTURE_RESULT' } satisfies ExtensionMessage)
      .then((resp: { ok?: boolean; result?: SessionResult | null } | undefined) => {
        if (resp?.result) {
          setActive(false);
          setPending(false);
          setCount(0);
          setError(null);
          setResult(resp.result);
        }
      })
      .catch(() => {});

    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const start = useCallback(() => {
    setResult(null);
    setError(null);
    setPending(true);
    chrome.runtime
      .sendMessage({ type: 'START_CAPTURE_SESSION', ...tabTarget(targetTabId) } satisfies ExtensionMessage)
      .then((resp: { ok?: boolean; error?: string } | undefined) => {
        if (resp?.ok === false) {
          setActive(false);
          setCount(0);
          setError(resp.error || '캡처 세션을 시작하지 못했습니다.');
        }
      })
      .catch((err) => {
        setActive(false);
        setCount(0);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setPending(false));
  }, [targetTabId]);

  const stop = useCallback(() => {
    setError(null);
    setPending(true);
    chrome.runtime
      .sendMessage({ type: 'STOP_CAPTURE_SESSION' } satisfies ExtensionMessage)
      .then((resp: { ok?: boolean; error?: string } | undefined) => {
        if (resp?.ok === false) {
          setError(resp.error || '캡처 세션을 종료하지 못했습니다.');
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setPending(false));
  }, []);

  const dismissResult = useCallback(() => setResult(null), []);
  const dismissError = useCallback(() => setError(null), []);

  return { active, pending, count, error, result, start, stop, dismissResult, dismissError };
}
