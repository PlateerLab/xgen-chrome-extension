/**
 * GenericHandler — @page-agent/page-controller 기반 범용 핸들러
 *
 * alibaba/page-agent의 PageController를 그대로 활용:
 * - getBrowserState(): DOM을 "[0]<button>..." 형태로 평탄화 (LLM 토큰 효율적)
 * - clickElement(index): 합성 이벤트 시퀀스로 실제 클릭
 * - inputText(index, text): React/native input 호환 입력
 * - selectOption(index, text): 드롭다운 선택
 * - scroll(options): 스크롤
 * - showMask() / SimulatorMask: 가상 커서 오버레이 (smooth 이동 + click ripple)
 *
 * XGEN 특화 로직 없음 — 연결 고리는 page_tools.py + page_command SSE가 담당
 */

import { PageController } from '@page-agent/page-controller';
import type { PageHandler, PageContext, PageCommandResult, PageType } from '../types';
import { detectPageType } from '../page-detector';

export class GenericHandler implements PageHandler {
  readonly pageType: PageType = 'unknown';

  private controller: PageController;
  private stopObserveFn: (() => void) | null = null;

  constructor() {
    try {
      this.controller = new PageController({
        enableMask: true,         // SimulatorMask 활성화 (smooth cursor + click ripple)
        viewportExpansion: 3,     // 뷰포트 ±3배 범위 요소 추출 (스크롤 밖 요소도 포함)
        highlightOpacity: 0.3,
      });
      console.log('[XGEN GenericHandler] PageController 초기화 성공');
    } catch (err) {
      console.error('[XGEN GenericHandler] PageController 초기화 실패:', err);
      // fallback: mask 없이 재시도
      this.controller = new PageController({ viewportExpansion: 3 });
    }
  }

  matches(): boolean {
    return true; // fallback — 항상 매칭
  }

  async extractContext(): Promise<PageContext> {
    const state = await this.controller.getBrowserState();
    // 컨텍스트 추출 후 하이라이트 제거 — 평상시에는 깨끗한 화면 유지
    await this.controller.cleanUpHighlights();
    return {
      pageType: detectPageType(new URL(window.location.href)),
      url: state.url,
      title: state.title,
      elements: state.content,
      data: {},
      availableActions: this.getAvailableActions(),
      timestamp: Date.now(),
    };
  }

  getAvailableActions(): string[] {
    return ['click_element', 'input_text', 'select_option', 'scroll'];
  }

  async executeCommand(
    action: string,
    params: Record<string, unknown>,
  ): Promise<PageCommandResult> {
    try {
      // updateTree()를 호출하지 않음 — extractContext()에서 빌드한 트리의 인덱스를
      // 그대로 사용해야 AI가 지정한 인덱스와 일치한다.
      // updateTree()는 DOM을 재스캔하여 인덱스를 재할당하므로 불일치 발생.

      switch (action) {
        case 'click_element':
          await this.controller.clickElement(params.index as number);
          break;

        case 'input_text':
          await this.controller.inputText(params.index as number, params.text as string);
          break;

        case 'select_option':
          await this.controller.selectOption(params.index as number, params.text as string);
          break;

        case 'scroll':
          await this.controller.scroll({
            down: (params.down as boolean) ?? true,
            numPages: (params.num_pages as number) ?? 1,
          });
          break;

        default:
          return { success: false, action, error: `Unknown action: ${action}` };
      }

      // DOM이 안정될 때까지 대기 (MutationObserver 기반)
      await this.waitForDomStability();
      const state = await this.controller.getBrowserState();
      await this.controller.cleanUpHighlights();
      const updatedContext: PageContext = {
        pageType: detectPageType(new URL(window.location.href)),
        url: state.url,
        title: state.title,
        elements: state.content,
        data: {},
        availableActions: this.getAvailableActions(),
        timestamp: Date.now(),
      };

      return { success: true, action, pageContext: updatedContext };
    } catch (err) {
      return {
        success: false,
        action,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  observe(callback: (context: PageContext) => void): void {
    let lastUrl = window.location.href;
    let debounceTimer: ReturnType<typeof setTimeout>;

    // URL 변경 감지 (SPA 네비게이션) — 500ms 폴링
    const urlInterval = setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        this.extractContext()
          .then((ctx) => callback(ctx))
          .catch(() => {});
      }
    }, 500);

    // DOM 변경 감지 (page_command 실행 후 UI 갱신 반영) — 1초 debounce
    const mutationObserver = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.extractContext()
          .then((ctx) => callback(ctx))
          .catch(() => {});
      }, 1000);
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    this.stopObserveFn = () => {
      clearInterval(urlInterval);
      mutationObserver.disconnect();
      clearTimeout(debounceTimer);
    };
  }

  /**
   * DOM이 안정될 때까지 대기 — MutationObserver 기반.
   * quietMs 동안 DOM 변경이 없으면 안정 상태로 판단.
   * timeoutMs 초과 시 강제 resolve (애니메이션/폴링 페이지 대응).
   */
  private waitForDomStability(timeoutMs = 5000, quietMs = 300): Promise<void> {
    return new Promise((resolve) => {
      let quietTimer: ReturnType<typeof setTimeout>;

      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, quietMs);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      // 초기 quiet timer 시작 — 변경이 전혀 없으면 quietMs 후 resolve
      quietTimer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, quietMs);

      // hard timeout — 무한 대기 방지
      setTimeout(() => {
        clearTimeout(quietTimer);
        observer.disconnect();
        resolve();
      }, timeoutMs);
    });
  }

  disconnect(): void {
    this.stopObserveFn?.();
    this.stopObserveFn = null;
    // controller는 dispose하지 않음 — page-agent가 동일 인스턴스를 재활성화할 수 있음
    // content script 언로드 시 자동 GC
  }
}
