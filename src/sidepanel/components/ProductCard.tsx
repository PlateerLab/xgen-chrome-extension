import type { ProductDraft } from '../../shared/product/types';

interface ProductCardProps {
  product: ProductDraft;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

function formatPrice(price?: number, currency?: string): string | null {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  const symbol = currency === 'KRW' || !currency ? '₩' : `${currency} `;
  return `${symbol}${price.toLocaleString('ko-KR')}`;
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return '방금 전';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  return `${day}일 전`;
}

export function ProductCard({ product, selected, onToggleSelect, onRemove }: ProductCardProps) {
  const priceText = formatPrice(product.price, product.currency);
  const isEnriching = product.status === 'enriching';
  const isFailed = product.status === 'failed';

  return (
    <article
      onClick={() => !isEnriching && onToggleSelect(product.id)}
      className={`flex gap-2 p-2 rounded-md transition-all cursor-pointer border ${
        selected
          ? 'border-violet-500 bg-violet-50/50 ring-1 ring-violet-300'
          : 'border-gray-200 bg-white hover:border-gray-300'
      } ${isEnriching ? 'opacity-70 cursor-wait' : ''}`}
    >
      {/* 선택 체크박스 */}
      <div className="flex-shrink-0 pt-0.5">
        <span
          className={`inline-flex w-4 h-4 rounded border items-center justify-center ${
            selected ? 'bg-violet-600 border-violet-600' : 'bg-white border-gray-300'
          }`}
          aria-hidden="true"
        >
          {selected && (
            <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
      </div>

      <div className="flex-shrink-0 w-12 h-12 rounded bg-gray-100 overflow-hidden">
        {product.thumbnailUrl ? (
          <img
            src={product.thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 text-[10px]">no img</div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-1">
          <h3 className="text-xs font-medium text-gray-800 line-clamp-2 leading-tight">
            {product.title || '(제목 없음)'}
          </h3>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove(product.id);
            }}
            className="flex-shrink-0 text-gray-300 hover:text-red-500 leading-none p-0.5"
            title="삭제"
            aria-label="상품 삭제"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
          {priceText && <span className="font-semibold text-gray-900">{priceText}</span>}
          <span className="text-gray-400">{formatRelativeTime(product.capturedAt)}</span>
          {isEnriching && (
            <span className="inline-flex items-center gap-1 text-violet-600">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
              AI 보강 중
            </span>
          )}
          {isFailed && <span className="text-amber-600">AI 보강 실패</span>}
        </div>
        {product.sourceHost && (
          <div className="mt-0.5 text-[10px] text-gray-400 truncate">{product.sourceHost}</div>
        )}
      </div>
    </article>
  );
}
