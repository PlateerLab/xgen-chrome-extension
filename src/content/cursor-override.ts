/**
 * SimulatorMask 커서 스타일 오버라이드
 * 기존 75px 그라데이션 커서 → 32px 미니멀 블루 커서
 */
export function injectCursorOverride(): void {
  const style = document.createElement('style');
  style.textContent = `
    /* 커서 크기 축소: 75px → 32px */
    ._cursor_1dgwb_2 {
      --cursor-size: 32px !important;
      width: 32px !important;
      height: 32px !important;
    }

    /* 보더 — 슬림한 블루-퍼플 그라데이션 */
    ._cursorBorder_1dgwb_10 {
      background: linear-gradient(135deg, #3b82f6, #8b5cf6) !important;
      transform: rotate(-135deg) scale(1) !important;
      margin-left: -4px !important;
      margin-top: -8px !important;
    }

    /* 필링 — 깔끔한 흰색 + 가벼운 그림자 */
    ._cursorFilling_1dgwb_25 {
      transform: rotate(-135deg) scale(1) !important;
      margin-left: -4px !important;
      margin-top: -8px !important;
      filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.15)) !important;
    }

    /* ripple — 얇은 블루 테두리 */
    ._cursorRipple_1dgwb_39::after {
      border: 2px solid rgba(59, 130, 246, 0.8) !important;
    }

    /* 오버레이 래퍼 — 배경 제거, 커서만 표시 */
    ._wrapper_1ooyb_1 {
      background: none !important;
      cursor: default !important;
      pointer-events: none !important;
    }

    ._wrapper_1ooyb_1._visible_1ooyb_11 {
      background: none !important;
    }
  `;
  document.head.appendChild(style);
}
