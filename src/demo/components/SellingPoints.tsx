import type { StreamPhase } from '../hooks/useDemoStreams';

interface Props {
  points?: string[];
  phase: StreamPhase;
}

export function SellingPoints({ points, phase }: Props) {
  if (phase === 'error') return null;

  return (
    <section className="mt-8">
      <SectionTitle>핵심 셀링포인트</SectionTitle>
      {points && points.length > 0 ? (
        <ul className="space-y-2.5">
          {points.map((p, i) => (
            <li key={i} className="flex items-start gap-3">
              <CheckIcon />
              <span className="text-sm text-gray-800 leading-relaxed">{p}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2.5">
          {[1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="flex items-start gap-3">
              <CheckIcon dim />
              <div className="skeleton h-4 flex-1" style={{ width: `${60 + (i % 3) * 15}%` }} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-bold mb-4 text-gray-900">{children}</h2>;
}

function CheckIcon({ dim = false }: { dim?: boolean }) {
  return (
    <span className={`flex-shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center ${dim ? 'bg-gray-200' : 'bg-violet-100'}`}>
      <svg className={`w-3 h-3 ${dim ? 'text-gray-400' : 'text-violet-700'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}
