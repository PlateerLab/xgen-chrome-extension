/**
 * Content script (isolated world)에서 실행.
 * MAIN world의 CustomEvent를 받아 service worker로 전달.
 */
export function apiHookRelayFunction() {
  if ((window as any).__xgenApiRelayActive) return;
  (window as any).__xgenApiRelayActive = true;

  const relayCapturedApi = ((event: CustomEvent) => {
    chrome.runtime.sendMessage({
      type: 'API_CAPTURED',
      data: event.detail,
    }).catch(() => {});
  }) as EventListener;
  const stopRelay = ((event: CustomEvent) => {
    if (event.detail?.active !== false) return;
    window.removeEventListener('xgen:api-captured', relayCapturedApi);
    window.removeEventListener('xgen:api-hook-control', stopRelay);
    (window as any).__xgenApiRelayActive = false;
  }) as EventListener;
  window.addEventListener('xgen:api-captured', relayCapturedApi);
  window.addEventListener('xgen:api-hook-control', stopRelay);

  console.log('[XGEN API Relay] 릴레이 활성화');
}
