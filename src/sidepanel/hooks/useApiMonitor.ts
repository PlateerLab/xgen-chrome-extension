import { useState, useCallback, useEffect } from 'react';
import type { CapturedApi } from '../../shared/api-hook-types';
import type { ExtensionMessage } from '../../shared/types';

export function useApiMonitor() {
  const [capturedApis, setCapturedApis] = useState<CapturedApi[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [filter, setFilter] = useState({ url: '', method: '' });

  useEffect(() => {
    const listener = (message: ExtensionMessage) => {
      switch (message.type) {
        case 'API_CAPTURED':
          setCapturedApis((prev) => [...prev, message.data]);
          break;
        case 'API_HOOK_STATUS':
          setIsCapturing(message.active);
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const startCapture = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'API_HOOK_START' } satisfies ExtensionMessage);
  }, []);

  const stopCapture = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'API_HOOK_STOP' } satisfies ExtensionMessage);
  }, []);

  const clearCaptured = useCallback(() => {
    setCapturedApis([]);
  }, []);

  const filteredApis = capturedApis.filter((api) => {
    if (filter.url && !api.url.toLowerCase().includes(filter.url.toLowerCase())) return false;
    if (filter.method && api.method !== filter.method) return false;
    return true;
  });

  return {
    capturedApis: filteredApis,
    allCount: capturedApis.length,
    isCapturing,
    filter,
    setFilter,
    startCapture,
    stopCapture,
    clearCaptured,
  };
}
