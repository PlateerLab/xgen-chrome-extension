import { useEffect } from 'react';
import { MENU_ITEMS, type MenuItem } from '../menu/items';

interface MenuDrawerProps {
  open: boolean;
  onSelect: (item: MenuItem) => void;
  onClose: () => void;
}

export function MenuDrawer({ open, onSelect, onClose }: MenuDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/30 transition-opacity duration-200 z-40 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`fixed top-0 left-0 h-full w-56 bg-white shadow-xl transition-transform duration-200 ease-out z-50 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        role="dialog"
        aria-label="사이드 메뉴"
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
          <span className="text-sm font-medium text-gray-700">메뉴</span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 leading-none px-1"
            title="닫기"
            aria-label="메뉴 닫기"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <nav className="py-1">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                onSelect(item);
                onClose();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-violet-50 transition-colors text-left"
            >
              <span aria-hidden="true">{item.emoji}</span>
              <span>{item.title}</span>
            </button>
          ))}
        </nav>
      </aside>
    </>
  );
}
