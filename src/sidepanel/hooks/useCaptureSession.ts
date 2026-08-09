import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionMessage } from '../../shared/types';
import type {
  CaptureCoverage,
  CapturedApi,
} from '../../shared/api-hook-types';
import type { HarImportSummary } from '../lib/har-import';
import {
  requestHostPermissions,
  type PermissionReadinessReason,
} from '../../shared/permissions';

export interface SessionResult {
  resultId?: string;
  sessionId?: string;
  state?: 'completed' | 'interrupted';
  reason?: string;
  apis: CapturedApi[];
  tabId: number;
  durationMs: number;
  source?: 'capture' | 'har';
  sourceName?: string;
  importSummary?: HarImportSummary;
  captureCoverage?: CaptureCoverage;
}

export interface CaptureSessionState {
  active: boolean;
  pending: boolean;
  count: number;
  error: string | null;
  reason: PermissionReadinessReason | null;
  result: SessionResult | null;
  start: () => void;
  stop: () => void;
  dismissResult: () => void;
  dismissError: () => void;
}

function tabTarget(tabId: number | null | undefined): { tabId?: number } {
  return typeof tabId === 'number' ? { tabId } : {};
}

function permissionError(reason: PermissionReadinessReason): string {
  if (reason === 'host_permission_required') {
    return '이 사이트의 API를 캡처하려면 사이트 접근 권한이 필요합니다.';
  }
  if (reason === 'unsupported_url') {
    return 'API 캡처는 http/https 페이지에서만 사용할 수 있습니다.';
  }
  return reason;
}

function interruptionError(reason?: string): string {
  if (reason === 'service_worker_restarted') {
    return '브라우저가 캡처 프로세스를 재시작해 세션이 중단되었습니다. 다시 캡처해 주세요.';
  }
  if (reason === 'capture_tab_closed') {
    return '캡처하던 탭이 닫혀 세션이 중단되었습니다.';
  }
  if (reason === 'replaced_by_new_session') {
    return '다른 탭에서 새 캡처를 시작해 이전 세션을 종료했습니다.';
  }
  return reason || '캡처 세션이 중단되었습니다.';
}

async function captureFrameUrls(
  tabId: number | null | undefined,
  topFrameUrl: string | null | undefined,
): Promise<string[]> {
  const urls = topFrameUrl ? [topFrameUrl] : [];
  if (typeof tabId !== 'number') return urls;
  const frames = await new Promise<chrome.webNavigation.GetAllFrameResultDetails[]>(
    (resolve) => {
      chrome.webNavigation.getAllFrames({ tabId }, (items) => {
        void chrome.runtime.lastError;
        resolve(items ?? []);
      });
    },
  );
  return [
    ...urls,
    ...frames.map((frame) => frame.url),
  ];
}

export function useCaptureSession(
  targetTabId?: number | null,
  targetTabUrl?: string | null,
): CaptureSessionState {
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<PermissionReadinessReason | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const acceptedResultIdRef = useRef<string | null>(null);

  useEffect(() => {
    const acceptResult = (sessionResult: SessionResult) => {
      if (
        sessionResult.resultId
        && acceptedResultIdRef.current === sessionResult.resultId
      ) return;
      acceptedResultIdRef.current = sessionResult.resultId ?? null;
      activeSessionIdRef.current = null;
      setActive(false);
      setPending(false);
      setCount(0);
      setError(sessionResult.state === 'interrupted'
        ? interruptionError(sessionResult.reason)
        : null);
      setReason(null);
      setResult(sessionResult.state === 'interrupted' ? null : sessionResult);
      if (sessionResult.resultId) {
        chrome.runtime.sendMessage({
          type: 'ACK_CAPTURE_RESULT',
          resultId: sessionResult.resultId,
        } satisfies ExtensionMessage).catch(() => {});
      }
    };
    const listener = (message: ExtensionMessage) => {
      if (message.type === 'CAPTURE_SESSION_STATUS') {
        activeSessionIdRef.current = message.sessionId ?? null;
        setActive(message.active);
        setCount(message.count ?? 0);
        setPending(message.state === 'starting' || message.state === 'stopping');
        if (message.error) {
          setError(message.error);
          if (
            message.error === 'host_permission_required'
            || message.error === 'cookie_permission_required'
            || message.error === 'unsupported_url'
          ) {
            setReason(message.error);
          }
        } else if (message.active) {
          setError(null);
          setReason(null);
        }
      } else if (message.type === 'CAPTURE_SESSION_RESULT') {
        acceptResult(message);
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
          acceptResult(resp.result);
        }
      })
      .catch(() => {});

    chrome.runtime
      .sendMessage({ type: 'GET_CAPTURE_SESSION_STATUS' } satisfies ExtensionMessage)
      .then((resp: {
        active?: boolean;
        state?: string;
        sessionId?: string;
        count?: number;
      } | undefined) => {
        activeSessionIdRef.current = resp?.sessionId ?? null;
        setActive(resp?.active === true);
        setPending(resp?.state === 'starting' || resp?.state === 'stopping');
        setCount(resp?.count ?? 0);
      })
      .catch(() => {});

    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const start = useCallback(() => {
    setResult(null);
    setError(null);
    setReason(null);
    setPending(true);
    captureFrameUrls(targetTabId, targetTabUrl)
      .then((frameUrls) => requestHostPermissions(frameUrls))
      .then((readiness) => {
        if (!readiness.ready) {
          setActive(false);
          setCount(0);
          setReason(readiness.reason);
          setError(permissionError(readiness.reason));
          return undefined;
        }
        return chrome.runtime.sendMessage({
          type: 'START_CAPTURE_SESSION',
          ...tabTarget(targetTabId),
        } satisfies ExtensionMessage);
      })
      .then((resp: { ok?: boolean; error?: string; sessionId?: string } | undefined) => {
        if (!resp) return;
        if (resp.sessionId) activeSessionIdRef.current = resp.sessionId;
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
  }, [targetTabId, targetTabUrl]);

  const stop = useCallback(() => {
    setError(null);
    setPending(true);
    chrome.runtime
      .sendMessage({
        type: 'STOP_CAPTURE_SESSION',
        ...(activeSessionIdRef.current
          ? { sessionId: activeSessionIdRef.current }
          : {}),
      } satisfies ExtensionMessage)
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
  const dismissError = useCallback(() => {
    setError(null);
    setReason(null);
  }, []);

  return {
    active,
    pending,
    count,
    error,
    reason,
    result,
    start,
    stop,
    dismissResult,
    dismissError,
  };
}
