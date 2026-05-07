import { useState } from 'react';

interface Props {
  images?: string[];
}

const PREVIEW_COUNT = 2;

export function DetailImages({ images }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!images || images.length === 0) return null;

  const visible = expanded ? images : images.slice(0, PREVIEW_COUNT);

  return (
    <section className="mt-12">
      <div className="flex items-baseline gap-3 mb-4">
        <h2 className="text-lg font-bold text-gray-900">상품 상세 이미지</h2>
        <span className="text-xs text-gray-500">{images.length}장</span>
        <span className="ml-auto text-[10px] text-violet-700 bg-violet-50 px-2 py-0.5 rounded-full border border-violet-100">
          🌐 원본 사이트에서 가져옴
        </span>
      </div>

      <div className={`relative space-y-2 ${expanded ? '' : 'max-h-[600px] overflow-hidden'}`}>
        {visible.map((url, i) => (
          <img
            key={i}
            src={url}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="w-full max-w-3xl mx-auto block rounded-md"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ))}

        {!expanded && images.length > PREVIEW_COUNT && (
          <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-white via-white/90 to-transparent pointer-events-none" />
        )}
      </div>

      {images.length > PREVIEW_COUNT && (
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="px-5 py-2 rounded-full border border-gray-300 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 inline-flex items-center gap-2 shadow-sm"
          >
            {expanded ? (
              <>
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
                접기
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                상세 이미지 더 보기 ({images.length - PREVIEW_COUNT}장)
              </>
            )}
          </button>
        </div>
      )}
    </section>
  );
}
