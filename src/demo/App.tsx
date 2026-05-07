import { useEffect, useState } from 'react';
import type { ProductDraft } from '../shared/product/types';
import { listProducts } from '../shared/product/storage';
import { useDemoStreams } from './hooks/useDemoStreams';
import { useComparisonStream } from './hooks/useComparisonStream';
import { ProductHero } from './components/ProductHero';
import { SellingPoints } from './components/SellingPoints';
import { DetailBody } from './components/DetailBody';
import { Reviews } from './components/Reviews';
import { Qna } from './components/Qna';
import { DetailImages } from './components/DetailImages';
import { InsightPanel } from './components/InsightPanel';
import { ComparisonView } from './components/ComparisonView';

function getIdsFromUrl(): { single?: string; multi?: string[] } {
  const params = new URLSearchParams(window.location.search);
  const ids = params.get('ids');
  if (ids) {
    const arr = ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (arr.length >= 2) return { multi: arr };
    if (arr.length === 1) return { single: arr[0] };
  }
  const id = params.get('id');
  if (id) return { single: id };
  return {};
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'single'; product: ProductDraft }
  | { kind: 'compare'; products: ProductDraft[] };

export function App() {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    const { single, multi } = getIdsFromUrl();
    if (!single && !multi) {
      setLoad({ kind: 'not-found' });
      return;
    }
    listProducts()
      .then((all) => {
        if (multi) {
          const found = multi
            .map((id) => all.find((p) => p.id === id))
            .filter((p): p is ProductDraft => !!p);
          if (found.length >= 2) setLoad({ kind: 'compare', products: found });
          else if (found.length === 1) setLoad({ kind: 'single', product: found[0] });
          else setLoad({ kind: 'not-found' });
          return;
        }
        const found = all.find((p) => p.id === single);
        if (found) setLoad({ kind: 'single', product: found });
        else setLoad({ kind: 'not-found' });
      })
      .catch(() => setLoad({ kind: 'not-found' }));
  }, []);

  if (load.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-stone-400 text-sm">
        상품 정보 불러오는 중…
      </div>
    );
  }
  if (load.kind === 'not-found') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-stone-500">
        <div className="text-3xl">⌀</div>
        <p className="text-sm">상품을 찾을 수 없습니다.</p>
        <p className="text-xs text-stone-400">사이드패널의 상품 수집함에서 다시 시도해주세요.</p>
      </div>
    );
  }
  if (load.kind === 'compare') {
    return <CompareEntry products={load.products} />;
  }
  return <SingleView product={load.product} />;
}

function CompareEntry({ products }: { products: ProductDraft[] }) {
  const state = useComparisonStream(products);
  return <ComparisonView products={products} state={state} />;
}

function SingleView({ product }: { product: ProductDraft }) {
  const { detail, insight } = useDemoStreams(product);

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <Header product={product} />
      <main className="max-w-7xl mx-auto px-4 lg:px-6 py-6 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
        <div className="bg-white rounded border border-stone-200 overflow-hidden">
          <ProductHero
            product={product}
            headline={detail.result?.heroHeadline ?? detail.partial.heroHeadline}
            subheadline={detail.result?.heroSubheadline ?? detail.partial.heroSubheadline}
            phase={detail.phase}
          />
          <div className="px-6 lg:px-10 pb-10">
            <SellingPoints points={detail.result?.sellingPoints} phase={detail.phase} />
            <DetailBody
              html={detail.result?.detailBodyHtml ?? detail.partialBody}
              phase={detail.phase}
              error={detail.error}
            />
            <DetailImages images={product.detailImageUrls} />
            <Reviews reviews={detail.result?.fakeReviews} phase={detail.phase} />
            <Qna qna={detail.result?.fakeQna} phase={detail.phase} />
            {detail.result?.relatedKeywords && detail.result.relatedKeywords.length > 0 && (
              <RelatedKeywords keywords={detail.result.relatedKeywords} />
            )}
          </div>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start space-y-3">
          <InsightPanel insight={insight} />
        </aside>
      </main>
      <footer className="max-w-7xl mx-auto px-6 lg:px-10 py-6 text-[10px] tracking-[0.15em] uppercase text-stone-400 border-t border-stone-200 mt-6">
        XGEN · 상세 콘텐츠/후기/Q&A/인사이트는 LLM 추론 기반 가상 데이터
      </footer>
    </div>
  );
}

function Header({ product }: { product: ProductDraft }) {
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
            Product Analysis · {product.sourceHost}
          </div>
          <div className="text-sm font-semibold text-stone-900 truncate mt-0.5">{product.title}</div>
        </div>
        <div className="hidden sm:block text-[10px] tracking-[0.2em] text-stone-400 uppercase">XGEN</div>
      </div>
    </header>
  );
}

function RelatedKeywords({ keywords }: { keywords: string[] }) {
  return (
    <section className="mt-12">
      <div className="text-[10px] tracking-[0.2em] text-stone-500 uppercase font-medium mb-3">연관 키워드</div>
      <div className="flex flex-wrap gap-1.5">
        {keywords.map((k) => (
          <span key={k} className="px-2.5 py-1 rounded border border-stone-200 text-stone-700 text-xs">
            {k}
          </span>
        ))}
      </div>
    </section>
  );
}
