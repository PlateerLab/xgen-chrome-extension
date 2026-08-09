// streamChat은 sidePanel에서 직접 사용 (MV3 SW fetch streaming 제한)
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  STORAGE_KEYS,
} from '../shared/constants';
import type {
  ExtensionMessage,
  PageContext,
  SSEEvent,
} from '../shared/types';
import type {
  CaptureCoverage,
  CaptureRejectionReason,
  CapturedApi,
} from '../shared/api-hook-types';
import { normalizeCapturedApi } from '../shared/capture-validation';
import {
  buildValueFreeLegacyToolContent,
  normalizeLegacyApiUrl,
  summarizeCapturedApiForCommand,
} from '../shared/legacy-tool-registration';
import { mainWorldHookFunction, mainWorldUnhookFunction } from '../content/api-hook/main-world-hook';
import { apiHookRelayFunction } from '../content/api-hook/relay';
import {
  inspectCookiePermission,
  inspectHostPermission,
  originPatternForUrl,
  requestHostPermissions,
} from '../shared/permissions';
import {
  canonicalAuthServiceId,
  isPathfinderManagedProfile,
  matchCollectionAuthProfile,
  matchExactAuthProfile,
  PATHFINDER_MANAGED_MARKER,
  xgenAuthHeaders,
  type AuthProfileSummary,
  type CollectionAuthSummary,
} from './auth-profile-resolution';

// ── State ──
// origin별 토큰 저장 — 멀티 인스턴스 (xgen.x2bee.com / jeju-xgen.x2bee.com) 동시 사용 지원
const tokensByOrigin: Record<string, string> = {};
let cachedPageContext: PageContext | null = null;
let cachedPageContextTabId: number | null = null;
// activeAbortController 제거 — SSE abort는 sidePanel에서 직접 처리

// ── API Hook State ──
const hookedTabs = new Set<number>();
const contentScriptTabs = new Set<number>();
const contentScriptOriginPatterns = new Map<number, string>();
const capturedApisByTab = new Map<number, CapturedApi[]>();
interface FrameCaptureState {
  discoveredFrameIds: Set<number>;
  instrumentedFrameIds: Set<number>;
  blockedFrameIds: Set<number>;
  failedFrameIds: Set<number>;
  instrumentedOrigins: Set<string>;
  blockedOrigins: Set<string>;
  observedRequestCount: number;
  observedSubframeRequestCount: number;
  rejectedCaptureCounts: Map<CaptureRejectionReason, number>;
  serviceWorkerControlled: boolean;
}
const frameCaptureStateByTab = new Map<number, FrameCaptureState>();
const authProfileUpsertsByDomain = new Map<
  string,
  Promise<AuthProfileResolution>
>();
const CAPTURE_TAB_MAX = 500;
const CONTENT_SCRIPT_BUNDLE = 'pathfinder-content.js';
const CONTENT_SCRIPT_ORIGINS_KEY = 'runtime:content-script-origins';
let contentScriptOriginUpdate: Promise<void> = Promise.resolve();

async function readPersistedContentScriptOrigins(): Promise<Record<string, string>> {
  const stored = await chrome.storage.session.get(CONTENT_SCRIPT_ORIGINS_KEY);
  const value = stored[CONTENT_SCRIPT_ORIGINS_KEY];
  return value && typeof value === 'object'
    ? { ...(value as Record<string, string>) }
    : {};
}

function updatePersistedContentScriptOrigin(
  tabId: number,
  originPattern: string | null,
): Promise<void> {
  contentScriptOriginUpdate = contentScriptOriginUpdate.catch(() => {}).then(async () => {
    const origins = await readPersistedContentScriptOrigins();
    if (originPattern) {
      origins[String(tabId)] = originPattern;
    } else {
      delete origins[String(tabId)];
    }
    if (Object.keys(origins).length > 0) {
      await chrome.storage.session.set({ [CONTENT_SCRIPT_ORIGINS_KEY]: origins });
    } else {
      await chrome.storage.session.remove(CONTENT_SCRIPT_ORIGINS_KEY);
    }
  });
  return contentScriptOriginUpdate;
}

function appendCapturedApi(tabId: number, captured: CapturedApi): void {
  const captures = capturedApisByTab.get(tabId) ?? [];
  captures.push(captured);
  if (captures.length > CAPTURE_TAB_MAX) {
    captures.splice(0, captures.length - CAPTURE_TAB_MAX);
  }
  capturedApisByTab.set(tabId, captures);
}

// AI agent가 page_command/canvas_command로 탭을 운전 중인 윈도우.
// 이 시간 동안 캡처된 API는 origin='ai'로 태깅되어 사용자 capture session에서 제외된다.
// Map<tabId, expiresAtMs>. dispatchPageCommand 호출 시점에 ~2초 갱신.
const aiDrivingTabIds = new Map<number, number>();
const AI_DRIVE_WINDOW_MS = 2000;

function markAiDriving(tabId: number): void {
  aiDrivingTabIds.set(tabId, Date.now() + AI_DRIVE_WINDOW_MS);
}

function isAiDriving(tabId: number): boolean {
  const expires = aiDrivingTabIds.get(tabId);
  if (!expires) return false;
  if (Date.now() >= expires) {
    aiDrivingTabIds.delete(tabId);
    return false;
  }
  return true;
}

// ── User Capture Session State ──
// 사용자가 🔴 버튼으로 시작 → 같은 탭에서 발생한 origin='user' 캡처를 누적 → ⏹로 종료.
// 다른 탭으로 전환해도 원래 탭의 캡처만 모음 (사용자 요청).
interface CaptureSession {
  tabId: number;
  startedAt: number;
  captures: CapturedApi[];
}
let activeCaptureSession: CaptureSession | null = null;
const CAPTURE_SESSION_MAX = 500;
const CAPTURE_RESULT_TTL_MS = 5 * 60 * 1000;

// 캡처 종료 후 sidepanel이 mount되기 전 broadcast가 발사되는 race를 막기 위한 캐시.
// sidepanel이 GET_CAPTURE_RESULT로 한 번 가져가면 null로 소비.
let cachedCaptureResult: {
  apis: CapturedApi[];
  tabId: number;
  durationMs: number;
  captureCoverage: CaptureCoverage;
} | null = null;
let cachedCaptureResultTimer: ReturnType<typeof setTimeout> | null = null;

function clearCachedCaptureResult(): void {
  cachedCaptureResult = null;
  if (cachedCaptureResultTimer) {
    clearTimeout(cachedCaptureResultTimer);
    cachedCaptureResultTimer = null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isInjectableTabUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getMessageTabId(message: ExtensionMessage): number | undefined {
  const tabId = (message as { tabId?: unknown }).tabId;
  return typeof tabId === 'number' && Number.isInteger(tabId) ? tabId : undefined;
}

async function getTargetTab(tabId?: number): Promise<chrome.tabs.Tab | null> {
  if (typeof tabId === 'number') {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function newFrameCaptureState(): FrameCaptureState {
  return {
    discoveredFrameIds: new Set(),
    instrumentedFrameIds: new Set(),
    blockedFrameIds: new Set(),
    failedFrameIds: new Set(),
    instrumentedOrigins: new Set(),
    blockedOrigins: new Set(),
    observedRequestCount: 0,
    observedSubframeRequestCount: 0,
    rejectedCaptureCounts: new Map(),
    serviceWorkerControlled: false,
  };
}

function recordCaptureRejection(tabId: number, reason: CaptureRejectionReason): void {
  const state = frameCaptureStateByTab.get(tabId) ?? newFrameCaptureState();
  state.rejectedCaptureCounts.set(
    reason,
    (state.rejectedCaptureCounts.get(reason) ?? 0) + 1,
  );
  frameCaptureStateByTab.set(tabId, state);
}

function isCaptureRejectionReason(value: unknown): value is CaptureRejectionReason {
  return ['invalid_payload', 'oversized_payload', 'unsupported_url'].includes(String(value));
}

function safeFrameOrigin(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function safeUrlForLog(url?: string): string {
  if (!url) return 'unknown-url';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

function captureCoverageForTab(tabId: number): CaptureCoverage {
  const state = frameCaptureStateByTab.get(tabId) ?? newFrameCaptureState();
  const issues: CaptureCoverage['issues'] = [];
  if (state.blockedFrameIds.size > 0) {
    issues.push({
      code: 'cross_origin_frame_permission_required',
      severity: 'warning',
      count: state.blockedFrameIds.size,
      origins: [...state.blockedOrigins].slice(0, 12),
      message: '접근 권한이 없는 iframe의 API 요청은 캡처하지 못했습니다.',
    });
  }
  if (state.failedFrameIds.size > 0) {
    issues.push({
      code: 'frame_hook_injection_failed',
      severity: 'warning',
      count: state.failedFrameIds.size,
      message: '권한이 있지만 API hook을 주입하지 못한 iframe이 있습니다.',
    });
  }
  if (state.serviceWorkerControlled) {
    issues.push({
      code: 'service_worker_fetch_not_observable',
      severity: 'warning',
      message: '이 페이지는 Service Worker의 제어를 받고 있습니다. Worker 내부 fetch는 HAR/CDP 입력으로 보완해야 합니다.',
    });
  }
  const invalidCaptureCount = (
    (state.rejectedCaptureCounts.get('invalid_payload') ?? 0)
    + (state.rejectedCaptureCounts.get('unsupported_url') ?? 0)
  );
  if (invalidCaptureCount > 0) {
    issues.push({
      code: 'capture_payload_invalid',
      severity: 'warning',
      count: invalidCaptureCount,
      message: '페이지가 전달한 비정상 API 관찰 이벤트를 제외했습니다.',
    });
  }
  const oversizedCaptureCount = state.rejectedCaptureCounts.get('oversized_payload') ?? 0;
  if (oversizedCaptureCount > 0) {
    issues.push({
      code: 'capture_payload_oversized',
      severity: 'warning',
      count: oversizedCaptureCount,
      message: '안전 크기 상한을 넘는 API 관찰 이벤트를 제외했습니다.',
    });
  }
  issues.push({
    code: 'worker_fetch_not_observable',
    severity: 'info',
    message: 'Web Worker와 Shared Worker 내부 fetch는 page hook의 관찰 범위 밖입니다.',
  });
  return {
    discoveredFrameCount: state.discoveredFrameIds.size,
    instrumentedFrameCount: state.instrumentedFrameIds.size,
    blockedFrameCount: state.blockedFrameIds.size,
    failedFrameCount: state.failedFrameIds.size,
    observedRequestCount: state.observedRequestCount,
    observedSubframeRequestCount: state.observedSubframeRequestCount,
    instrumentedOrigins: [...state.instrumentedOrigins].slice(0, 12),
    blockedOrigins: [...state.blockedOrigins].slice(0, 12),
    serviceWorkerControlled: state.serviceWorkerControlled,
    workerTransportVisibility: 'not_observable',
    issues,
  };
}

async function frameUrlsForTab(tabId: number, fallbackUrl?: string): Promise<string[]> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  const urls = frames?.map((frame) => frame.url) ?? [];
  if (fallbackUrl) urls.unshift(fallbackUrl);
  return [...new Set(urls.filter(isInjectableTabUrl))];
}

async function detectServiceWorkerControl(tabId: number): Promise<boolean> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => Boolean(navigator.serviceWorker?.controller),
    world: 'ISOLATED' as any,
  }).catch(() => []);
  return results[0]?.result === true;
}

async function injectApiHookIntoFrame(
  tabId: number,
  frameId: number,
  frameUrl: string,
  state: FrameCaptureState,
): Promise<void> {
  state.discoveredFrameIds.add(frameId);
  const frameOrigin = safeFrameOrigin(frameUrl);
  const readiness = await inspectHostPermission(frameUrl);
  if (!readiness.ready) {
    state.blockedFrameIds.add(frameId);
    state.instrumentedFrameIds.delete(frameId);
    state.failedFrameIds.delete(frameId);
    if (frameOrigin) state.blockedOrigins.add(frameOrigin);
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: apiHookRelayFunction,
      world: 'ISOLATED' as any,
    });
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: mainWorldHookFunction,
      world: 'MAIN' as any,
    });
    state.instrumentedFrameIds.add(frameId);
    state.blockedFrameIds.delete(frameId);
    state.failedFrameIds.delete(frameId);
    if (frameOrigin) {
      state.instrumentedOrigins.add(frameOrigin);
      state.blockedOrigins.delete(frameOrigin);
    }
  } catch {
    state.failedFrameIds.add(frameId);
    state.instrumentedFrameIds.delete(frameId);
    state.blockedFrameIds.delete(frameId);
  }
}

async function injectApiHookIntoTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!isInjectableTabUrl(tab.url)) {
    throw new Error('API 캡처는 http/https 페이지에서만 사용할 수 있습니다.');
  }
  const readiness = await inspectHostPermission(tab.url);
  if (!readiness.ready) {
    throw new Error(readiness.reason);
  }

  await injectContentScriptIntoTab(tabId);
  const state = frameCaptureStateByTab.get(tabId) ?? newFrameCaptureState();
  frameCaptureStateByTab.set(tabId, state);
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  const currentFrames = frames?.filter((frame) => isInjectableTabUrl(frame.url)) ?? [{
    frameId: 0,
    parentFrameId: -1,
    url: tab.url!,
  }];
  await Promise.all(currentFrames.map((frame) =>
    injectApiHookIntoFrame(tabId, frame.frameId, frame.url, state)));
  state.serviceWorkerControlled = await detectServiceWorkerControl(tabId);
  hookedTabs.add(tabId);
}

async function injectContentScriptIntoTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!isInjectableTabUrl(tab.url)) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_BUNDLE],
    world: 'ISOLATED' as any,
  });
  contentScriptTabs.add(tabId);
  const originPattern = originPatternForUrl(tab.url);
  if (originPattern) {
    contentScriptOriginPatterns.set(tabId, originPattern);
    await updatePersistedContentScriptOrigin(tabId, originPattern);
  }
}

async function abortTabForPermission(
  tabId: number,
  reason: 'host_permission_required' | 'host_permission_revoked',
): Promise<void> {
  await unhookApiFrames(tabId);
  await chrome.tabs.sendMessage(tabId, {
    type: 'CONTENT_SCRIPT_SHUTDOWN',
    reason: 'host_permission_revoked',
  } satisfies ExtensionMessage).catch(() => {});
  hookedTabs.delete(tabId);
  frameCaptureStateByTab.delete(tabId);
  contentScriptTabs.delete(tabId);
  contentScriptOriginPatterns.delete(tabId);
  await updatePersistedContentScriptOrigin(tabId, null);
  capturedApisByTab.delete(tabId);
  aiDrivingTabIds.delete(tabId);
  if (cachedCaptureResult?.tabId === tabId) {
    clearCachedCaptureResult();
  }
  if (activeCaptureSession?.tabId === tabId) {
    activeCaptureSession = null;
    broadcastCaptureStatus({
      active: false,
      tabId,
      error: reason,
    });
  }
}

function completeCaptureSession(session: CaptureSession, options: { openPanel: boolean } = { openPanel: true }): void {
  const durationMs = Date.now() - session.startedAt;
  const captureCoverage = captureCoverageForTab(session.tabId);
  if (options.openPanel) {
    chrome.sidePanel.open({ tabId: session.tabId }).catch((err) => {
      console.warn('[XGEN SW] sidePanel.open on stop failed:', err);
    });
  }

  clearCachedCaptureResult();
  cachedCaptureResult = {
    apis: session.captures,
    tabId: session.tabId,
    durationMs,
    captureCoverage,
  };
  cachedCaptureResultTimer = setTimeout(clearCachedCaptureResult, CAPTURE_RESULT_TTL_MS);

  broadcastCaptureStatus({ active: false, tabId: session.tabId });
  broadcastToSidePanel({
    type: 'CAPTURE_SESSION_RESULT',
    apis: session.captures,
    tabId: session.tabId,
    durationMs,
    captureCoverage,
  });
}

async function unhookApiFrames(tabId: number): Promise<void> {
  const state = frameCaptureStateByTab.get(tabId);
  const frameIds = [...(state?.instrumentedFrameIds ?? new Set([0]))];
  await Promise.all(frameIds.map((frameId) =>
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: mainWorldUnhookFunction,
      world: 'MAIN' as any,
    }).catch(() => {})));
}

// ── Side Panel open on icon click ──

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// Extension action 클릭은 activeTab 권한을 부여한다. 설치 시 전역 host 권한 없이도
// 현재 페이지의 PageAgent를 사용자 동작으로만 주입한다.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !isInjectableTabUrl(tab.url)) return;
  injectContentScriptIntoTab(tab.id).catch((err) => {
    console.warn('[XGEN SW] content script injection on action click failed:', err);
  });
});

/**
 * origin이 XGEN 자체 호스트인지 — 이걸로 SET_ORIGIN/SET_TOKEN/resolver/startup migration 모두 검증.
 * fo.x2bee.com 같은 형제 서브도메인이 storage/메모리/resolver에 끼어들지 못하게 막는 single source of truth.
 * dev-xgen.x2bee.com / xgen-dev.x2bee.com 같은 환경별 XGEN 호스트는 허용한다.
 */
function isXgenHostedHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'xgen.x2bee.com' ||
    normalized.startsWith('xgen.') ||
    normalized.endsWith('.xgen.x2bee.com') ||
    /^(?:[a-z0-9-]+-)?xgen(?:-[a-z0-9-]+)?\.x2bee\.com$/.test(normalized)
  );
}

function isXgenOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    return isXgenHostedHost(parsed.hostname) || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function isXgenHostedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    return isXgenHostedHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

function sameOrigin(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// ── Startup: migrate stale storage from earlier buggy versions ──
// 과거 버그로 들어온 비-XGEN serverUrl / token:* 키를 정리. 사용자가 storage 직접 손대지 않아도 됨.
chrome.storage.local.get(null, (items) => {
  const toRemove: string[] = [];
  const stored = items[STORAGE_KEYS.SERVER_URL] as string | undefined;
  if (stored && !isXgenOrigin(stored)) {
    toRemove.push(STORAGE_KEYS.SERVER_URL);
    console.warn('[XGEN SW] Removing stale non-XGEN serverUrl:', safeUrlForLog(stored));
  }
  for (const key of Object.keys(items)) {
    if (key.startsWith('token:')) {
      const origin = key.slice(6);
      if (!isXgenOrigin(origin)) {
        toRemove.push(key);
        console.warn('[XGEN SW] Removing stale non-XGEN token key:', key);
      }
    }
  }
  if (toRemove.length > 0) {
    chrome.storage.local.remove(toRemove);
  }
});

// ── Message handling ──

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    switch (message.type) {
      case 'SET_TOKEN': {
        const origin = message.origin || sender.origin || '';
        // SET_ORIGIN과 동일하게 XGEN origin만 토큰 저장 — fo.x2bee.com 등 형제 서브도메인이
        // 자기 토큰을 우리 storage에 영구 박아넣지 못하게.
        if (origin && isXgenOrigin(origin)) {
          tokensByOrigin[origin] = message.token;
          chrome.storage.local.set({ [`token:${origin}`]: message.token });
          // SettingsBar 호환: 마지막 토큰을 기본값으로도 저장 (XGEN 토큰만)
          chrome.storage.local.set({ [STORAGE_KEYS.AUTH_TOKEN]: message.token });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SET_ORIGIN': {
        // content script(token-extractor)에서 자동 호출되므로 origin이 정말 XGEN인지 검증.
        const origin = message.origin || '';
        (async () => {
          if (!isXgenOrigin(origin)) {
            sendResponse({ ok: true });
            return;
          }
          const stored = await chrome.storage.local.get(STORAGE_KEYS.SERVER_URL);
          const storedUrl = stored[STORAGE_KEYS.SERVER_URL] as string | undefined;
          const shouldStore = isXgenHostedOrigin(origin)
            || !storedUrl
            || sameOrigin(storedUrl, origin)
            || !isLocalOrigin(origin);
          if (shouldStore) {
            chrome.storage.local.set({ [STORAGE_KEYS.SERVER_URL]: origin });
          }
          sendResponse({ ok: true });
        })();
        return true;
      }

      case 'GET_CHAT_CONFIG': {
        // sidePanel이 SSE를 직접 소비하기 위해 필요한 config 반환
        const targetTabId = getMessageTabId(message);
        (async () => {
          const settings = await chrome.storage.local.get([
            STORAGE_KEYS.PROVIDER,
            STORAGE_KEYS.MODEL,
          ]);
          const serverUrl = await resolveXgenServerUrl(targetTabId);
          const authToken = serverUrl ? (tokensByOrigin[serverUrl] || await getStoredToken(serverUrl)) : '';
          const pageContext = await getPageContextFromTab(targetTabId).catch(() => null);

          if (pageContext) {
            cachedPageContext = pageContext;
          }

          // SSE 스트리밍은 Next.js 프록시를 우회하여 gateway에 직접 연결해야 함
          // Next.js rewrites는 SSE 응답을 버퍼링하므로 실시간 스트리밍이 안 됨
          let streamUrl = serverUrl || '';
          if (streamUrl) {
            try {
              const parsed = new URL(streamUrl);
              // 로컬 환경에서만 프론트엔드(3000/3001) → gateway(8000)로 교체
              // 서버 환경(외부 도메인)에서는 포트 교체 안 함 (방화벽/프록시 이슈)
              const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
              if (isLocal && (parsed.port === '3000' || parsed.port === '3001')) {
                parsed.port = '8000';
                streamUrl = parsed.origin;
              }
            } catch { /* URL 파싱 실패 시 원본 사용 */ }
          }

          sendResponse({
            type: 'CHAT_CONFIG',
            serverUrl: streamUrl,
            authToken: authToken || '',
            provider: settings[STORAGE_KEYS.PROVIDER] || DEFAULT_PROVIDER,
            model: settings[STORAGE_KEYS.MODEL] || DEFAULT_MODEL,
            pageContext: pageContext || cachedPageContext,
          });
        })();
        return true; // async response
      }

      case 'RELAY_COMMAND': {
        // sidePanel이 SSE에서 받은 canvas_command/page_command를 SW로 위임
        const event = (message as any).event as SSEEvent;
        const targetTabId = getMessageTabId(message);
        console.log('[XGEN SW] RELAY_COMMAND received:', event.type);
        (async () => {
          const targetTab = await getTargetTab(targetTabId);

          if (event.type === 'canvas_command') {
            // 실제 페이지 조작 뒤 발생한 API만 AI-origin으로 분리한다.
            if (targetTab?.id) markAiDriving(targetTab.id);
            await sendToContentScript({
              type: 'CANVAS_COMMAND',
              requestId: (event as any).requestId || crypto.randomUUID(),
              action: event.action,
              params: event.params,
            }, targetTab?.id ?? targetTabId);
          } else if (event.type === 'page_command') {
            const requestId = (event as any).requestId || crypto.randomUUID();
            const apiHookResult = await handleApiHookAction(event.action, event.params, targetTab?.id ?? targetTabId);
            if (apiHookResult) {
              await postCommandResultToBackend(requestId, apiHookResult, targetTab?.id ?? targetTabId);
            } else {
              if (targetTab?.id) markAiDriving(targetTab.id);
              // 네비게이션 생존주기 처리 포함 디스패치
              await dispatchPageCommand(requestId, event.action, event.params, targetTab?.id ?? targetTabId);
            }
          }
          sendResponse({ ok: true });
        })();
        return true; // async response
      }

      case 'SEND_MESSAGE':
        // 레거시 호환: sidePanel이 직접 SSE를 소비하므로 더 이상 사용하지 않음
        sendResponse({ ok: true });
        break;

      case 'STOP_STREAM':
        sendResponse({ ok: true });
        break;

      case 'GET_PAGE_CONTEXT':
        getPageContextFromTab(getMessageTabId(message))
          .then((ctx) => sendResponse(ctx))
          .catch(() => sendResponse(null));
        return true; // async response

      case 'PAGE_CONTEXT_UPDATE': {
        const senderTabId = sender.tab?.id ?? null;
        cachedPageContext = message.context;
        cachedPageContextTabId = senderTabId;
        broadcastToSidePanel({
          type: 'PAGE_CONTEXT_UPDATE',
          context: message.context,
          tabId: senderTabId ?? undefined,
        });
        sendResponse({ ok: true });
        break;
      }

      case 'PAGE_COMMAND_RESULT':
        // DOM 재스캔 결과로 context 갱신
        if (message.result?.pageContext) {
          cachedPageContext = message.result.pageContext as PageContext;
        }
        // 백엔드 에이전트 루프에 결과 전달 — 다음 스텝 결정에 필요
        if (message.requestId) {
          postCommandResultToBackend(message.requestId, message.result, sender.tab?.id);
        }
        sendResponse({ ok: true });
        break;

      case 'CANVAS_RESULT':
        // canvas state 캐싱 — 다음 턴에 갱신된 state 제공
        if (message.result && cachedPageContext) {
          cachedPageContext = {
            ...cachedPageContext,
            data: { ...cachedPageContext.data, canvasState: message.result },
          };
        }
        // 백엔드 에이전트 루프에 결과 전달
        if (message.requestId) {
          postCommandResultToBackend(message.requestId, message.result, sender.tab?.id);
        }
        sendResponse({ ok: true });
        break;

      // ── API Hook: content script relay → SW 저장 ──
      case 'API_CAPTURED': {
        const tabId = sender.tab?.id || 0;
        const normalized = normalizeCapturedApi(message.data, { baseUrl: sender.url });
        if (!normalized.ok) {
          recordCaptureRejection(tabId, normalized.reason);
          sendResponse({ ok: false, reason: normalized.reason });
          break;
        }
        const captured = normalized.capture;
        const frameId = sender.frameId ?? 0;
        captured.tabId = tabId;
        captured.origin = isAiDriving(tabId) ? 'ai' : 'user';
        captured.captureContext = {
          kind: frameId === 0 ? 'top_frame' : 'subframe',
          frameId,
          ...(safeFrameOrigin(sender.url) ? {
            frameOrigin: safeFrameOrigin(sender.url),
          } : {}),
        };
        const frameState = frameCaptureStateByTab.get(tabId);
        if (frameState) {
          frameState.observedRequestCount += 1;
          if (frameId !== 0) frameState.observedSubframeRequestCount += 1;
        }

        appendCapturedApi(tabId, captured);

        // 사용자 capture session에 누적: 같은 탭 + origin='user'만
        if (
          activeCaptureSession &&
          activeCaptureSession.tabId === tabId &&
          captured.origin === 'user'
        ) {
          activeCaptureSession.captures.push(captured);
          if (activeCaptureSession.captures.length > CAPTURE_SESSION_MAX) {
            // FIFO: 오래된 것 버림
            activeCaptureSession.captures.shift();
          }
          broadcastCaptureStatus({
            active: true,
            tabId: activeCaptureSession.tabId,
            count: activeCaptureSession.captures.length,
          });
        }

        // 로그인 요청 감지 시 auth profile 즉시 자동 생성
        if (captured.method === 'POST' && /\/(login|auth|token|signin|oauth|session)/i.test(captured.url)) {
          autoCreateAuthProfileFromCapture(captured.url, tabId).catch(() => {});
        }

        sendResponse({ ok: true });
        break;
      }

      case 'API_CAPTURE_REJECTED': {
        const tabId = sender.tab?.id;
        if (
          tabId == null
          || activeCaptureSession?.tabId !== tabId
          || !isCaptureRejectionReason(message.reason)
        ) {
          sendResponse({ ok: false, reason: 'invalid_rejection_report' });
          break;
        }
        recordCaptureRejection(tabId, message.reason);
        sendResponse({ ok: true });
        break;
      }

      // ── User Capture Session ──
      case 'START_CAPTURE_SESSION': {
        const targetTabId = getMessageTabId(message);
        (async () => {
          try {
            const tab = await getTargetTab(targetTabId);
            const tabId = tab?.id;
            if (!tabId || !tab?.url) {
              sendResponse({ ok: false, error: 'No active tab' });
              return;
            }
            const readiness = await inspectHostPermission(tab.url);
            if (!readiness.ready) {
              sendResponse({
                ok: false,
                error: readiness.reason,
                reason: readiness.reason,
                readiness,
              });
              return;
            }
            frameCaptureStateByTab.set(tabId, newFrameCaptureState());
            await handlePickerHookInject(tabId);
            clearCachedCaptureResult();
            activeCaptureSession = { tabId, startedAt: Date.now(), captures: [] };
            broadcastCaptureStatus({ active: true, tabId, count: 0 });
            sendResponse({ ok: true, tabId });
          } catch (err) {
            const message = errorMessage(err);
            activeCaptureSession = null;
            console.warn('[XGEN SW] START_CAPTURE_SESSION failed:', err);
            broadcastCaptureStatus({ active: false, error: message });
            sendResponse({ ok: false, error: message });
          }
        })();
        return true;
      }

      case 'STOP_FLOATING_CAPTURE':
      case 'STOP_CAPTURE_SESSION': {
        if (!activeCaptureSession) {
          sendResponse({ ok: false, error: 'No active session' });
          break;
        }
        const session = activeCaptureSession;
        activeCaptureSession = null;
        unhookApiFrames(session.tabId).catch(() => {});
        hookedTabs.delete(session.tabId);
        completeCaptureSession(session, { openPanel: true });
        capturedApisByTab.delete(session.tabId);
        frameCaptureStateByTab.delete(session.tabId);
        sendResponse({
          ok: true,
          count: session.captures.length,
          bufferedCount: capturedApisByTab.get(session.tabId)?.length ?? 0,
        });
        break;
      }

      case 'GET_CAPTURE_RESULT': {
        // sidepanel이 STOP 이후 새로 열린 경우 broadcast를 놓쳤으니 직접 가져감.
        // 한 번 읽으면 소비 (다음 mount 시 재노출 방지).
        const result = cachedCaptureResult;
        clearCachedCaptureResult();
        sendResponse({ ok: true, result });
        break;
      }

      case 'GET_PERMISSION_READINESS': {
        (async () => {
          const targetTab = await getTargetTab(getMessageTabId(message));
          const targetUrl = message.url || targetTab?.url;
          const readiness = await inspectHostPermission(targetUrl);
          sendResponse({ ok: true, readiness });
        })().catch((err) => {
          sendResponse({
            ok: false,
            error: errorMessage(err),
            reason: 'host_permission_required',
          });
        });
        return true;
      }

      case 'LOOKUP_AUTH_PROFILE_FOR_HOST': {
        // host에 대해 등록된 인증 프로필의 service_id 조회. autoMatchAuthProfile 재사용 —
        // 같은 도메인 키워드 매칭 + 캡처된 로그인 fallback. 결과를 collection 등록 시
        // auth_profile_id로 같이 넘겨 tool row까지 자동 propagate.
        (async () => {
          try {
            const serverUrl = await resolveXgenServerUrl(getMessageTabId(message));
            const authToken = serverUrl
              ? (tokensByOrigin[serverUrl] || await getStoredToken(serverUrl))
              : '';
            if (!serverUrl || !authToken) {
              sendResponse({ ok: false, error: 'no XGEN auth' });
              return;
            }
            const resolution = await autoMatchAuthProfile(
              serverUrl, authToken, `https://${message.host}/`,
            );
            sendResponse({
              ok: true,
              authProfileId: resolution.authProfileId || null,
              authReadiness: resolution,
            });
          } catch (err) {
            console.warn('[XGEN SW] LOOKUP_AUTH_PROFILE_FOR_HOST failed:', err);
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      case 'GET_LIVE_COOKIES': {
        // 사용자 브라우저가 그 host에 대해 들고있는 fresh 쿠키를 모두 모아 Cookie 헤더 문자열로
        // 변환. 캡처 시점의 stale 쿠키 대신 호출 시점의 살아있는 세션 사용. host_permissions
        // <all_urls>가 manifest에 있어서 어떤 host든 읽기 가능.
        (async () => {
          try {
            const readiness = await inspectCookiePermission(
              message.url || `https://${message.host}/`,
            );
            if (!readiness.ready) {
              sendResponse({
                ok: false,
                error: readiness.reason,
                reason: readiness.reason,
                readiness,
              });
              return;
            }
            const cookies = await chrome.cookies.getAll({ domain: message.host });
            // 같은 이름이 여러 path에 걸려있으면 longest-path가 일반적으로 우선 — 단순화 위해
            // 첫 발견 우선. 도메인은 .x2bee.com과 fo.x2bee.com 둘 다 들어옴 (chrome 동작).
            const seen = new Set<string>();
            const parts: string[] = [];
            for (const c of cookies) {
              if (seen.has(c.name)) continue;
              seen.add(c.name);
              parts.push(`${c.name}=${c.value}`);
            }
            sendResponse({ ok: true, cookieHeader: parts.join('; '), count: cookies.length });
          } catch (err) {
            console.warn('[XGEN SW] GET_LIVE_COOKIES failed:', err);
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;  // async response
      }

      // ── Sidepanel → SW 직접 PAGE_COMMAND (register_tool 등) ──
      case 'PAGE_COMMAND': {
        if (!sender.tab) {
          // sidepanel에서 보낸 경우 (sender.tab 없음) → SW에서 직접 처리
          handleApiHookAction(message.action, message.params, getMessageTabId(message)).then((hookResult) => {
            sendResponse(hookResult || { success: false, action: message.action, error: 'Unknown action' });
          });
          return true;
        }
        sendResponse({ ok: true });
        break;
      }

      // ── Element Picker ──
      case 'ELEMENT_PICKER_START':
        sendToContentScript({ type: 'ELEMENT_PICKER_START' } as ExtensionMessage, getMessageTabId(message));
        sendResponse({ ok: true });
        break;

      case 'ELEMENT_PICKER_STOP': {
        const tabId3 = sender.tab?.id;
        if (tabId3) {
          // content script에서 보낸 경우 (요소 클릭 후) → hook inject
          handlePickerHookInject(tabId3)
            .then(() => sendResponse({ ok: true }))
            .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
          return true;
        }
        // sidepanel에서 보낸 경우 (취소 버튼) → content script에 stop 전달
        sendToContentScript({ type: 'ELEMENT_PICKER_STOP' } as ExtensionMessage, getMessageTabId(message));
        sendResponse({ ok: true });
        break;
      }

      case 'ELEMENT_PICKER_RESULT': {
        // content script에서 요소 클릭 후 2초 대기 후 호출됨
        const tabId4 = sender.tab?.id || 0;
        const captured2 = capturedApisByTab.get(tabId4) || [];
        const elementInfo = (message as any).elementInfo;

        // 캡처된 API를 sidepanel에 전달
        broadcastToSidePanel({
          type: 'ELEMENT_PICKER_RESULT',
          apis: captured2,
          elementInfo,
        } as ExtensionMessage);
        sendResponse({ ok: true });
        break;
      }
    }

    return false;
  },
);

// ── Restore per-origin tokens on startup ──

chrome.storage.local.get(null, (items) => {
  for (const [key, value] of Object.entries(items)) {
    if (key.startsWith('token:') && typeof value === 'string') {
      const origin = key.slice(6);
      // XGEN origin만 메모리에 로드. (storage 자체는 위 startup migration이 청소)
      if (isXgenOrigin(origin)) {
        tokensByOrigin[origin] = value;
      }
    }
  }
});

// ── (SSE는 sidePanel에서 직접 소비 — MV3 SW fetch streaming 제한 우회) ──

// ── Helpers ──

async function getOriginFromTab(tabId?: number): Promise<string | null> {
  const tab = await getTargetTab(tabId);
  if (tab?.url) {
    try {
      return new URL(tab.url).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * XGEN 서버 URL을 결정한다. 모든 단계에서 isXgenOrigin으로 검증 — 비-XGEN origin은 절대 반환 X.
 *
 * 1순위: storage에 저장된 serverUrl (단, XGEN origin인지 검증)
 * 2순위: active tab의 origin (xgen.* 또는 저장된 local serverUrl과 같은 origin)
 * 3순위: 토큰이 있는 XGEN origin (메모리 캐시)
 */
async function resolveXgenServerUrl(tabId?: number): Promise<string | null> {
  // 1순위: storage에 저장된 서버 URL — 반드시 XGEN origin이어야 함.
  // 이전 버그로 fo.x2bee.com 같은 게 저장돼있을 수 있어서 startup migration이 청소하지만
  // 런타임에서도 한 번 더 가드.
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SERVER_URL);
  const storedUrl = stored[STORAGE_KEYS.SERVER_URL] as string | undefined;
  if (storedUrl && isXgenOrigin(storedUrl)) {
    return storedUrl;
  }

  // 2순위: active tab의 origin. xgen.* 도메인은 바로 허용하되, localhost/127은
  // 저장된 serverUrl과 같은 origin일 때만 허용해 로컬 업무 사이트 오인을 줄인다.
  const tabOrigin = await getOriginFromTab(tabId);
  if (tabOrigin && (isXgenHostedOrigin(tabOrigin) || sameOrigin(tabOrigin, storedUrl))) {
    return tabOrigin;
  }

  // 3순위: 토큰이 있는 XGEN origin (메모리)
  const xgenOrigin = Object.keys(tokensByOrigin).find((o) => isXgenOrigin(o));
  if (xgenOrigin) return xgenOrigin;

  return null;
}

async function getStoredToken(origin: string): Promise<string> {
  const result = await chrome.storage.local.get([`token:${origin}`, STORAGE_KEYS.AUTH_TOKEN]);
  let token = result[`token:${origin}`] || '';
  if (!token) {
    token = await getXgenCookieToken(origin);
  }
  if (!token && result[STORAGE_KEYS.AUTH_TOKEN]) {
    token = result[STORAGE_KEYS.AUTH_TOKEN];
  }
  if (token) {
    tokensByOrigin[origin] = token; // 메모리 캐시에도 반영
    chrome.storage.local.set({ [`token:${origin}`]: token });
  }
  return token;
}

async function getXgenCookieToken(origin: string): Promise<string> {
  try {
    const readiness = await inspectCookiePermission(origin);
    if (!readiness.ready) return '';
    const cookies = await chrome.cookies.getAll({ url: `${origin.replace(/\/+$/, '')}/` });
    const preferredNames = [
      'xgen_access_token',
      'access_token',
      'accessToken',
      'token',
      'jwt',
    ];
    for (const name of preferredNames) {
      const found = cookies.find((cookie) => cookie.name === name && cookie.value);
      if (found) return found.value;
    }
  } catch {
    console.warn('[XGEN SW] cookie token lookup failed');
  }
  return '';
}

async function getPageContextFromTab(tabId?: number): Promise<PageContext | null> {
  const targetTab = await getTargetTab(tabId);
  if (!targetTab?.id) return null;

  const activeTabId = targetTab.id;

  // 캐시: 같은 탭 + 2초 이내일 때만 사용
  if (
    cachedPageContext &&
    cachedPageContextTabId === activeTabId &&
    Date.now() - cachedPageContext.timestamp < 2000
  ) {
    return cachedPageContext;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTabId, {
      type: 'GET_PAGE_CONTEXT',
    });
    if (response) {
      cachedPageContext = response;
      cachedPageContextTabId = activeTabId;
    }
    return response;
  } catch {
    return null;
  }
}

async function sendToContentScript(message: ExtensionMessage, tabId?: number) {
  const targetTab = await getTargetTab(tabId);
  if (targetTab?.id) {
    console.log('[XGEN SW] sendToContentScript:', message.type, 'to tab', targetTab.id);
    await chrome.tabs.sendMessage(targetTab.id, message).catch((err) => {
      console.error('[XGEN SW] sendToContentScript failed:', message.type, err);
    });
  } else {
    console.warn('[XGEN SW] sendToContentScript: no target tab found');
  }
}

/**
 * PAGE_COMMAND 전용 디스패치 — 네비게이션 생존주기 처리 포함.
 *
 * 클릭 등의 DOM 조작이 전체 페이지 네비게이션(window.location 변경)을 유발할 수 있다.
 * 이 경우 content script가 소멸하면서 결과 메시지가 유실되고 백엔드 bridge가 타임아웃된다.
 *
 * 해결: sendMessage 실패(채널 끊김) 시 네비게이션 완료를 대기하고,
 * 새 페이지의 context를 추출하여 백엔드에 성공 결과로 전달한다.
 */
async function dispatchPageCommand(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  targetTabId?: number,
): Promise<void> {
  const targetTab = await getTargetTab(targetTabId);
  if (!targetTab?.id) {
    await postCommandResultToBackend(requestId, {
      success: false, action, error: 'No target tab found',
    }, targetTabId);
    return;
  }

  const tabId = targetTab.id;
  const urlBefore = targetTab.url || '';

  try {
    // content script가 살아있으면 정상 실행 → PAGE_COMMAND_RESULT로 결과 전달됨
    await chrome.tabs.sendMessage(tabId, {
      type: 'PAGE_COMMAND',
      requestId,
      action,
      params,
    } as ExtensionMessage);
    // sendMessage resolved = content script가 sendResponse() 호출 = 정상 완료.
    // 결과는 content script가 별도 PAGE_COMMAND_RESULT 메시지로 이미 전송함.
  } catch {
    // ── content script 소멸 — 대부분 페이지 네비게이션 때문 ──
    console.log(
      `[XGEN SW] PAGE_COMMAND delivery failed (action=${action}); waiting for navigation`,
    );

    try {
      const newContext = await waitForNavigationContext(tabId, urlBefore);
      await postCommandResultToBackend(requestId, {
        success: true,
        action,
        pageContext: newContext,
      }, tabId);
      console.log(`[XGEN SW] Navigation handled: posted new page context to backend`);
    } catch (navErr) {
      // 네비게이션도 없고 content script도 죽은 경우 — 진짜 실패
      await postCommandResultToBackend(requestId, {
        success: false,
        action,
        error: `Content script disconnected, no navigation detected: ${navErr}`,
      }, tabId);
    }
  }
}

/**
 * 페이지 네비게이션 완료를 대기하고 새 페이지의 context를 추출한다.
 * 이미 네비게이션이 진행 중일 수 있으므로, onCompleted 리스너 + 폴링을 병행한다.
 */
function waitForNavigationContext(
  tabId: number,
  urlBefore: string,
  timeoutMs: number = 10000,
): Promise<PageContext | null> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.webNavigation.onCompleted.removeListener(onNavCompleted);
      clearTimeout(timer);
    };

    const extractAndResolve = async () => {
      if (settled) return;
      settled = true;
      cleanup();

      // content script 초기화 대기 — manifest의 content_scripts 주입에 시간이 필요
      await new Promise((r) => setTimeout(r, 800));

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const ctx = await chrome.tabs.sendMessage(tabId, {
            type: 'GET_PAGE_CONTEXT',
          });
          if (ctx) {
            resolve(ctx as PageContext);
            return;
          }
        } catch {
          // content script 아직 준비 안 됨 — 재시도
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // 3회 시도 실패 — 기본 context 생성
      try {
        const tab = await chrome.tabs.get(tabId);
        resolve({
          pageType: 'unknown',
          url: tab.url || '',
          title: tab.title || '',
          elements: '',
          snapshotId: '',
          data: {},
          availableActions: [],
          timestamp: Date.now(),
        } as PageContext);
      } catch {
        resolve(null);
      }
    };

    const onNavCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      console.log(`[XGEN SW] Navigation completed: ${safeUrlForLog(details.url)}`);
      extractAndResolve();
    };

    chrome.webNavigation.onCompleted.addListener(onNavCompleted);

    // 타임아웃 — 네비게이션이 없거나 너무 느린 경우
    const timer = setTimeout(() => {
      if (settled) return;
      // 타임아웃이지만 URL이 바뀌었을 수 있음 (onCompleted 놓침)
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.url && tab.url !== urlBefore) {
          extractAndResolve();
        } else {
          settled = true;
          cleanup();
          reject(new Error(`Navigation timeout (${timeoutMs}ms), URL unchanged`));
        }
      }).catch(() => {
        settled = true;
        cleanup();
        reject(new Error('Tab not found'));
      });
    }, timeoutMs);
  });
}

async function postCommandResultToBackend(
  requestId: string,
  result: unknown,
  targetTabId?: number,
) {
  const serverUrl = await resolveXgenServerUrl(targetTabId);
  if (!serverUrl) return;

  const authToken = tokensByOrigin[serverUrl] || (await getStoredToken(serverUrl));

  try {
    await fetch(`${serverUrl}/api/ai-chat/command-result/${requestId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(result),
    });
  } catch (err) {
    console.error('[XGEN SW] Failed to POST command result:', err);
  }
}

function broadcastToSidePanel(message: ExtensionMessage) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

/**
 * CAPTURE_SESSION_STATUS를 sidepanel과 (지정된) 탭 content script 둘 다로 전달.
 * 플로팅 overlay가 count/active 상태를 직접 보려면 tab 쪽으로도 보내야 한다.
 */
function broadcastCaptureStatus(payload: {
  active: boolean;
  tabId?: number;
  count?: number;
  error?: string;
}) {
  const msg: ExtensionMessage = { type: 'CAPTURE_SESSION_STATUS', ...payload };
  broadcastToSidePanel(msg);
  if (payload.tabId !== undefined) {
    chrome.tabs.sendMessage(payload.tabId, msg).catch(() => {});
  }
}

/** 외부 사이트에서만 우클릭 메뉴 노출 — XGEN/localhost는 의미 없음. */
function isCapturableHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname;
    if (isXgenHostedHost(h)) return false;
    if (h === 'localhost' || h === '127.0.0.1') return false;
    return true;
  } catch {
    return false;
  }
}

// ── Context Menu: 우클릭 → API 스캔 ──
const CTX_MENU_ID = 'xgen-api-scan';

chrome.runtime.onInstalled.addListener(() => {
  // 이전 항목이 있으면 제거 후 재생성 (개발 시 reload 안전).
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CTX_MENU_ID,
      title: 'XGEN: API 스캔 시작',
      contexts: ['page', 'frame', 'selection', 'link', 'image'],
      // documentUrlPatterns가 부정 매치를 못하므로, 클릭 시점에 isCapturableHost로 필터.
      documentUrlPatterns: ['*://*/*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CTX_MENU_ID) return;
  if (!tab?.id) return;

  const url = tab.url || info.pageUrl || '';
  if (!isCapturableHost(url)) {
    // XGEN/로컬 페이지에선 의미 없음 — 조용히 무시.
    return;
  }

  // 이미 다른 탭에서 캡처 중이면 우선 종료. (단순화: 동시 1개 세션만)
  if (activeCaptureSession && activeCaptureSession.tabId !== tab.id) {
    const prev = activeCaptureSession;
    activeCaptureSession = null;
    broadcastCaptureStatus({ active: false, tabId: prev.tabId });
    chrome.tabs.sendMessage(prev.tabId, { type: 'HIDE_FLOATING_OVERLAY' }).catch(() => {});
  }

  // Start 단계에서는 사이드패널을 열지 않는다 — 페이지 시야 확보가 우선.
  // 사이드패널은 정지 시(STOP_FLOATING_CAPTURE 핸들러)에 열어서 결과 리스트를 보여준다.

  try {
    const frameUrls = await frameUrlsForTab(tab.id, url);
    const readiness = await requestHostPermissions(frameUrls);
    if (!readiness.ready) {
      broadcastCaptureStatus({
        active: false,
        tabId: tab.id,
        error: readiness.reason,
      });
      return;
    }
    frameCaptureStateByTab.set(tab.id, newFrameCaptureState());
    await handlePickerHookInject(tab.id);
    activeCaptureSession = { tabId: tab.id, startedAt: Date.now(), captures: [] };

    // overlay 표시 — content script가 안 떠있는 탭(확장 reload 후 기존 탭)에서도 동작하도록
    // tabs.sendMessage 실패하면 scripting.executeScript로 직접 주입.
    await showFloatingOverlayOnTab(tab.id);
    broadcastCaptureStatus({ active: true, tabId: tab.id, count: 0 });
  } catch (err) {
    const message = errorMessage(err);
    activeCaptureSession = null;
    console.warn('[XGEN SW] context capture start failed:', err);
    broadcastCaptureStatus({ active: false, tabId: tab.id, error: message });
  }
});

/**
 * 탭에 floating overlay 표시. content script가 이미 주입돼있으면 그쪽 listener가
 * SHOW_FLOATING_OVERLAY를 받아 띄움. 아니면 chrome.scripting.executeScript로 페이지에
 * 인라인 overlay 주입 (count 갱신은 chrome.runtime.onMessage listener도 같이 등록).
 */
async function showFloatingOverlayOnTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_FLOATING_OVERLAY' });
    return;
  } catch {
    // content script not loaded — fall through to scripting injection
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: _injectFloatingOverlayInline,
    });
  } catch (err) {
    console.warn('[XGEN SW] floating overlay scripting fallback failed:', err);
  }
}

/**
 * scripting.executeScript용 — page isolated world에서 실행. 호스트 페이지에 overlay 주입 +
 * STOP 클릭/STATUS 갱신/HIDE 처리 로직을 모두 인라인으로 가짐. content script가 떠있으면
 * 중복 주입 방지(id 체크).
 */
function _injectFloatingOverlayInline(): void {
  const HOST_ID = '__xgen_floating_overlay__';
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;top:0;right:0;z-index:2147483647;';

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .root {
        position: fixed; top: 16px; right: 16px;
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px;
        background: #1f2937; color: #fff;
        border-radius: 999px;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
      }
      .dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #ef4444;
        animation: xgen-pulse 1.4s infinite;
      }
      @keyframes xgen-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.85); }
      }
      .count {
        background: rgba(255, 255, 255, 0.15);
        padding: 2px 8px; border-radius: 999px;
        min-width: 20px; text-align: center;
      }
      .stop {
        all: unset; cursor: pointer;
        width: 22px; height: 22px;
        display: inline-flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.12);
        border-radius: 50%;
      }
      .stop:hover { background: #ef4444; }
    </style>
    <div class="root">
      <span class="dot"></span>
      <span>API 녹화 중</span>
      <span class="count">0</span>
      <button class="stop" type="button" title="정지">
        <svg viewBox="0 0 14 14" fill="currentColor" width="10" height="10">
          <rect x="1" y="1" width="12" height="12" rx="2"/>
        </svg>
      </button>
    </div>
  `;

  const stopBtn = shadow.querySelector('.stop') as HTMLButtonElement | null;
  const countEl = shadow.querySelector('.count') as HTMLSpanElement | null;

  stopBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_FLOATING_CAPTURE' });
  });

  // SW가 broadcast하는 STATUS를 받아 count 갱신 + active=false면 자체 제거.
  const onMsg = (msg: { type?: string; active?: boolean; count?: number }) => {
    if (msg?.type !== 'CAPTURE_SESSION_STATUS') return;
    if (msg.active === false) {
      chrome.runtime.onMessage.removeListener(onMsg);
      host.remove();
    } else if (typeof msg.count === 'number' && countEl) {
      countEl.textContent = String(msg.count);
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);

  (document.documentElement || document.body).appendChild(host);
}

// ── API Hook: page_command 액션 처리 ──

const API_HOOK_ACTIONS = new Set([
  'start_api_hook',
  'stop_api_hook',
  'get_captured_apis',
  'clear_captured_apis',
  'register_tool',
]);

/**
 * API Hook 관련 page_command 액션을 SW에서 직접 처리.
 * 해당 액션이면 결과를 반환, 아니면 null 반환 (content script로 전달).
 */
async function handleApiHookAction(
  action: string,
  params: Record<string, unknown>,
  targetTabId?: number,
): Promise<import('../shared/types').PageCommandResult | null> {
  if (!API_HOOK_ACTIONS.has(action)) return null;

  try {
    switch (action) {
      case 'start_api_hook': {
        const targetTab = await getTargetTab(targetTabId);
        if (!targetTab?.id) {
          return { success: false, action, error: 'Target tab not found' };
        }
        const tabId = targetTab.id;

        if (hookedTabs.has(tabId)) {
          return { success: true, action, result: 'API hook already active' };
        }

        await injectApiHookIntoTab(tabId);
        capturedApisByTab.set(tabId, []);
        return { success: true, action, result: 'API hook started. All fetch/XHR requests on this page will be captured.' };
      }

      case 'stop_api_hook': {
        const targetTab = await getTargetTab(targetTabId);
        if (!targetTab?.id) {
          return { success: false, action, error: 'Target tab not found' };
        }
        const tabId = targetTab.id;

        await chrome.scripting.executeScript({
          target: { tabId },
          func: mainWorldUnhookFunction,
          world: 'MAIN' as any,
        }).catch(() => {});

        const count = capturedApisByTab.get(tabId)?.length || 0;
        hookedTabs.delete(tabId);
        return { success: true, action, result: `API hook stopped. ${count} requests captured.` };
      }

      case 'get_captured_apis': {
        const tabId = (await getTargetTab(targetTabId))?.id || 0;
        const captured = capturedApisByTab.get(tabId) || [];

        // 필터 적용
        let filtered = captured;
        if (params.url_pattern) {
          const pattern = (params.url_pattern as string).toLowerCase();
          filtered = filtered.filter((a) => a.url.toLowerCase().includes(pattern));
        }
        if (params.method) {
          const method = (params.method as string).toUpperCase();
          filtered = filtered.filter((a) => a.method === method);
        }
        if (params.min_status) {
          filtered = filtered.filter((a) => a.responseStatus >= (params.min_status as number));
        }
        if (params.max_status) {
          filtered = filtered.filter((a) => a.responseStatus <= (params.max_status as number));
        }

        // command result는 XGEN backend로 전달된다. 캡처 원문 값은 보내지 않고
        // URL/query key, body kind 및 field path 같은 구조만 반환한다.
        const summary = filtered.map(summarizeCapturedApiForCommand);

        return {
          success: true,
          action,
          result: {
            total: captured.length,
            filtered: filtered.length,
            apis: summary,
          },
        };
      }

      case 'clear_captured_apis': {
        const tabId = (await getTargetTab(targetTabId))?.id || 0;
        const count = capturedApisByTab.get(tabId)?.length || 0;
        capturedApisByTab.set(tabId, []);
        return { success: true, action, result: `Cleared ${count} captured APIs.` };
      }

      case 'register_tool': {
        const toolData = params as Record<string, unknown>;
        const apiUrl = normalizeLegacyApiUrl(toolData.api_url);
        const apiMethod = ((toolData.api_method as string) || 'GET').toUpperCase();

        // XGEN 서버 URL 결정
        const serverUrl = (toolData.server_url as string | undefined) || await resolveXgenServerUrl(targetTabId);
        if (!serverUrl) {
          return { success: false, action, error: 'XGEN server URL not found. Log in to XGEN first.' };
        }

        const authToken = tokensByOrigin[serverUrl] || await getStoredToken(serverUrl);
        if (!authToken) {
          return { success: false, action, error: `Not logged in to ${serverUrl}` };
        }

        // 인증 프로필 자동 매칭: api_url 도메인과 일치하는 auth profile 찾기
        let authProfileId = toolData.auth_profile_id as string | undefined;
        if (!authProfileId) {
          const resolution = await autoMatchAuthProfile(
            serverUrl,
            authToken,
            apiUrl,
          );
          if (resolution.status === 'login_required') {
            return {
              success: false,
              action,
              error: `이 API는 인증이 필요하지만 로그인 요청이 캡처되지 않았습니다. ` +
                `start_api_hook이 켜진 상태에서 로그인이 수행되어야 인증 프로필이 자동 생성됩니다. ` +
                `해결 방법: (1) start_api_hook이 켜져 있는지 확인 후, (2) 로그아웃 → 재로그인으로 토큰을 재발급받은 다음, (3) register_tool을 다시 시도하세요.`,
            };
          }
          if (resolution.status === 'ambiguous') {
            return {
              success: false,
              action,
              error: '여러 인증 프로필이 동일 host 후보로 확인되었습니다. XGEN Collection에서 인증 프로필을 명시적으로 선택해주세요.',
            };
          }
          authProfileId = resolution.authProfileId;
        }

        // 모든 탭 캡처에서 query/fragment를 제외한 URL + method가 일치하는
        // 가장 최근 요청을 찾는다. 원문 값은 저장하지 않고 body schema 추론에만 쓴다.
        let matched: CapturedApi | undefined;
        for (const [, apis] of capturedApisByTab) {
          for (const capture of apis) {
            let capturedUrl: string;
            try {
              capturedUrl = normalizeLegacyApiUrl(capture.url);
            } catch {
              continue;
            }
            if (capture.method.toUpperCase() === apiMethod && capturedUrl === apiUrl) {
              if (!matched || capture.timestamp > matched.timestamp) matched = capture;
            }
          }
        }

        const safeContent = buildValueFreeLegacyToolContent(
          { ...toolData, api_url: apiUrl, api_method: apiMethod },
          matched,
        );

        // tool 저장 요청
        const savePayload = {
          function_name: safeContent.function_name,
          content: {
            ...safeContent,
            ...(authProfileId ? { auth_profile_id: authProfileId } : {}),
          },
        };

        const response = await fetch(`${serverUrl}/api/tools/storage/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(savePayload),
        });

        const result = await response.json();
        if (!response.ok) {
          return { success: false, action, error: result.detail || `HTTP ${response.status}` };
        }

        const authInfo = authProfileId
          ? ` (auth_profile: ${authProfileId})`
          : '';
        return {
          success: true,
          action,
          result: `Tool "${safeContent.function_name}" registered successfully to ${serverUrl}${authInfo}`,
        };
      }

      default:
        return null;
    }
  } catch (err) {
    return {
      success: false,
      action,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Auth Profile 자동 매칭 ──

/**
 * api_url의 도메인과 일치하는 auth profile을 찾거나, 없으면 캡처된 인증 헤더로 자동 생성.
 */
type AuthResolutionStatus =
  | 'linked_collection'
  | 'matched_exact'
  | 'created'
  | 'updated'
  | 'missing'
  | 'ambiguous'
  | 'login_required'
  | 'profile_inactive'
  | 'backend_error';

interface AuthProfileResolution {
  status: AuthResolutionStatus;
  authProfileId?: string;
  source?: 'collection' | 'profile' | 'capture';
  collectionId?: string;
  candidateIds?: string[];
}

async function fetchAuthProfiles(
  serverUrl: string,
  authToken: string,
): Promise<AuthProfileSummary[]> {
  const response = await fetch(`${serverUrl}/api/session-station/v1/auth-profiles`, {
    headers: xgenAuthHeaders(authToken),
  });
  if (!response.ok) {
    throw new Error(`auth profile list failed: ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload as AuthProfileSummary[] : [];
}

async function fetchApiCollectionsForAuth(
  serverUrl: string,
  authToken: string,
): Promise<CollectionAuthSummary[]> {
  const response = await fetch(`${serverUrl}/api/tools/api-collections`, {
    headers: xgenAuthHeaders(authToken),
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload) ? payload as CollectionAuthSummary[] : [];
}

async function upsertCapturedLoginProfileUnlocked(
  serverUrl: string,
  authToken: string,
  apiDomain: string,
  capturedLogin: CapturedLogin,
): Promise<AuthProfileResolution> {
  const profiles = await fetchAuthProfiles(serverUrl, authToken);
  const serviceId = canonicalAuthServiceId(apiDomain);
  const profileData = buildAuthProfileFromLogin(
    serviceId,
    apiDomain,
    capturedLogin,
  );
  const existing = profiles.find(
    (profile) => profile.service_id.toLowerCase() === serviceId.toLowerCase(),
  );

  if (existing) {
    if ((existing.status ?? 'active') !== 'active') {
      return { status: 'profile_inactive', source: 'profile' };
    }
    if (!isPathfinderManagedProfile(existing, apiDomain)) {
      return {
        status: 'matched_exact',
        source: 'profile',
        authProfileId: existing.service_id,
      };
    }
    const { service_id: _serviceId, ...updateData } = profileData;
    const updateResponse = await fetch(
      `${serverUrl}/api/session-station/v1/auth-profiles/${encodeURIComponent(existing.service_id)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...xgenAuthHeaders(authToken),
        },
        body: JSON.stringify(updateData),
      },
    );
    if (!updateResponse.ok) {
      return { status: 'backend_error', source: 'capture' };
    }
    return {
      status: 'updated',
      source: 'capture',
      authProfileId: existing.service_id,
    };
  }

  const createResponse = await fetch(
    `${serverUrl}/api/session-station/v1/auth-profiles`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...xgenAuthHeaders(authToken),
      },
      body: JSON.stringify(profileData),
    },
  );
  if (createResponse.ok || createResponse.status === 409) {
    return {
      status: createResponse.ok ? 'created' : 'matched_exact',
      source: 'capture',
      authProfileId: serviceId,
    };
  }
  return { status: 'backend_error', source: 'capture' };
}

async function upsertCapturedLoginProfile(
  serverUrl: string,
  authToken: string,
  apiDomain: string,
  capturedLogin: CapturedLogin,
): Promise<AuthProfileResolution> {
  const key = `${serverUrl}\n${apiDomain.toLowerCase()}`;
  const previous = authProfileUpsertsByDomain.get(key);
  const current = (previous ?? Promise.resolve({ status: 'missing' } as AuthProfileResolution))
    .catch(() => ({ status: 'backend_error' } as AuthProfileResolution))
    .then(() => upsertCapturedLoginProfileUnlocked(
      serverUrl,
      authToken,
      apiDomain,
      capturedLogin,
    ));
  authProfileUpsertsByDomain.set(key, current);
  try {
    return await current;
  } finally {
    if (authProfileUpsertsByDomain.get(key) === current) {
      authProfileUpsertsByDomain.delete(key);
    }
  }
}

async function autoMatchAuthProfile(
  serverUrl: string,
  authToken: string,
  apiUrl: string,
): Promise<AuthProfileResolution> {
  try {
    let apiDomain: string;
    try {
      const u = new URL(apiUrl);
      apiDomain = u.hostname;
    } catch {
      return { status: 'missing' };
    }
    if (apiDomain === 'localhost') return { status: 'missing' };

    const [collections, profiles] = await Promise.all([
      fetchApiCollectionsForAuth(serverUrl, authToken),
      fetchAuthProfiles(serverUrl, authToken),
    ]);
    const collectionMatch = matchCollectionAuthProfile(apiDomain, collections);
    if (collectionMatch.status === 'ambiguous') {
      return {
        status: 'ambiguous',
        source: 'collection',
        candidateIds: collectionMatch.candidateIds,
      };
    }
    if (collectionMatch.status === 'matched' && collectionMatch.authProfileId) {
      const linked = profiles.find(
        (profile) => profile.service_id === collectionMatch.authProfileId,
      );
      if (!linked) return { status: 'missing', source: 'collection' };
      if ((linked.status ?? 'active') !== 'active') {
        return { status: 'profile_inactive', source: 'collection' };
      }
      return {
        status: 'linked_collection',
        source: 'collection',
        authProfileId: linked.service_id,
        collectionId: collectionMatch.collectionId,
      };
    }

    const profileMatch = matchExactAuthProfile(apiDomain, profiles);
    if (profileMatch.status === 'ambiguous') {
      return {
        status: 'ambiguous',
        source: 'profile',
        candidateIds: profileMatch.candidateIds,
      };
    }
    if (profileMatch.status === 'matched' && profileMatch.authProfileId) {
      return {
        status: 'matched_exact',
        source: 'profile',
        authProfileId: profileMatch.authProfileId,
      };
    }

    const capturedLogin = findCapturedLoginForDomain(apiDomain);
    if (capturedLogin) {
      return upsertCapturedLoginProfile(
        serverUrl,
        authToken,
        apiDomain,
        capturedLogin,
      );
    }
    return findCapturedAuthForDomain(apiDomain)
      ? { status: 'login_required', source: 'capture' }
      : { status: 'missing' };
  } catch (e) {
    console.warn('[XGEN SW] autoMatchAuthProfile error:', e);
    return { status: 'backend_error' };
  }
}

/**
 * 캡처된 API에서 로그인 요청을 찾는다.
 * POST 메서드 + URL에 login/auth/token/signin 포함 + 요청 body에 자격증명 포함
 */
interface CapturedLogin {
  url: string;
  method: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  responseBody: Record<string, unknown>;
  tokenFields: { name: string; keyPath: string }[];
}

function findCapturedLoginForDomain(domain: string): CapturedLogin | null {
  const loginUrlPatterns = /\/(login|auth|token|signin|oauth|session)/i;

  for (const [, apis] of capturedApisByTab) {
    for (const api of apis) {
      if (api.method !== 'POST') continue;

      try {
        if (new URL(api.url).hostname.toLowerCase() !== domain.toLowerCase()) continue;
      } catch { continue; }

      if (!loginUrlPatterns.test(api.url)) continue;

      // request body 파싱
      let payload: Record<string, unknown> = {};
      if (api.requestBody) {
        try { payload = JSON.parse(api.requestBody); } catch { continue; }
      }
      if (Object.keys(payload).length === 0) continue;

      // response body에서 토큰 필드 탐지
      let responseBody: Record<string, unknown> = {};
      if (api.responseBody) {
        try { responseBody = JSON.parse(api.responseBody); } catch { continue; }
      }

      // 토큰 필드 찾기
      const tokenFieldNames = ['access_token', 'accessToken', 'token', 'jwt', 'id_token', 'auth_token', 'session_token'];
      const tokenFields: { name: string; keyPath: string }[] = [];
      const foundNames = new Set<string>();

      // 1단계: 루트 레벨
      for (const fieldName of tokenFieldNames) {
        if (responseBody[fieldName] && typeof responseBody[fieldName] === 'string') {
          tokenFields.push({ name: fieldName, keyPath: fieldName });
          foundNames.add(fieldName);
        }
      }

      // 2단계: 중첩 구조 (payload.accessToken, data.token 등)
      for (const [topKey, topVal] of Object.entries(responseBody)) {
        if (typeof topVal === 'object' && topVal !== null) {
          for (const fieldName of tokenFieldNames) {
            if (!foundNames.has(fieldName) && (topVal as any)[fieldName] && typeof (topVal as any)[fieldName] === 'string') {
              tokenFields.push({ name: fieldName, keyPath: `${topKey}.${fieldName}` });
              foundNames.add(fieldName);
            }
          }
        }
      }

      if (tokenFields.length === 0) continue;

      // request headers에서 Content-Type만 보존
      const headers: Record<string, string> = {};
      const ct = api.requestHeaders['content-type'] || api.requestHeaders['Content-Type'];
      if (ct) headers['Content-Type'] = ct;

      const parsedLoginUrl = new URL(api.url);
      console.log(
        `[XGEN SW] Found login request: ${api.method} `
        + `${parsedLoginUrl.origin}${parsedLoginUrl.pathname}, `
        + `token fields: ${tokenFields.map((field) => field.name).join(', ')}`,
      );

      return {
        url: api.url,
        method: api.method,
        headers,
        payload,
        responseBody,
        tokenFields,
      };
    }
  }
  return null;
}

/**
 * 캡처된 로그인 요청으로 auto-refresh 가능한 auth profile을 생성한다.
 */
function buildAuthProfileFromLogin(
  serviceId: string,
  domain: string,
  login: CapturedLogin,
) {
  // 주요 토큰 필드 (첫 번째를 access_token으로 사용)
  const primaryToken = login.tokenFields[0];

  // extraction rules: 응답 body에서 토큰 추출
  const extractionRules = login.tokenFields.map((f) => ({
    name: f.name,
    source: 'body' as const,
    key_path: f.keyPath,
  }));

  // injection rules: Authorization: Bearer {access_token}
  const injectionRules = [
    {
      source_field: primaryToken.name,
      target: 'header',
      key: 'Authorization',
      value_template: `Bearer {${primaryToken.name}}`,
      required: true,
    },
  ];

  return {
    service_id: serviceId,
    name: `${domain} (자동 생성)`,
    description: `${PATHFINDER_MANAGED_MARKER} 캡처된 로그인 요청으로 자동 생성된 인증 프로필. 토큰 만료 시 자동 갱신됩니다.`,
    auth_type: 'bearer',
    login_config: {
      url: login.url,
      method: login.method,
      headers: login.headers,
      payload: login.payload,
      timeout: 30,
    },
    extraction_rules: extractionRules,
    injection_rules: injectionRules,
    ttl: 3600,
    refresh_before_expire: 300,
  };
}

/**
 * 캡처된 API 데이터에서 특정 도메인의 인증 헤더를 찾는다. (fallback)
 */
function findCapturedAuthForDomain(domain: string): { type: string; key: string; value: string } | null {
  for (const [, apis] of capturedApisByTab) {
    for (const api of apis) {
      try {
        if (new URL(api.url).hostname.toLowerCase() !== domain.toLowerCase()) continue;
      } catch { continue; }

      for (const [key, value] of Object.entries(api.requestHeaders)) {
        const k = key.toLowerCase();
        if (k === 'authorization' && value.toLowerCase().startsWith('bearer ')) {
          return { type: 'bearer', key: 'Authorization', value };
        }
        if (k === 'authorization' && value.toLowerCase().startsWith('basic ')) {
          return { type: 'basic', key: 'Authorization', value };
        }
        if (k === 'x-api-key') {
          return { type: 'api_key', key: 'X-API-Key', value };
        }
      }
    }
  }
  return null;
}

// ── 로그인 캡처 시 auth profile 즉시 생성 ──

async function autoCreateAuthProfileFromCapture(loginUrl: string, tabId?: number) {
  try {
    const apiDomain = new URL(loginUrl).hostname;
    const serverUrl = await resolveXgenServerUrl(tabId);
    if (!serverUrl) return;

    const authToken = tokensByOrigin[serverUrl] || await getStoredToken(serverUrl);
    if (!authToken) return;

    const capturedLogin = findCapturedLoginForDomain(apiDomain);
    if (!capturedLogin) return;
    await upsertCapturedLoginProfile(
      serverUrl,
      authToken,
      apiDomain,
      capturedLogin,
    );
  } catch (e) {
    console.warn('[XGEN SW] autoCreateAuthProfileFromCapture error:', e);
  }
}

// ── Element Picker: hook inject ──
async function handlePickerHookInject(tabId: number) {
  await injectApiHookIntoTab(tabId);
  capturedApisByTab.set(tabId, []);
}

// ── 탭 닫힘 시 정리 ──
chrome.tabs.onRemoved.addListener((tabId) => {
  hookedTabs.delete(tabId);
  frameCaptureStateByTab.delete(tabId);
  contentScriptTabs.delete(tabId);
  contentScriptOriginPatterns.delete(tabId);
  updatePersistedContentScriptOrigin(tabId, null).catch(() => {});
  capturedApisByTab.delete(tabId);
  aiDrivingTabIds.delete(tabId);
  if (activeCaptureSession?.tabId === tabId) {
    // 세션 중인 탭이 닫혔으면 그 시점까지의 캡처를 사이드패널로 보내고 세션 종료.
    // 탭이 이미 사라졌으니 tabs.sendMessage는 fail하지만 broadcastCaptureStatus가 catch.
    const session = activeCaptureSession;
    activeCaptureSession = null;
    completeCaptureSession(session, { openPanel: false });
  }
});

// ── 페이지 네비게이션 감지: 후킹된 탭에서 페이지 이동 시 자동 재주입 + 기록 ──
chrome.webNavigation.onCompleted.addListener(async (details) => {
  const tabId = details.tabId;

  if (!hookedTabs.has(tabId)) return;

  const readiness = await inspectHostPermission(details.url);
  if (!readiness.ready) {
    if (details.frameId === 0) {
      await abortTabForPermission(tabId, 'host_permission_required');
    } else {
      const state = frameCaptureStateByTab.get(tabId) ?? newFrameCaptureState();
      state.discoveredFrameIds.add(details.frameId);
      state.blockedFrameIds.add(details.frameId);
      state.instrumentedFrameIds.delete(details.frameId);
      state.failedFrameIds.delete(details.frameId);
      const frameOrigin = safeFrameOrigin(details.url);
      if (frameOrigin) state.blockedOrigins.add(frameOrigin);
      frameCaptureStateByTab.set(tabId, state);
    }
    return;
  }

  if (details.frameId !== 0) {
    const state = frameCaptureStateByTab.get(tabId) ?? newFrameCaptureState();
    frameCaptureStateByTab.set(tabId, state);
    await injectApiHookIntoFrame(
      tabId,
      details.frameId,
      details.url,
      state,
    );
    return;
  }

  // 네비게이션 기록을 캡처 데이터에 추가
  appendCapturedApi(tabId, {
    id: crypto.randomUUID(),
    tabId,
    timestamp: Date.now(),
    url: details.url,
    method: 'NAVIGATION',
    requestHeaders: {},
    requestBody: null,
    responseStatus: 200,
    responseHeaders: {},
    responseBody: null,
    contentType: '',
    duration: 0,
  } as CapturedApi);

  // hook 자동 재주입 (페이지 이동으로 이전 hook 소멸)
  try {
    await injectApiHookIntoTab(tabId);
    console.log(`[XGEN SW] API hook re-injected after navigation: ${safeUrlForLog(details.url)}`);
  } catch (err) {
    hookedTabs.delete(tabId);
    console.warn('[XGEN SW] Failed to re-inject hook:', err);
  }
});

chrome.permissions.onRemoved.addListener((removed) => {
  (async () => {
    if (removed.permissions?.includes('cookies')) {
      for (const origin of Object.keys(tokensByOrigin)) {
        delete tokensByOrigin[origin];
      }
    }
    if (!removed.origins?.length) return;
    await contentScriptOriginUpdate;
    const persistedOrigins = await readPersistedContentScriptOrigins();
    const affectedTabs = new Set([
      ...hookedTabs,
      ...contentScriptTabs,
      ...Object.keys(persistedOrigins).map(Number),
    ]);
    for (const tabId of affectedTabs) {
      const originPattern = contentScriptOriginPatterns.get(tabId)
        || persistedOrigins[String(tabId)];
      const stillGranted = originPattern
        ? await chrome.permissions.contains({ origins: [originPattern] })
        : false;
      if (!stillGranted) {
        await abortTabForPermission(tabId, 'host_permission_revoked');
      }
    }
  })().catch((err) => {
    console.warn('[XGEN SW] permission revoke cleanup failed:', err);
  });
});
