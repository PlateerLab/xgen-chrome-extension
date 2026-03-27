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
        viewportExpansion: 0,     // 뷰포트 내 요소만 추출 (토큰 절약)
        highlightOpacity: 0.3,
      });
      console.log('[XGEN GenericHandler] PageController 초기화 성공');
    } catch (err) {
      console.error('[XGEN GenericHandler] PageController 초기화 실패:', err);
      // fallback: mask 없이 재시도
      this.controller = new PageController({ viewportExpansion: 0 });
    }
  }

  matches(): boolean {
    return true; // fallback — 항상 매칭
  }

  async extractContext(): Promise<PageContext> {
    const state = await this.controller.getBrowserState();
    console.log('[XGEN GenericHandler] extractContext — elements length:', state.content?.length ?? 0, 'url:', state.url);
    if (!state.content) {
      console.warn('[XGEN GenericHandler] getBrowserState().content가 비어있음!');
    }
    return {
      pageType: detectPageType(new URL(window.location.href)),
      url: state.url,
      title: state.title,
      elements: state.content,  // LLM이 읽는 DOM 평탄화 텍스트
      data: {},
      availableActions: this.getAvailableActions(),
      timestamp: Date.now(),
    };
  }

  getAvailableActions(): string[] {
    return ['click_element', 'input_text', 'select_option', 'scroll', 'navigate'];
  }

  async executeCommand(
    action: string,
    params: Record<string, unknown>,
  ): Promise<PageCommandResult> {
    try {
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

        case 'navigate':
          if (typeof params.path === 'string') {
            window.location.href = params.path;
          }
          break;

        default:
          return { success: false, action, error: `Unknown action: ${action}` };
      }

      // 액션 실행 후 DOM 재스캔 — 다음 턴에 fresh context 제공
      const state = await this.controller.getBrowserState();
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

  disconnect(): void {
    this.stopObserveFn?.();
    this.stopObserveFn = null;
    // controller는 dispose하지 않음 — page-agent가 동일 인스턴스를 재활성화할 수 있음
    // content script 언로드 시 자동 GC
  }
}
