import { useEffect, useRef, useState } from 'react';
import type { ProductDraft } from '../../shared/product/types';
import type { ExtensionMessage } from '../../shared/types';
import { addProduct, listProducts, removeProduct, subscribeProducts, updateProduct } from '../../shared/product/storage';
import { enrichProductDraft } from '../../shared/product/extractor';
import { ProductCard } from './ProductCard';

interface ProductInboxProps {
  onBack: () => void;
}

type CaptureState =
  | { kind: 'idle' }
  | { kind: 'capturing' }
  | { kind: 'error'; message: string };

type AnalyzeToast =
  | { kind: 'info'; message: string }
  | { kind: 'error'; message: string };

const MAX_COMPARE = 3;

export function ProductInbox({ onBack }: ProductInboxProps) {
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [capture, setCapture] = useState<CaptureState>({ kind: 'idle' });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [analyzeToast, setAnalyzeToast] = useState<AnalyzeToast | null>(null);
  const enrichingRef = useRef<Map<string, AbortController>>(new Map());
  const analyzeToastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (analyzeToastTimerRef.current) clearTimeout(analyzeToastTimerRef.current);
    };
  }, []);

  const showAnalyzeToast = (toast: AnalyzeToast) => {
    setAnalyzeToast(toast);
    if (analyzeToastTimerRef.current) clearTimeout(analyzeToastTimerRef.current);
    analyzeToastTimerRef.current = window.setTimeout(() => setAnalyzeToast(null), 4000);
  };

  useEffect(() => {
    const map = enrichingRef.current;
    return () => {
      map.forEach((ctrl) => ctrl.abort());
      map.clear();
    };
  }, []);

  useEffect(() => {
    listProducts()
      .then((items) => {
        setProducts(items);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return subscribeProducts((next) => {
      setProducts(next);
      // 사라진 상품의 선택 해제
      setSelectedIds((prev) => {
        const ids = new Set(next.map((p) => p.id));
        const filtered = new Set([...prev].filter((id) => ids.has(id)));
        return filtered.size === prev.size ? prev : filtered;
      });
    });
  }, []);

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= MAX_COMPARE) {
          showAnalyzeToast({ kind: 'error', message: `최대 ${MAX_COMPARE}개까지 비교 가능합니다.` });
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  };

  const handleClearSelection = () => setSelectedIds(new Set());

  const handleRemove = (id: string) => {
    const ctrl = enrichingRef.current.get(id);
    if (ctrl) {
      ctrl.abort();
      enrichingRef.current.delete(id);
    }
    removeProduct(id).catch(() => {});
  };

  const handleAnalyze = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const valid = ids.filter((id) => products.find((p) => p.id === id)?.status !== 'enriching');
    if (valid.length === 0) {
      showAnalyzeToast({ kind: 'error', message: 'AI 보강이 끝난 후 다시 시도하세요.' });
      return;
    }

    const url =
      valid.length === 1
        ? chrome.runtime.getURL(`src/demo/index.html?id=${encodeURIComponent(valid[0])}`)
        : chrome.runtime.getURL(`src/demo/index.html?ids=${valid.map(encodeURIComponent).join(',')}`);

    try {
      await chrome.tabs.create({ url });
      showAnalyzeToast({
        kind: 'info',
        message: valid.length === 1 ? 'AI 분석 페이지를 열었습니다.' : `${valid.length}개 비교 분석을 시작합니다.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showAnalyzeToast({ kind: 'error', message: `탭 열기 실패: ${msg}` });
    }
  };

  const startEnrich = async (draft: ProductDraft, pageSnippet: string) => {
    const config = (await chrome.runtime.sendMessage({
      type: 'GET_CHAT_CONFIG',
    } satisfies ExtensionMessage)) as
      | { type: 'CHAT_CONFIG'; serverUrl: string; authToken: string; provider: string; model: string }
      | undefined;
    if (!config?.serverUrl || !config.authToken) {
      await updateProduct(draft.id, { status: 'failed', aiNotes: 'XGEN 로그인이 필요합니다.' });
      return;
    }
    const controller = new AbortController();
    enrichingRef.current.set(draft.id, controller);
    try {
      const patch = await enrichProductDraft({
        serverUrl: config.serverUrl,
        token: config.authToken,
        provider: config.provider,
        model: config.model,
        draft,
        pageSnippet,
        signal: controller.signal,
      });
      await updateProduct(draft.id, { ...patch, status: 'enriched' });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      await updateProduct(draft.id, { status: 'failed', aiNotes: msg });
    } finally {
      enrichingRef.current.delete(draft.id);
    }
  };

  const handleCapture = async () => {
    setCapture({ kind: 'capturing' });
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id) {
        setCapture({ kind: 'error', message: '활성 탭을 찾을 수 없습니다.' });
        return;
      }
      const url = tab.url || '';
      if (!url || /^chrome:\/\/|^chrome-extension:\/\/|^edge:\/\/|^about:/i.test(url)) {
        setCapture({ kind: 'error', message: '이 페이지에서는 캡처할 수 없습니다.' });
        return;
      }

      const response = (await chrome.tabs.sendMessage(tab.id, {
        type: 'PRODUCT_CAPTURE_REQUEST',
      } satisfies ExtensionMessage)) as ExtensionMessage | undefined;

      if (!response || response.type !== 'PRODUCT_CAPTURE_RESPONSE') {
        setCapture({ kind: 'error', message: '응답을 받지 못했습니다.' });
        return;
      }
      if (!response.ok || !response.draft) {
        setCapture({ kind: 'error', message: response.error || '추출 실패' });
        return;
      }
      const enrichingDraft: ProductDraft = { ...response.draft, status: 'enriching' };
      await addProduct(enrichingDraft);
      setCapture({ kind: 'idle' });
      void startEnrich(enrichingDraft, response.pageSnippet || '');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = /Receiving end does not exist|Could not establish connection/i.test(msg)
        ? '페이지에 콘텐츠 스크립트가 로드되지 않았습니다. 페이지를 새로고침 후 다시 시도하세요.'
        : msg;
      setCapture({ kind: 'error', message: friendly });
    }
  };

  const selectedCount = selectedIds.size;

  return (
    <div className="flex flex-col flex-1 min-h-0 relative">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-gray-600 text-xs flex items-center gap-1"
          title="채팅으로 돌아가기"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          채팅으로
        </button>
        <span className="text-sm font-medium text-gray-700 ml-1">상품 수집함</span>
        {products.length > 0 && (
          <span className="ml-auto text-[11px] text-gray-400">{products.length}개</span>
        )}
      </div>

      <div className="px-3 py-2 border-b border-gray-100">
        <button
          onClick={handleCapture}
          disabled={capture.kind === 'capturing'}
          className="w-full text-xs font-medium text-white bg-gray-900 hover:bg-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors py-1.5 rounded flex items-center justify-center gap-1.5"
        >
          {capture.kind === 'capturing' ? (
            <>
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" opacity="0.25" />
                <path d="M22 12a10 10 0 0 1-10 10" strokeLinecap="round" />
              </svg>
              추출 중
            </>
          ) : (
            <>
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5v14" />
              </svg>
              이 페이지 캡처
            </>
          )}
        </button>
        {capture.kind === 'error' && (
          <p className="mt-1 text-[11px] text-red-600">{capture.message}</p>
        )}
      </div>

      {analyzeToast && (
        <div
          className={`px-3 py-1.5 text-[11px] border-b ${
            analyzeToast.kind === 'info'
              ? 'bg-violet-50 border-violet-200 text-violet-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}
        >
          {analyzeToast.message}
        </div>
      )}

      {loaded && products.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center text-gray-400 text-sm gap-3">
          <svg className="w-12 h-12 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
          <p className="leading-relaxed">
            아직 캡처된 상품이 없습니다.
            <br />
            경쟁사 상품 페이지에서
            <br />
            "이 페이지 캡처"를 눌러보세요.
          </p>
        </div>
      )}

      {products.length > 0 && (
        <>
          <div className="px-3 py-1.5 border-b border-gray-100 text-[11px] text-gray-500">
            {selectedCount === 0
              ? '카드를 눌러 분석할 상품을 선택하세요. 2~3개를 고르면 비교 분석.'
              : selectedCount === 1
              ? '1개 선택 — AI 분석'
              : `${selectedCount}개 선택 — AI 비교 분석`}
          </div>
          <div className={`flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1.5 ${selectedCount > 0 ? 'pb-16' : ''}`}>
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                selected={selectedIds.has(product.id)}
                onToggleSelect={handleToggleSelect}
                onRemove={handleRemove}
              />
            ))}
          </div>
        </>
      )}

      {/* 하단 액션 바 — 선택된 게 있을 때 */}
      {selectedCount > 0 && (
        <div className="absolute bottom-0 left-0 right-0 border-t border-gray-200 bg-white/95 backdrop-blur px-3 py-2 flex items-center gap-2 shadow-lg">
          <button
            onClick={handleClearSelection}
            className="text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1"
          >
            취소
          </button>
          <button
            onClick={handleAnalyze}
            className="flex-1 text-xs font-semibold text-white bg-gradient-to-r from-violet-700 to-indigo-700 hover:from-violet-800 hover:to-indigo-800 transition-colors py-2 rounded inline-flex items-center justify-center gap-1.5 shadow-sm"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            {selectedCount === 1 ? 'AI 분석' : `AI 비교 분석 · ${selectedCount}개`}
          </button>
        </div>
      )}
    </div>
  );
}
