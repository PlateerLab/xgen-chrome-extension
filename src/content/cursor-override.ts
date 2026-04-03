/**
 * SimulatorMask 커서 스타일 오버라이드
 * 기존 SVG 그라데이션 커서 + 테두리를 완전 제거하고
 * 깔끔한 마우스 포인터로 대체
 */
export function injectCursorOverride(): void {
  const style = document.createElement('style');
  style.textContent = `
    /* 커서 컨테이너 */
    ._cursor_1dgwb_2 {
      --cursor-size: 20px !important;
      width: 20px !important;
      height: 20px !important;
    }

    /* 기존 보더/필링/ripple 내부 요소 전부 숨김 */
    ._cursorBorder_1dgwb_10,
    ._cursorFilling_1dgwb_25,
    ._cursorRipple_1dgwb_39 {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      visibility: hidden !important;
    }

    /* 마우스 포인터 — ::before로 삽입 */
    ._cursor_1dgwb_2::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 17px;
      height: 22px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='17' height='22' fill='none'%3E%3Cpath d='M1 1v18.094l4.713-4.715 3.974 7.058 2.755-1.55-3.974-7.06H15.4L1 1z' fill='%23fff'/%3E%3Cpath d='M1 1v18.094l4.713-4.715 3.974 7.058 2.755-1.55-3.974-7.06H15.4L1 1z' stroke='%23666' stroke-width='1' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-size: 17px 22px;
      background-repeat: no-repeat;
      pointer-events: none;
      z-index: 10001;
    }

    /* 클릭 시 살짝 줄어드는 효과 */
    ._cursor_1dgwb_2._clicking_1dgwb_57::before {
      transform: scale(0.85);
      transition: transform 0.1s ease;
    }

    /* 오버레이 래퍼 — 배경 없음, 상호작용 차단 안 함 */
    ._wrapper_1ooyb_1,
    ._wrapper_1ooyb_1._visible_1ooyb_11 {
      background: none !important;
      cursor: default !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}
