import type { PageContext, PageCommandResult, PageType } from '../../shared/types';

export type { PageContext, PageCommandResult, PageType };

export interface PageHandler {
  readonly pageType: PageType;
  matches(url: URL): boolean;
  // sync 또는 async 모두 허용 — page-agent.ts에서 Promise.resolve()로 통일 처리
  extractContext(): PageContext | Promise<PageContext>;
  getAvailableActions(): string[];
  executeCommand(
    action: string,
    params: Record<string, unknown>,
  ): Promise<PageCommandResult>;
  observe(callback: (context: PageContext) => void): void;
  disconnect(): void;
}
