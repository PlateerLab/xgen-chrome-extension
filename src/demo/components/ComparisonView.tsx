import type { ProductDraft } from '../../shared/product/types';
import type {
  ComparisonAxis,
  ComparisonContent,
  ComparisonPerProduct,
} from '../../shared/product/demo-prompts';
import type { SideState, StreamPhase } from '../hooks/useDemoStreams';

interface Props {
  products: ProductDraft[];
  state: SideState<ComparisonContent>;
}

const PRODUCT_LETTERS = ['A', 'B', 'C', 'D'];

export function ComparisonView({ products, state }: Props) {
  const r = state.result;

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <Header productCount={products.length} />

      <main className="max-w-7xl mx-auto px-6 lg:px-10 py-8 lg:py-12 space-y-10">
        <Verdict state={state} products={products} />

        <ProductCardsGrid products={products} per={r?.perProductSummary} />

        <AxesTable products={products} axes={r?.axes} phase={state.phase} />

        {r?.actionPoints && r.actionPoints.length > 0 && <ActionPoints items={r.actionPoints} />}

        {state.error && (
          <div className="rounded border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
            분석 실패: {state.error}
          </div>
        )}
      </main>

      <footer className="max-w-7xl mx-auto px-6 lg:px-10 pb-12 pt-4 text-[11px] text-stone-400 tracking-wider uppercase border-t border-stone-200 mt-6">
        XGEN · AI 채널 비교 분석 · 모든 추정값은 LLM 추론 기반
      </footer>
    </div>
  );
}

function Header({ productCount }: { productCount: number }) {
  return (
    <header className="bg-white border-b border-stone-200 sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-white/85">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-4 flex items-center gap-4">
        <button
          onClick={() => window.close()}
          className="text-stone-400 hover:text-stone-700 text-xs flex items-center gap-1 tracking-wide"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          닫기
        </button>
        <div className="h-4 w-px bg-stone-200" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] tracking-[0.2em] text-stone-500 uppercase font-medium">
            Channel Comparison · {productCount} products
          </div>
          <div className="text-base font-semibold text-stone-900 mt-0.5">AI 채널별 비교 분석</div>
        </div>
        <div className="hidden sm:block text-[10px] tracking-[0.2em] text-stone-400 uppercase">XGEN</div>
      </div>
    </header>
  );
}

function Verdict({ state, products }: { state: SideState<ComparisonContent>; products: ProductDraft[] }) {
  const { result, phase, error } = state;
  if (error) return null;
  return (
    <section className="border-l-2 border-stone-900 pl-6 py-2">
      <div className="text-[10px] tracking-[0.2em] text-stone-500 uppercase font-medium mb-2">
        Executive Verdict
      </div>
      {result?.verdict ? (
        <h1 className="text-2xl lg:text-3xl font-semibold leading-snug text-stone-900">
          {result.verdict}
        </h1>
      ) : phase === 'streaming' || phase === 'loading-config' ? (
        <div className="space-y-2">
          <div className="skeleton h-7 w-3/4" />
          <div className="skeleton h-7 w-2/3" />
        </div>
      ) : null}

      {result?.summary && (
        <p className="mt-4 text-sm leading-relaxed text-stone-700 max-w-3xl">{result.summary}</p>
      )}

      {typeof result?.winner === 'number' && result.winner >= 0 && (
        <div className="mt-4 inline-flex items-center gap-2 text-xs text-stone-700">
          <span className="text-stone-400 tracking-wider uppercase text-[10px]">Winner</span>
          <ProductChip index={result.winner} product={products[result.winner]} />
        </div>
      )}
      {result?.winner === -1 && (
        <div className="mt-4 inline-flex items-center gap-2 text-xs text-stone-500">
          <span className="text-stone-400 tracking-wider uppercase text-[10px]">Verdict</span>
          <span className="font-medium">무승부 — 채널별 차별 포인트 분명</span>
        </div>
      )}
    </section>
  );
}

function ProductChip({ index, product }: { index: number; product?: ProductDraft }) {
  if (!product) return null;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-stone-900 text-white rounded text-[11px] font-medium">
      <span className="bg-white text-stone-900 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold">
        {PRODUCT_LETTERS[index] || index + 1}
      </span>
      {product.sourceHost}
    </span>
  );
}

function ProductCardsGrid({
  products,
  per,
}: {
  products: ProductDraft[];
  per?: ComparisonPerProduct[];
}) {
  return (
    <section>
      <div className="text-[10px] tracking-[0.2em] text-stone-500 uppercase font-medium mb-4">
        비교 대상
      </div>
      <div className={`grid gap-4 ${products.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
        {products.map((p, i) => (
          <ProductCardEditorial key={p.id} index={i} product={p} per={per?.find((x) => x.productIndex === i)} />
        ))}
      </div>
    </section>
  );
}

function ProductCardEditorial({
  index,
  product,
  per,
}: {
  index: number;
  product: ProductDraft;
  per?: ComparisonPerProduct;
}) {
  const priceText = formatPrice(product.price, product.currency);
  return (
    <article className="bg-white border border-stone-200 rounded p-5 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="flex-shrink-0 w-7 h-7 rounded-full bg-stone-900 text-white text-xs font-bold flex items-center justify-center">
          {PRODUCT_LETTERS[index] || index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] tracking-[0.15em] text-stone-500 uppercase font-medium truncate">
            {product.sourceHost}
          </div>
          <h3 className="text-sm font-semibold leading-tight text-stone-900 mt-0.5 line-clamp-2">
            {product.title}
          </h3>
        </div>
      </div>

      {product.thumbnailUrl && (
        <div className="aspect-square bg-stone-100 rounded overflow-hidden">
          <img
            src={product.thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      )}

      <div className="flex items-baseline justify-between">
        {priceText && <span className="text-xl font-semibold text-stone-900 tabular-nums">{priceText}</span>}
        {product.brand && <span className="text-[11px] text-stone-500">{product.brand}</span>}
      </div>

      {per && (
        <div className="border-t border-stone-100 pt-3 mt-1 space-y-2.5">
          {per.label && (
            <div className="text-[11px] tracking-wide font-semibold text-stone-700 uppercase">
              {per.label}
            </div>
          )}
          {per.strengths && per.strengths.length > 0 && (
            <div>
              <div className="text-[10px] tracking-[0.15em] text-emerald-700 uppercase font-medium mb-1">
                강점
              </div>
              <ul className="space-y-0.5 text-[11px] text-stone-700 leading-relaxed">
                {per.strengths.map((s, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-emerald-600">+</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {per.weaknesses && per.weaknesses.length > 0 && (
            <div>
              <div className="text-[10px] tracking-[0.15em] text-rose-700 uppercase font-medium mb-1">
                약점
              </div>
              <ul className="space-y-0.5 text-[11px] text-stone-700 leading-relaxed">
                {per.weaknesses.map((w, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-rose-600">−</span>
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function AxesTable({
  products,
  axes,
  phase,
}: {
  products: ProductDraft[];
  axes?: ComparisonAxis[];
  phase: StreamPhase;
}) {
  const isLoading = phase === 'streaming' || phase === 'loading-config';
  return (
    <section>
      <div className="text-[10px] tracking-[0.2em] text-stone-500 uppercase font-medium mb-4">
        축별 비교
      </div>
      <div className="bg-white border border-stone-200 rounded overflow-hidden">
        <div className="grid grid-cols-[140px_1fr_auto] gap-4 px-5 py-3 border-b border-stone-200 bg-stone-50 text-[10px] tracking-[0.15em] uppercase font-semibold text-stone-500">
          <div>축</div>
          <div>평가</div>
          <div className="text-right">우세</div>
        </div>
        <div className="divide-y divide-stone-100">
          {axes && axes.length > 0 ? (
            axes.map((a, i) => (
              <AxisRow key={i} products={products} axis={a} />
            ))
          ) : isLoading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="grid grid-cols-[140px_1fr_auto] gap-4 px-5 py-4 items-center">
                <div className="skeleton h-4 w-20" />
                <div className="space-y-1.5">
                  <div className="skeleton h-3 w-full" />
                  <div className="skeleton h-3 w-3/4" />
                </div>
                <div className="skeleton h-6 w-12" />
              </div>
            ))
          ) : (
            <div className="px-5 py-6 text-sm text-stone-400">분석 결과가 없습니다.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function AxisRow({ products, axis }: { products: ProductDraft[]; axis: ComparisonAxis }) {
  return (
    <div className="grid grid-cols-[140px_1fr_auto] gap-4 px-5 py-4 items-start hover:bg-stone-50/50 transition-colors">
      <div className="text-sm font-semibold text-stone-900 pt-0.5">{axis.axis}</div>
      <div className="text-[13px] leading-relaxed text-stone-700">{axis.evaluation}</div>
      <div className="pt-0.5">
        <LeaderBadge index={axis.leader} product={products[axis.leader]} />
      </div>
    </div>
  );
}

function LeaderBadge({ index, product }: { index: number; product?: ProductDraft }) {
  if (index === -1 || !product) {
    return <span className="text-[10px] tracking-wider uppercase text-stone-400">tie</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-stone-900 text-white text-[10px] font-bold">
      <span className="text-[9px] opacity-70">{PRODUCT_LETTERS[index] || index + 1}</span>
      {product.sourceHost.replace(/^www\./, '').split('.')[0]}
    </span>
  );
}

function ActionPoints({ items }: { items: string[] }) {
  return (
    <section>
      <div className="text-[10px] tracking-[0.2em] text-stone-500 uppercase font-medium mb-4">
        실행 액션
      </div>
      <ol className="bg-white border border-stone-200 rounded divide-y divide-stone-100">
        {items.map((it, i) => (
          <li key={i} className="px-5 py-3.5 flex gap-4 items-start">
            <span className="flex-shrink-0 w-6 h-6 rounded-full border-2 border-stone-900 text-stone-900 text-[11px] font-bold flex items-center justify-center mt-0.5">
              {i + 1}
            </span>
            <span className="text-sm text-stone-800 leading-relaxed">{it}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatPrice(price?: number, currency?: string): string | null {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  const symbol = currency === 'KRW' || !currency ? '₩' : `${currency} `;
  return `${symbol}${price.toLocaleString('ko-KR')}`;
}
