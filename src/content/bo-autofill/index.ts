import type { ExtensionMessage } from '../../shared/types';
import type { ProductDraft } from '../../shared/product/types';
import { SIMPLE_FIELDS, findInputByLabel, setFieldValue } from './field-map';
import { probeJodit } from './jodit-probe';
import { findJoditContainerForLabel, injectJoditHtml, plainTextToHtml } from './jodit-injector';

const BO_HOST = 'bo.x2bee.com';

export function isBoAutofillHost(): boolean {
  return window.location.hostname === BO_HOST;
}

interface UploadResult {
  filledLabels: string[];
  missingLabels: string[];
  joditFound: boolean;
  joditMethod?: string;
  joditInjected: boolean;
  joditInjectMethod?: string;
}

function performUpload(draft: ProductDraft): UploadResult {
  const filled: string[] = [];
  const missing: string[] = [];

  for (const spec of SIMPLE_FIELDS) {
    const value = spec.getValue(draft);
    if (!value) continue;
    const el = findInputByLabel(spec.label);
    if (!el) {
      console.log('[bo-autofill] field not found:', spec.label);
      missing.push(spec.label);
      continue;
    }
    if (setFieldValue(el, value)) {
      filled.push(spec.label);
      console.log('[bo-autofill] filled:', spec.label, '=', value.slice(0, 50));
    } else {
      missing.push(spec.label);
    }
  }

  const jodit = probeJodit();

  // 상품상세 — description을 plain HTML로 wrap해서 주입 (S5: 정적 주입. S6에서 LLM 스트리밍으로 대체)
  let joditInjected = false;
  let joditInjectMethod: string | undefined;
  if (draft.description && draft.description.trim()) {
    const target = findJoditContainerForLabel('상품상세 내용');
    if (target) {
      const html = plainTextToHtml(draft.description.trim());
      const result = injectJoditHtml(target, html);
      joditInjected = result.ok;
      joditInjectMethod = result.method;
      console.log('[bo-autofill] jodit injection:', result);
    } else {
      console.log('[bo-autofill] "상품상세 내용" 라벨에 연결된 Jodit 컨테이너 못 찾음');
    }
  } else {
    console.log('[bo-autofill] description 비어있음 — Jodit 주입 skip');
  }

  return {
    filledLabels: filled,
    missingLabels: missing,
    joditFound: jodit.found,
    joditMethod: jodit.method,
    joditInjected,
    joditInjectMethod,
  };
}

export function bootBoAutofill(): void {
  console.log('[bo-autofill] booted on', window.location.href);

  chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
    if (message.type !== 'PRODUCT_UPLOAD_REQUEST') return;
    try {
      const result = performUpload(message.draft);
      const response: ExtensionMessage = {
        type: 'PRODUCT_UPLOAD_RESPONSE',
        ok: true,
        filledCount: result.filledLabels.length,
        filledLabels: result.filledLabels,
        missingLabels: result.missingLabels,
        joditFound: result.joditFound,
        joditMethod: result.joditMethod,
        joditInjected: result.joditInjected,
        joditInjectMethod: result.joditInjectMethod,
      };
      sendResponse(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[bo-autofill] upload failed:', msg);
      sendResponse({ type: 'PRODUCT_UPLOAD_RESPONSE', ok: false, error: msg } satisfies ExtensionMessage);
    }
    return true;
  });
}
