import { useState, useEffect, useCallback } from 'react';
import { PROVIDERS, STORAGE_KEYS } from '../../shared/constants';

type ProviderKey = keyof typeof PROVIDERS;

export function SettingsBar() {
  const [provider, setProvider] = useState<ProviderKey>('anthropic');
  const [model, setModel] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(
      [STORAGE_KEYS.PROVIDER, STORAGE_KEYS.MODEL, STORAGE_KEYS.SERVER_URL],
      (result) => {
        if (result[STORAGE_KEYS.PROVIDER]) setProvider(result[STORAGE_KEYS.PROVIDER] as ProviderKey);
        if (result[STORAGE_KEYS.MODEL]) setModel(result[STORAGE_KEYS.MODEL]);
        if (result[STORAGE_KEYS.SERVER_URL]) setServerUrl(result[STORAGE_KEYS.SERVER_URL]);
      },
    );
  }, []);

  const handleProviderChange = useCallback((newProvider: ProviderKey) => {
    setProvider(newProvider);
    const defaultModel = PROVIDERS[newProvider]?.defaultModel ?? '';
    setModel(defaultModel);
    chrome.storage.local.set({
      [STORAGE_KEYS.PROVIDER]: newProvider,
      [STORAGE_KEYS.MODEL]: defaultModel,
    });
  }, []);

  const handleModelChange = useCallback((newModel: string) => {
    setModel(newModel);
    chrome.storage.local.set({ [STORAGE_KEYS.MODEL]: newModel });
  }, []);

  const providerLabel = PROVIDERS[provider]?.label ?? provider;

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
      {/* Collapsed: one-line summary */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        <span className="truncate">
          {providerLabel} · {model || '(모델 미설정)'}
          {serverUrl && (
            <span className="ml-2 text-gray-400 dark:text-gray-500">
              @ {serverUrl.replace(/^https?:\/\//, '')}
            </span>
          )}
        </span>
        <span className="ml-1">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Expanded: settings */}
      {expanded && (
        <div className="px-4 pb-2 space-y-2">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">
              Provider
            </label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as ProviderKey)}
              className="w-full text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-2 py-1"
            >
              {Object.entries(PROVIDERS).map(([key, info]) => (
                <option key={key} value={key}>
                  {info.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-0.5">
              Model
            </label>
            <input
              type="text"
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
              placeholder="모델 ID"
              className="w-full text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-2 py-1"
            />
          </div>

          {serverUrl && (
            <div className="text-xs text-gray-400 dark:text-gray-500 truncate">
              Server: {serverUrl}
            </div>
          )}
          {!serverUrl && (
            <div className="text-xs text-orange-500">
              XGEN 페이지를 열면 서버가 자동 감지됩니다
            </div>
          )}
        </div>
      )}
    </div>
  );
}
