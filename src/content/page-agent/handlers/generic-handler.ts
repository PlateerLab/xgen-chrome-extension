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
    await this.controller.cleanUpHighlights();

    // 메뉴 사전탐색 — 접힌 메뉴를 펼쳐서 전체 네비게이션 구조를 파악
    const menuMap = await this.scanMenuHierarchy();

    return {
      pageType: detectPageType(new URL(window.location.href)),
      url: state.url,
      title: state.title,
      elements: state.content,
      data: { ...(menuMap ? { menuMap } : {}) },
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
   * 메뉴 사전탐색 — 사이드바/네비게이션의 접힌 메뉴를 펼쳐서 전체 구조를 파악한다.
   *
   * 흐름:
   * 1. nav, sidebar, [role="navigation"] 등 네비게이션 컨테이너를 찾음
   * 2. 접힌 메뉴 항목(aria-expanded="false" 또는 숨겨진 서브메뉴)을 클릭해서 펼침
   * 3. 서브메뉴 텍스트를 수집
   * 4. 원래 상태(접힌 상태)로 복원
   * 5. "부모 메뉴 > [서브1, 서브2, ...]" 형태의 맵을 반환
   *
   * AI가 "도구 관리"가 "사용자 관리" 아래에 있다는 것을 사전에 파악할 수 있게 한다.
   */
  private async scanMenuHierarchy(): Promise<string | null> {
    try {
      // 네비게이션 컨테이너에서 접힌 메뉴 항목 찾기
      const collapsedItems = document.querySelectorAll<HTMLElement>(
        [
          'nav [aria-expanded="false"]',
          'aside [aria-expanded="false"]',
          '[role="navigation"] [aria-expanded="false"]',
          '.sidebar [aria-expanded="false"]',
          '[class*="sidebar"] [aria-expanded="false"]',
          '[class*="nav"] [aria-expanded="false"]',
        ].join(','),
      );

      if (collapsedItems.length === 0) {
        // aria-expanded 미사용 시: 서브메뉴가 숨겨진 메뉴 구조를 DOM으로 탐색
        return this.scanMenuFromDom();
      }

      const menuEntries: string[] = [];

      for (const item of collapsedItems) {
        const parentLabel = this.getMenuItemText(item);
        if (!parentLabel) continue;

        // 클릭해서 서브메뉴 펼치기
        item.click();
        await new Promise((r) => setTimeout(r, 200));

        // 펼쳐진 서브메뉴의 자식 항목 수집
        const childTexts = this.collectSubmenuTexts(item);

        if (childTexts.length > 0) {
          menuEntries.push(`${parentLabel} > [${childTexts.join(', ')}]`);
        }

        // 원래 상태로 복원 (다시 접기)
        if (item.getAttribute('aria-expanded') === 'true') {
          item.click();
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      return menuEntries.length > 0
        ? '[메뉴 구조]\n' + menuEntries.join('\n')
        : null;
    } catch (err) {
      console.warn('[XGEN GenericHandler] scanMenuHierarchy 실패:', err);
      return null;
    }
  }

  /**
   * aria-expanded가 없는 경우: DOM 구조에서 메뉴 계층을 직접 추출한다.
   * 숨겨진(display:none 등) 서브메뉴도 텍스트를 읽을 수 있다.
   */
  private scanMenuFromDom(): string | null {
    const navContainers = document.querySelectorAll<HTMLElement>(
      'nav, aside, [role="navigation"], .sidebar, [class*="sidebar"]',
    );

    if (navContainers.length === 0) return null;

    const menuEntries: string[] = [];

    for (const nav of navContainers) {
      // 자식이 있는 메뉴 항목 찾기 (ul > li > ul 패턴)
      const topItems = nav.querySelectorAll<HTMLElement>(
        ':scope > ul > li, :scope > div > ul > li, :scope > div > div > ul > li',
      );

      for (const li of topItems) {
        const subList = li.querySelector('ul, [role="menu"], [role="group"]');
        if (!subList) continue;

        const parentLink = li.querySelector('a, button, [role="menuitem"]');
        const parentLabel = parentLink?.textContent?.trim();
        if (!parentLabel) continue;

        const childItems = subList.querySelectorAll<HTMLElement>(
          ':scope > li > a, :scope > li > button, :scope > [role="menuitem"]',
        );
        const childTexts = Array.from(childItems)
          .map((el) => el.textContent?.trim())
          .filter((t): t is string => !!t && t.length > 0);

        if (childTexts.length > 0) {
          menuEntries.push(`${parentLabel} > [${childTexts.join(', ')}]`);
        }
      }
    }

    return menuEntries.length > 0
      ? '[메뉴 구조]\n' + menuEntries.join('\n')
      : null;
  }

  /** 메뉴 항목에서 접힌 후 펼쳐진 서브메뉴 텍스트를 수집한다. */
  private collectSubmenuTexts(parentItem: HTMLElement): string[] {
    // 방법 1: aria-controls로 연결된 서브메뉴 찾기
    const controlsId = parentItem.getAttribute('aria-controls');
    if (controlsId) {
      const submenu = document.getElementById(controlsId);
      if (submenu) {
        return this.extractLinkTexts(submenu);
      }
    }

    // 방법 2: 인접 형제/자식에서 서브메뉴 찾기
    const sibling = parentItem.nextElementSibling;
    if (sibling && (sibling.matches('ul, [role="menu"], [role="group"]') ||
        sibling.querySelector('ul, [role="menu"]'))) {
      return this.extractLinkTexts(sibling as HTMLElement);
    }

    // 방법 3: 부모의 자식 중 서브메뉴 컨테이너 찾기
    const parent = parentItem.closest('li, div');
    if (parent) {
      const submenu = parent.querySelector('ul, [role="menu"], [role="group"]');
      if (submenu && submenu !== parentItem) {
        return this.extractLinkTexts(submenu as HTMLElement);
      }
    }

    return [];
  }

  /** 컨테이너 내 링크/버튼 텍스트를 추출한다. */
  private extractLinkTexts(container: HTMLElement): string[] {
    const items = container.querySelectorAll<HTMLElement>(
      'a, button, [role="menuitem"], [role="treeitem"]',
    );
    return Array.from(items)
      .map((el) => el.textContent?.trim())
      .filter((t): t is string => !!t && t.length > 0 && t.length < 100);
  }

  /** 메뉴 항목의 텍스트를 추출한다 (아이콘 등 제외). */
  private getMenuItemText(el: HTMLElement): string {
    // aria-label 우선
    const label = el.getAttribute('aria-label');
    if (label) return label;

    // 텍스트 노드만 추출 (아이콘 SVG 등 제외)
    const text = el.textContent?.trim() ?? '';
    return text.length > 0 && text.length < 100 ? text : '';
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
