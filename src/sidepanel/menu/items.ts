export type SidePanelView = 'chat' | 'inbox' | 'mcp-sources';

export interface MenuItem {
  id: string;
  title: string;
  emoji: string;
  view: SidePanelView;
}

export const MENU_ITEMS: MenuItem[] = [
  { id: 'product-inbox', title: '상품 수집함', emoji: '📦', view: 'inbox' },
  { id: 'mcp-sources', title: 'MCP 도구 연결', emoji: '⌘', view: 'mcp-sources' },
];
