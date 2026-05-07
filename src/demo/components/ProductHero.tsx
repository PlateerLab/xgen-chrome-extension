import type { ProductDraft } from '../../shared/product/types';
import type { StreamPhase } from '../hooks/useDemoStreams';

interface Props {
  product: ProductDraft;
  headline?: string;
  subheadline?: string;
  phase: StreamPhase;
}

function formatPrice(price?: number, currency?: string): string | null {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  const symbol = currency === 'KRW' || !currency ? '₩' : `${currency} `;
  return `${symbol}${price.toLocaleString('ko-KR')}`;
}

export function ProductHero({ product, headline, subheadline, phase }: Props) {
  const priceText = formatPrice(product.price, product.currency);
  const isLoading = phase === 'streaming' || phase === 'loading-config';

  return (
    <section className="grid grid-cols-1 md:grid-cols-2 gap-8 px-6 lg:px-10 py-10 lg:py-12 border-b border-stone-200">
      <div className="aspect-square bg-stone-100 rounded overflow-hidden flex items-center justify-center">
        {product.thumbnailUrl ? (
          <img
            src={product.thumbnailUrl}
            alt={product.title}
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="text-stone-300 text-sm">이미지 없음</div>
        )}
      </div>

      <div className="flex flex-col gap-4 justify-center">
        {product.brand && (
          <div className="text-[10px] font-semibold text-stone-500 uppercase tracking-[0.2em]">
            {product.brand}
          </div>
        )}
        <h1 className="text-2xl lg:text-3xl font-semibold leading-tight text-stone-900">
          {product.title}
        </h1>

        {(headline || isLoading) && (
          <div className="border-l-2 border-stone-900 pl-4 py-1">
            {headline ? (
              <>
                <p className="text-base font-medium text-stone-900 leading-snug">{headline}</p>
                {subheadline && <p className="mt-1 text-sm text-stone-600 leading-relaxed">{subheadline}</p>}
              </>
            ) : (
              <div className="flex items-center gap-2 text-stone-500 text-sm">
                <Spinner />
                AI 카피 작성 중
              </div>
            )}
          </div>
        )}

        {priceText && (
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-3xl font-semibold text-stone-900 tabular-nums">{priceText}</span>
            <span className="text-[10px] tracking-wider uppercase text-stone-400">캡처가 기준</span>
          </div>
        )}

        {product.options && product.options.length > 0 && (
          <div className="mt-3 space-y-2.5 border-t border-stone-100 pt-4">
            {product.options.slice(0, 3).map((opt) => (
              <div key={opt.name} className="flex items-center gap-3 flex-wrap">
                <span className="text-[10px] tracking-[0.15em] uppercase text-stone-500 w-16">{opt.name}</span>
                <div className="flex flex-wrap gap-1.5">
                  {opt.values.slice(0, 6).map((v) => (
                    <span key={v} className="px-2.5 py-1 border border-stone-200 text-xs text-stone-700 bg-white">
                      {v}
                    </span>
                  ))}
                  {opt.values.length > 6 && (
                    <span className="px-2 py-1 text-xs text-stone-400">+{opt.values.length - 6}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Spinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" strokeLinecap="round" />
    </svg>
  );
}
