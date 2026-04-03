/**
 * Content script (isolated world)에서 실행.
 * MAIN world의 CustomEvent를 받아 service worker로 전달.
 */
export function apiHookRelayFunction() {
  if ((window as any).__xgenApiRelayActive) return;
  (window as any).__xgenApiRelayActive = true;

  window.addEventListener('xgen:api-captured', ((event: CustomEvent) => {
    chrome.runtime.sendMessage({
      type: 'API_CAPTURED',
      data: event.detail,
    }).catch(() => {});
  }) as EventListener);

  console.log('[XGEN API Relay] 릴레이 활성화');
}
