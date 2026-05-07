import type { ProductDraft } from '../../shared/product/types';

interface ProductCardProps {
  product: ProductDraft;
  onRemove: (id: string) => void;
  onUpload?: (id: string) => void;
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

export function ProductCard({ product, onRemove, onUpload }: ProductCardProps) {
  const priceText = formatPrice(product.price, product.currency);
  const isEnriching = product.status === 'enriching';
  const isFailed = product.status === 'failed';
  const canUpload = !!onUpload && !isEnriching;

  return (
    <article className="flex gap-2 p-2 border border-gray-200 rounded-md bg-white hover:border-violet-300 transition-colors">
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
          <div className="w-full h-full flex items-center justify-center text-gray-300 text-[10px]">
            no img
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-1">
          <h3 className="text-xs font-medium text-gray-800 line-clamp-2 leading-tight">
            {product.title || '(제목 없음)'}
          </h3>
          <button
            onClick={() => onRemove(product.id)}
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
        {canUpload && (
          <div className="mt-1.5">
            <button
              onClick={() => onUpload?.(product.id)}
              className="w-full text-[11px] font-medium text-violet-700 bg-violet-50 hover:bg-violet-100 transition-colors py-1 rounded inline-flex items-center justify-center gap-1"
              title="이 상품을 BO 상품등록 페이지에 자동 채움"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              상품 업로드
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
