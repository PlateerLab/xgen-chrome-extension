import { useState } from 'react';
import type { DetailQna } from '../../shared/product/demo-prompts';
import type { StreamPhase } from '../hooks/useDemoStreams';

interface Props {
  qna?: DetailQna[];
  phase: StreamPhase;
}

export function Qna({ qna, phase }: Props) {
  if (phase === 'error') return null;
  if (!qna || qna.length === 0) {
    if (phase === 'done') return null;
    return null;
  }

  return (
    <section className="mt-12">
      <div className="flex items-baseline gap-3 mb-4">
        <h2 className="text-lg font-bold text-gray-900">상품 Q&A</h2>
        <span className="text-xs text-gray-500">{qna.length}건</span>
        <span className="ml-auto text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
          ✨ AI 생성 가상 데이터
        </span>
      </div>
      <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
        {qna.map((item, i) => (
          <QnaItem key={i} item={item} defaultOpen={i === 0} />
        ))}
      </div>
    </section>
  );
}

function QnaItem({ item, defaultOpen }: { item: DetailQna; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50"
      >
        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-violet-100 text-violet-700 text-[10px] font-bold flex items-center justify-center">Q</span>
        <span className="flex-1 text-sm text-gray-800">{item.q}</span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="px-4 pb-4 pl-12 flex gap-3">
          <span className="flex-shrink-0 w-5 h-5 -ml-8 mt-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold flex items-center justify-center">A</span>
          <p className="text-xs text-gray-600 leading-relaxed">{item.a}</p>
        </div>
      )}
    </div>
  );
}
