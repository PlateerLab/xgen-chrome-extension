export interface JoditProbeResult {
  found: boolean;
  method?: string;
  /** Jodit 인스턴스 객체 (S5에서 .value 주입용). */
  instance?: unknown;
}

/** Jodit 에디터 인스턴스 탐색.
 *  S4에서는 탐색만 하고 콘솔에 로그. 값 주입은 S5에서 별도 모듈로. */
export function probeJodit(): JoditProbeResult {
  const w = window as unknown as { Jodit?: { instances?: Record<string, unknown> } };

  if (w.Jodit?.instances && Object.keys(w.Jodit.instances).length > 0) {
    const keys = Object.keys(w.Jodit.instances);
    console.log('[bo-autofill] Jodit found via window.Jodit.instances:', keys);
    return {
      found: true,
      method: 'window.Jodit.instances',
      instance: w.Jodit.instances[keys[0]],
    };
  }

  const containers = document.querySelectorAll('.jodit-container, .jodit-react-container, .jodit');
  if (containers.length > 0) {
    console.log('[bo-autofill] Jodit DOM containers found:', containers.length, containers[0]);
    // editor instance가 노드에 _jodit 또는 jodit 프로퍼티로 연결되어 있을 수 있음
    const node = containers[0] as HTMLElement & { jodit?: unknown; _jodit?: unknown };
    return {
      found: true,
      method: '.jodit-container DOM',
      instance: node.jodit ?? node._jodit ?? null,
    };
  }

  // textarea + jodit으로 wrap된 sibling
  const ta = document.querySelector('textarea');
  if (ta && ta.nextElementSibling?.classList.contains('jodit')) {
    console.log('[bo-autofill] Jodit found via textarea sibling');
    return { found: true, method: 'textarea sibling' };
  }

  console.log('[bo-autofill] Jodit not found via probes');
  return { found: false };
}
