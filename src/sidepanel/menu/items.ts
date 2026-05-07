export type SidePanelView = 'chat' | 'inbox';

export interface MenuItem {
  id: string;
  title: string;
  emoji: string;
  view: SidePanelView;
}

export const MENU_ITEMS: MenuItem[] = [
  { id: 'product-inbox', title: '상품 수집함', emoji: '📦', view: 'inbox' },
];
