function ownText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent || '';
  }
  return text.replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
}

export function findJoditContainerForLabel(labelText: string): HTMLElement | null {
  const cands = document.querySelectorAll<HTMLElement>(
    'h1,h2,h3,h4,h5,h6,span,div,dt,p,th,td,legend,label',
  );
  let label: HTMLElement | null = null;
  for (const el of cands) {
    if (ownText(el) === labelText) { label = el; break; }
  }
  if (!label) return null;

  let cursor: Element | null = label.parentElement;
  for (let depth = 0; depth < 8 && cursor; depth++) {
    const ed = cursor.querySelector<HTMLElement>(
      '.jodit-react-container, .jodit-container',
    );
    if (ed) return ed;
    cursor = cursor.parentElement;
  }
  return null;
}

export type JoditInjectMethod = 'instance' | 'wysiwyg' | 'none';

export interface JoditInjectResult {
  ok: boolean;
  method: JoditInjectMethod;
  error?: string;
}

interface JoditInstance {
  value?: string;
  setEditorValue?: (v: string) => void;
  synchronizeValues?: () => void;
}

/** 가능한 위치에서 Jodit instance 객체 찾기. 진단 결과 BO에선 보통 안 잡힘 → null. */
function findJoditInstance(container: HTMLElement): JoditInstance | null {
  const inner = container.classList.contains('jodit-container')
    ? container
    : container.querySelector<HTMLElement>('.jodit-container') || container;

  const rec = inner as unknown as Record<string, unknown>;
  for (const key of ['jodit', '_jodit', '__jodit__', 'j']) {
    const v = rec[key];
    if (v && typeof v === 'object') return v as JoditInstance;
  }

  const w = window as unknown as { Jodit?: { instances?: Record<string, unknown> } };
  if (w.Jodit?.instances) {
    for (const inst of Object.values(w.Jodit.instances)) {
      if (inst && typeof inst === 'object') return inst as JoditInstance;
    }
  }
  return null;
}

export function injectJoditHtml(container: HTMLElement, html: string): JoditInjectResult {
  const inst = findJoditInstance(container);
  if (inst) {
    try {
      if (typeof inst.setEditorValue === 'function') {
        inst.setEditorValue(html);
      } else if ('value' in inst) {
        inst.value = html;
      }
      if (typeof inst.synchronizeValues === 'function') inst.synchronizeValues();
      return { ok: true, method: 'instance' };
    } catch (err) {
      console.warn('[bo-autofill] jodit instance injection failed:', err);
    }
  }

  const wysiwyg = container.querySelector<HTMLElement>('.jodit-wysiwyg');
  if (wysiwyg) {
    try {
      wysiwyg.innerHTML = html;
      // Jodit는 wysiwyg input 이벤트를 listen해서 textarea/state 동기화
      wysiwyg.dispatchEvent(new Event('input', { bubbles: true }));
      wysiwyg.dispatchEvent(new Event('blur', { bubbles: true }));
      return { ok: true, method: 'wysiwyg' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[bo-autofill] wysiwyg injection failed:', msg);
      return { ok: false, method: 'none', error: msg };
    }
  }

  return { ok: false, method: 'none', error: '주입 대상(.jodit-wysiwyg) 없음' };
}

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function plainTextToHtml(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
  const paragraphs = escaped
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\n/g, '<br />'))
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p}</p>`);
  return paragraphs.join('') || '<p></p>';
}
