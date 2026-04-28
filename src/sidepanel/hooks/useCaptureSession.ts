import { useCallback, useEffect, useState } from 'react';
import type { ExtensionMessage } from '../../shared/types';
import type { CapturedApi } from '../../shared/api-hook-types';

export interface SessionResult {
  apis: CapturedApi[];
  tabId: number;
  durationMs: number;
}

export interface CaptureSessionState {
  active: boolean;
  count: number;
  result: SessionResult | null;
  start: () => void;
  stop: () => void;
  dismissResult: () => void;
}

export function useCaptureSession(): CaptureSessionState {
  const [active, setActive] = useState(false);
  const [count, setCount] = useState(0);
  const [result, setResult] = useState<SessionResult | null>(null);

  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      if (message.type === 'CAPTURE_SESSION_STATUS') {
        setActive(message.active);
        setCount(message.count ?? 0);
      } else if (message.type === 'CAPTURE_SESSION_RESULT') {
        setActive(false);
        setCount(0);
        setResult({
          apis: message.apis,
          tabId: message.tabId,
          durationMs: message.durationMs,
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const start = useCallback(() => {
    setResult(null);
    chrome.runtime
      .sendMessage({ type: 'START_CAPTURE_SESSION' } satisfies ExtensionMessage)
      .catch(() => {});
  }, []);

  const stop = useCallback(() => {
    chrome.runtime
      .sendMessage({ type: 'STOP_CAPTURE_SESSION' } satisfies ExtensionMessage)
      .catch(() => {});
  }, []);

  const dismissResult = useCallback(() => setResult(null), []);

  return { active, count, result, start, stop, dismissResult };
}
