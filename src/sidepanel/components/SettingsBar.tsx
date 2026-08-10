import { useState, useEffect, useCallback } from 'react';
import { STORAGE_KEYS, API_PROVIDERS_ENDPOINT } from '../../shared/constants';
import {
  inspectCookiePermission,
  requestCookiePermission,
  type PermissionReadiness,
} from '../../shared/permissions';
import {
  diagnoseXgenCompatibility,
  xgenCompatibilityLabel,
  type XgenCompatibilityResult,
} from '../../shared/xgen-capabilities';
import type { ExtensionMessage } from '../../shared/types';

/** /providers 의 models 원소 — 구 백엔드는 문자열, 신 백엔드(chat mode)는 {id,name,description} 객체. */
type ModelInfo = string | { id: string; name?: string; description?: string };

interface ProviderInfo {
  provider: string;
  name: string;
  models: ModelInfo[];
  default_model: string;
  available: boolean;
}

/** ModelInfo → 모델 ID 문자열 (저장·전송용). */
const modelId = (m: ModelInfo): string => (typeof m === 'string' ? m : m.id);
/** ModelInfo → 드롭다운 표시 라벨. */
const modelLabel = (m: ModelInfo): string => (typeof m === 'string' ? m : m.name || m.id);

interface SettingsBarProps {
  targetTabId?: number | null;
  targetTabUrl?: string | null;
}

export function SettingsBar({ targetTabId, targetTabUrl }: SettingsBarProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  /** 입력 중인 server URL (저장 전). serverUrl과 다르면 "저장" 버튼 활성화. */
  const [serverUrlDraft, setServerUrlDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cookieReadiness, setCookieReadiness] = useState<PermissionReadiness | null>(null);
  const [permissionPending, setPermissionPending] = useState(false);
  const [compatibility, setCompatibility] = useState<XgenCompatibilityResult | null>(null);
  const [compatibilityPending, setCompatibilityPending] = useState(false);
  const [sessionDetected, setSessionDetected] = useState(false);

  // Load saved settings + fetch providers
  useEffect(() => {
    chrome.storage.local.get(
      [STORAGE_KEYS.PROVIDER, STORAGE_KEYS.MODEL, STORAGE_KEYS.SERVER_URL, STORAGE_KEYS.AUTH_TOKEN],
      (result) => {
        const savedProvider = result[STORAGE_KEYS.PROVIDER] || 'anthropic';
        const savedModel = result[STORAGE_KEYS.MODEL] || '';
        const savedUrl = result[STORAGE_KEYS.SERVER_URL] || '';

        setProvider(savedProvider);
        setModel(savedModel);
        setServerUrl(savedUrl);
        setServerUrlDraft(savedUrl);

        if (savedUrl) {
          fetchProviders(savedUrl, result[STORAGE_KEYS.AUTH_TOKEN] || '');
        }
      },
    );
  }, []);

  // Re-fetch when server URL changes
  useEffect(() => {
    const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[STORAGE_KEYS.SERVER_URL]?.newValue !== undefined) {
        const newUrl = changes[STORAGE_KEYS.SERVER_URL].newValue || '';
        setServerUrl(newUrl);
        setServerUrlDraft(newUrl);
        if (newUrl) {
          chrome.storage.local.get(STORAGE_KEYS.AUTH_TOKEN, (r) => {
            fetchProviders(newUrl, r[STORAGE_KEYS.AUTH_TOKEN] || '');
          });
        } else {
          setProviders([]);
        }
      }
      if (changes[STORAGE_KEYS.AUTH_TOKEN]?.newValue !== undefined) {
        setSessionDetected(Boolean(changes[STORAGE_KEYS.AUTH_TOKEN].newValue));
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  const fetchProviders = useCallback(async (url: string, token: string) => {
    setLoading(true);
    try {
      const resp = await fetch(`${url}${API_PROVIDERS_ENDPOINT}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (resp.ok) {
        const data = await resp.json();
        const list: ProviderInfo[] = data.providers || [];
        setProviders(list);
        // 모델 auto-select 하지 않음 — 사용자가 provider 변경할 때만 model 변경
      }
    } catch {
      // Server not reachable
    } finally {
      setLoading(false);
    }
  }, []);

  // 저장값보다 현재 탭의 해석된 XGEN 세션을 우선한다. 패널을 열거나 대상 탭이
  // 정해지는 즉시 dev/prod origin과 로그인 토큰을 함께 반영한다.
  useEffect(() => {
    chrome.runtime.sendMessage({
      type: 'GET_CHAT_CONFIG',
      ...(typeof targetTabId === 'number' ? { tabId: targetTabId } : {}),
    } satisfies ExtensionMessage).then((config) => {
      const detectedUrl = String(config?.serverUrl || '');
      const detectedToken = String(config?.authToken || '');
      if (!detectedUrl) return;
      setServerUrl(detectedUrl);
      setServerUrlDraft(detectedUrl);
      setSessionDetected(Boolean(detectedToken));
      void fetchProviders(detectedUrl, detectedToken);
    }).catch(() => {});
  }, [fetchProviders, targetTabId]);

  const inspectCompatibility = useCallback(async (url: string, token: string) => {
    if (!url) {
      setCompatibility(null);
      return;
    }
    setCompatibilityPending(true);
    try {
      setCompatibility(await diagnoseXgenCompatibility(url, token));
    } finally {
      setCompatibilityPending(false);
    }
  }, []);

  const refreshCookieReadiness = useCallback(() => {
    inspectCookiePermission(targetTabUrl || undefined)
      .then(setCookieReadiness)
      .catch(() => setCookieReadiness(null));
  }, [targetTabUrl]);

  useEffect(() => {
    if (!expanded) return undefined;
    refreshCookieReadiness();
    if (serverUrl) {
      chrome.runtime.sendMessage({
        type: 'GET_CHAT_CONFIG',
        ...(typeof targetTabId === 'number' ? { tabId: targetTabId } : {}),
      } satisfies ExtensionMessage).then((config) => {
        void inspectCompatibility(
          String(config?.serverUrl || serverUrl),
          String(config?.authToken || ''),
        );
      }).catch(() => {
        void inspectCompatibility(serverUrl, '');
      });
    }
    chrome.permissions.onAdded.addListener(refreshCookieReadiness);
    chrome.permissions.onRemoved.addListener(refreshCookieReadiness);
    return () => {
      chrome.permissions.onAdded.removeListener(refreshCookieReadiness);
      chrome.permissions.onRemoved.removeListener(refreshCookieReadiness);
    };
  }, [
    expanded,
    inspectCompatibility,
    refreshCookieReadiness,
    serverUrl,
    targetTabId,
  ]);

  const handleCookiePermission = useCallback(() => {
    setPermissionPending(true);
    requestCookiePermission(targetTabUrl || undefined)
      .then(setCookieReadiness)
      .catch(() => refreshCookieReadiness())
      .finally(() => setPermissionPending(false));
  }, [refreshCookieReadiness, targetTabUrl]);

  const handleProviderChange = useCallback((newProvider: string) => {
    setProvider(newProvider);
    const info = providers.find((p) => p.provider === newProvider);
    const newModel = info?.default_model || '';
    setModel(newModel);
    chrome.storage.local.set({
      [STORAGE_KEYS.PROVIDER]: newProvider,
      [STORAGE_KEYS.MODEL]: newModel,
    });
  }, [providers]);

  const handleModelChange = useCallback((newModel: string) => {
    setModel(newModel);
    chrome.storage.local.set({ [STORAGE_KEYS.MODEL]: newModel });
  }, []);

  /** Server URL 정규화 — trailing slash 제거 + 공백 정리. */
  const _normalizeServerUrl = (input: string): string => {
    const v = input.trim();
    if (!v) return '';
    return v.replace(/\/+$/, '');
  };

  const handleSaveServerUrl = useCallback(() => {
    const normalized = _normalizeServerUrl(serverUrlDraft);
    if (normalized === serverUrl) return;
    if (normalized) {
      try {
        new URL(normalized);  // 형식 검증
      } catch {
        return;  // 잘못된 URL → 저장 안 함
      }
      chrome.storage.local.set({ [STORAGE_KEYS.SERVER_URL]: normalized });
    } else {
      // 빈 값 → storage에서 제거하고 다시 자동 감지에 맡김
      chrome.storage.local.remove(STORAGE_KEYS.SERVER_URL);
    }
  }, [serverUrl, serverUrlDraft]);

  const currentProvider = providers.find((p) => p.provider === provider);
  const availableProviders = providers.filter((p) => p.available);
  const displayName = currentProvider?.name || provider;

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        data-testid="settings-toggle"
        className={`p-1 rounded transition-colors ${expanded ? 'text-gray-700 bg-gray-100' : 'text-gray-400 hover:text-gray-600'}`}
        title={`${displayName} · ${model || '(모델 미설정)'}`}
      >
        {/* Settings gear icon */}
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      {expanded && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50 p-2.5 space-y-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Provider
            </label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full text-xs rounded border border-gray-200 bg-white text-gray-700 px-2 py-1.5 focus:outline-none focus:border-gray-400"
            >
              {availableProviders.length > 0
                ? availableProviders.map((p) => (
                    <option key={p.provider} value={p.provider}>{p.name}</option>
                  ))
                : <option value={provider}>{displayName}</option>
              }
            </select>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Model
            </label>
            {currentProvider && currentProvider.models.length > 0 ? (
              <select
                value={model}
                onChange={(e) => handleModelChange(e.target.value)}
                className="w-full text-xs rounded border border-gray-200 bg-white text-gray-700 px-2 py-1.5 focus:outline-none focus:border-gray-400"
              >
                {currentProvider.models.map((m) => {
                  const id = modelId(m);
                  return <option key={id} value={id}>{modelLabel(m)}</option>;
                })}
              </select>
            ) : (
              <input
                type="text"
                value={model}
                onChange={(e) => handleModelChange(e.target.value)}
                placeholder="모델 ID"
                className="w-full text-xs rounded border border-gray-200 bg-white text-gray-700 px-2 py-1.5 focus:outline-none focus:border-gray-400"
              />
            )}
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Server URL
            </label>
            <div className="flex gap-1">
              <input
                type="text"
                value={serverUrlDraft}
                onChange={(e) => setServerUrlDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveServerUrl();
                }}
                placeholder="http://localhost:8080"
                className="flex-1 text-xs rounded border border-gray-200 bg-white text-gray-700 px-2 py-1.5 focus:outline-none focus:border-gray-400 min-w-0"
              />
              <button
                onClick={handleSaveServerUrl}
                disabled={_normalizeServerUrl(serverUrlDraft) === serverUrl}
                className="text-xs px-2 py-1.5 rounded bg-gray-700 text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-gray-800 transition-colors"
              >
                저장
              </button>
            </div>
            <div className="text-[10px] text-gray-400 mt-1 truncate">
              {loading
                ? '서버 감지 중...'
                : sessionDetected && serverUrl
                  ? `로그인 세션 감지됨 · ${serverUrl.replace(/^https?:\/\//, '')}`
                : serverUrl
                  ? `현재: ${serverUrl.replace(/^https?:\/\//, '')}`
                  : '비워두면 active 탭/저장된 토큰으로 자동 감지'}
            </div>
          </div>

          <div className="border-t border-gray-100 pt-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-gray-400">
                  XGEN 호환성
                </div>
                <div
                  data-testid="xgen-compatibility-status"
                  className={`truncate text-[10px] ${
                    compatibility?.compatible
                      ? 'text-green-700'
                      : compatibility?.status === 'legacy_unverified'
                        ? 'text-amber-700'
                        : 'text-gray-500'
                  }`}
                  title={compatibility?.issues.map((issue) => issue.message).join('\n')}
                >
                  {compatibilityPending
                    ? '확인 중...'
                    : compatibility
                      ? xgenCompatibilityLabel(compatibility)
                      : '서버를 연결하면 확인합니다'}
                </div>
              </div>
              {compatibility?.graphToolCallVersion && (
                <span className="shrink-0 text-[9px] text-gray-400">
                  gtc {compatibility.graphToolCallVersion}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-gray-400">
                  실행 인증
                </div>
                <div className="text-[10px] text-gray-500 truncate">
                  <span data-testid="cookie-permission-status">
                    {cookieReadiness?.ready
                      ? '현재 사이트 쿠키 연결됨'
                      : cookieReadiness?.reason === 'host_permission_required'
                        ? '사이트 접근 권한 필요'
                        : cookieReadiness?.reason === 'unsupported_url'
                          ? '웹 페이지에서만 사용 가능'
                          : '쿠키 연결 안 됨'}
                  </span>
                </div>
              </div>
              {!cookieReadiness?.ready && (
                <button
                  type="button"
                  onClick={handleCookiePermission}
                  data-testid="cookie-permission-connect"
                  disabled={permissionPending || cookieReadiness?.reason === 'unsupported_url'}
                  className="shrink-0 text-[10px] px-2 py-1.5 rounded border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {permissionPending ? '확인 중' : '연결'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
