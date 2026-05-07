import type { ProductDraft } from '../../shared/product/types';

export interface SimpleFieldSpec {
  label: string;
  getValue: (draft: ProductDraft) => string | undefined;
}

/** v1 단순 필드 매핑 — BO 상품등록 폼의 라벨 텍스트 기준. */
export const SIMPLE_FIELDS: SimpleFieldSpec[] = [
  { label: '상품명', getValue: (d) => d.title },
  { label: '모델명', getValue: (d) => d.modelName },
  { label: '제조사', getValue: (d) => d.manufacturer },
  { label: '원산지', getValue: (d) => d.origin },
];

/** 자식 요소 제외하고 자기 자신의 텍스트만(*나 ⓘ 등 마커 무시). */
function ownText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent || '';
  }
  return text.replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
}

/** 라벨 텍스트로 form 컨트롤 찾기.
 *  BO는 MUI Grid2 레이아웃 (<h6>·<span>·<dt> 등 다양한 태그가 라벨)이라 own text로 매칭. */
export function findInputByLabel(
  labelText: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
  // 1) 표준 <label> 먼저
  const stdLabels = Array.from(document.querySelectorAll<HTMLLabelElement>('label'));
  let label: Element | null = stdLabels.find((l) => ownText(l) === labelText) ?? null;

  // 2) own text 매칭 (h1~h6, span, div, dt, p, th 등 라벨 후보 태그 한정)
  if (!label) {
    const candidates = document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,span,div,dt,p,th,td,legend');
    for (const el of candidates) {
      if (ownText(el) === labelText) {
        label = el;
        break;
      }
    }
  }
  if (!label) return null;

  // <label for=...> 케이스
  if (label instanceof HTMLLabelElement && label.htmlFor) {
    const target = document.getElementById(label.htmlFor);
    if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return target;
    }
  }

  // 자손
  const inside = label.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select',
  );
  if (inside) return inside;

  // 부모 → 조부모 → ... 올라가며 첫 input/textarea/select. MUI Grid2 row가 보통 depth 1~2.
  let cursor: Element | null = label.parentElement;
  for (let depth = 0; depth < 6 && cursor; depth++) {
    const target = cursor.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select',
    );
    if (target) return target;
    cursor = cursor.parentElement;
  }

  return null;
}

/** React/Vue 등 controlled input에 값 주입. native setter 우회 + input/change 이벤트 dispatch. */
export function setFieldValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): boolean {
  try {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      (el as HTMLInputElement | HTMLTextAreaElement).value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch (err) {
    console.warn('[bo-autofill] setFieldValue failed:', err);
    return false;
  }
}
