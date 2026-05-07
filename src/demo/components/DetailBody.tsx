import { SectionTitle } from './SellingPoints';
import type { StreamPhase } from '../hooks/useDemoStreams';

interface Props {
  html?: string;
  phase: StreamPhase;
  error?: string;
}

export function DetailBody({ html, phase, error }: Props) {
  return (
    <section className="mt-10">
      <SectionTitle>상세 설명</SectionTitle>
      {error ? (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          AI 생성 실패: {error}
        </div>
      ) : html ? (
        <div
          className={`demo-detail-body text-sm ${phase === 'streaming' ? 'streaming-caret' : ''}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-2">
              <div className="skeleton h-4" style={{ width: '85%' }} />
              <div className="skeleton h-4" style={{ width: '92%' }} />
              <div className="skeleton h-4" style={{ width: '78%' }} />
            </div>
          ))}
          <div className="text-xs text-violet-600 mt-2 inline-flex items-center gap-1.5">
            <Spinner />
            AI가 상세 설명 작성 중...
          </div>
        </div>
      )}
    </section>
  );
}

function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" strokeLinecap="round" />
    </svg>
  );
}
