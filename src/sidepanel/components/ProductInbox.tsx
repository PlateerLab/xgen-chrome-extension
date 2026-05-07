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

type UploadToast =
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

const BO_AUTOFILL_HINT = 'bo.x2bee.com 상품등록 페이지를 활성 탭으로 두고 다시 시도하세요.';

export function ProductInbox({ onBack }: ProductInboxProps) {
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [capture, setCapture] = useState<CaptureState>({ kind: 'idle' });
  const [uploadToast, setUploadToast] = useState<UploadToast | null>(null);
  const enrichingRef = useRef<Map<string, AbortController>>(new Map());
  const uploadToastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (uploadToastTimerRef.current) {
        clearTimeout(uploadToastTimerRef.current);
      }
    };
  }, []);

  const showUploadToast = (toast: UploadToast) => {
    setUploadToast(toast);
    if (uploadToastTimerRef.current) clearTimeout(uploadToastTimerRef.current);
    uploadToastTimerRef.current = window.setTimeout(() => setUploadToast(null), 5000);
  };

  useEffect(() => {
    const map = enrichingRef.current;
    return () => {
      // 컴포넌트 언마운트 시 진행 중인 enrich 모두 abort
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
      .catch((err) => {
        console.warn('[ProductInbox] listProducts failed:', err);
        setLoaded(true);
      });
    return subscribeProducts(setProducts);
  }, []);

  const handleUpload = async (id: string) => {
    const product = products.find((p) => p.id === id);
    if (!product) return;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id || !tab.url) {
        showUploadToast({ kind: 'error', message: '활성 탭을 찾을 수 없습니다.' });
        return;
      }
      let host = '';
      try {
        host = new URL(tab.url).hostname;
      } catch {}
      if (host !== 'bo.x2bee.com') {
        showUploadToast({ kind: 'error', message: BO_AUTOFILL_HINT });
        return;
      }

      const response = (await chrome.tabs.sendMessage(tab.id, {
        type: 'PRODUCT_UPLOAD_REQUEST',
        draft: product,
      } satisfies ExtensionMessage)) as ExtensionMessage | undefined;

      if (!response || response.type !== 'PRODUCT_UPLOAD_RESPONSE') {
        showUploadToast({ kind: 'error', message: '응답을 받지 못했습니다.' });
        return;
      }
      if (!response.ok) {
        showUploadToast({ kind: 'error', message: response.error || '업로드 실패' });
        return;
      }

      const filledN = response.filledCount ?? 0;
      const missing = response.missingLabels ?? [];
      const missingPart = missing.length > 0 ? ` · 미발견: ${missing.join(', ')}` : '';
      const detailMsg = response.joditInjected
        ? `상세 주입 OK(${response.joditInjectMethod})`
        : response.joditFound
        ? '상세 주입 실패'
        : 'Jodit 미발견';
      showUploadToast({
        kind: 'success',
        message: `필드 ${filledN}개${missingPart} · ${detailMsg}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = /Receiving end does not exist|Could not establish connection/i.test(msg)
        ? BO_AUTOFILL_HINT
        : msg;
      showUploadToast({ kind: 'error', message: friendly });
    }
  };

  const handleRemove = (id: string) => {
    const ctrl = enrichingRef.current.get(id);
    if (ctrl) {
      ctrl.abort();
      enrichingRef.current.delete(id);
    }
    removeProduct(id).catch((err) => console.warn('[ProductInbox] remove failed:', err));
  };

  const startEnrich = async (draft: ProductDraft, pageSnippet: string) => {
    const config = (await chrome.runtime.sendMessage({
      type: 'GET_CHAT_CONFIG',
    } satisfies ExtensionMessage)) as
      | { type: 'CHAT_CONFIG'; serverUrl: string; authToken: string; provider: string; model: string }
      | undefined;
    if (!config?.serverUrl || !config.authToken) {
      console.warn('[ProductInbox] enrich skipped — config 부재');
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
      console.warn('[ProductInbox] enrich failed:', msg);
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
      // fire-and-forget — 사이드패널 닫힘/언마운트로만 abort
      void startEnrich(enrichingDraft, response.pageSnippet || '');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // tabs.sendMessage가 receiver 없을 때 던지는 에러 케이스 안내
      const friendly = /Receiving end does not exist|Could not establish connection/i.test(msg)
        ? '페이지에 콘텐츠 스크립트가 로드되지 않았습니다. 페이지를 새로고침 후 다시 시도하세요.'
        : msg;
      setCapture({ kind: 'error', message: friendly });
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
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
        <span className="text-sm font-medium text-gray-700 ml-1">📦 상품 수집함</span>
        {products.length > 0 && (
          <span className="ml-auto text-[11px] text-gray-400">{products.length}개</span>
        )}
      </div>

      <div className="px-3 py-2 border-b border-gray-100">
        <button
          onClick={handleCapture}
          disabled={capture.kind === 'capturing'}
          className="w-full text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors py-1.5 rounded flex items-center justify-center gap-1.5"
        >
          {capture.kind === 'capturing' ? (
            <>
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" opacity="0.25" />
                <path d="M22 12a10 10 0 0 1-10 10" strokeLinecap="round" />
              </svg>
              추출 중...
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

      {uploadToast && (
        <div
          className={`px-3 py-1.5 text-[11px] border-b ${
            uploadToast.kind === 'success'
              ? 'bg-violet-50 border-violet-200 text-violet-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}
        >
          {uploadToast.message}
        </div>
      )}

      {products.length > 0 && (
        <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1.5">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onRemove={handleRemove}
              onUpload={handleUpload}
            />
          ))}
        </div>
      )}
    </div>
  );
}
