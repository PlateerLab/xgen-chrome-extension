import { PageAgent } from './page-agent/page-agent';
import { extractAndSendToken, watchTokenChanges } from './token-extractor';
import { injectCursorOverride } from './cursor-override';
import { startPicker, stopPicker } from './element-picker';
import { showOverlay, hideOverlay, updateCount } from './floating-overlay';
import { extractHeuristic, buildPageSnippet } from './product-extractor/heuristic';
import { isBoAutofillHost, bootBoAutofill } from './bo-autofill';
import type { ExtensionMessage } from '../shared/types';

interface ContentRuntimeState {
  shutdown: () => void;
}

declare global {
  interface Window {
    __XGEN_PATHFINDER_CONTENT__?: ContentRuntimeState;
  }
}

function bootstrapContentScript(): void {
  if (window.__XGEN_PATHFINDER_CONTENT__) return;

  const cleanups: Array<() => void> = [];
  extractAndSendToken();
  cleanups.push(watchTokenChanges());

  const pageAgent = new PageAgent();
  pageAgent.start();
  cleanups.push(() => pageAgent.stop());
  cleanups.push(injectCursorOverride());

  let shutdown = () => {};
  const listener = (
    message: ExtensionMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    switch (message.type) {
      case 'ELEMENT_PICKER_START':
        startPicker();
        break;
      case 'ELEMENT_PICKER_STOP':
        stopPicker();
        break;
      case 'SHOW_FLOATING_OVERLAY':
        showOverlay();
        break;
      case 'HIDE_FLOATING_OVERLAY':
        hideOverlay();
        break;
      case 'CAPTURE_SESSION_STATUS':
        if (message.active === false) {
          hideOverlay();
        } else if (typeof message.count === 'number') {
          updateCount(message.count);
        }
        break;
      case 'PRODUCT_CAPTURE_REQUEST':
        try {
          const draft = extractHeuristic();
          const pageSnippet = buildPageSnippet();
          sendResponse({
            type: 'PRODUCT_CAPTURE_RESPONSE',
            ok: true,
            draft,
            pageSnippet,
          } satisfies ExtensionMessage);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          sendResponse({
            type: 'PRODUCT_CAPTURE_RESPONSE',
            ok: false,
            error,
          } satisfies ExtensionMessage);
        }
        return true;
      case 'CONTENT_SCRIPT_SHUTDOWN':
        shutdown();
        break;
    }
  };
  chrome.runtime.onMessage.addListener(listener);

  if (isBoAutofillHost()) {
    cleanups.push(bootBoAutofill());
  }

  shutdown = () => {
    window.dispatchEvent(new CustomEvent('xgen:api-hook-control', {
      detail: { active: false },
    }));
    stopPicker();
    hideOverlay();
    chrome.runtime.onMessage.removeListener(listener);
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // Permission revoke cleanup is best-effort and must not retain state.
      }
    }
    delete window.__XGEN_PATHFINDER_CONTENT__;
  };
  window.__XGEN_PATHFINDER_CONTENT__ = { shutdown };
  console.log('[XGEN Extension] Content script loaded');
}

bootstrapContentScript();
