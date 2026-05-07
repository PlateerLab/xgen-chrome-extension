import { SectionTitle } from './SellingPoints';
import type { DetailReview } from '../../shared/product/demo-prompts';
import type { StreamPhase } from '../hooks/useDemoStreams';

interface Props {
  reviews?: DetailReview[];
  phase: StreamPhase;
}

export function Reviews({ reviews, phase }: Props) {
  if (phase === 'error') return null;

  return (
    <section className="mt-12">
      <div className="flex items-baseline gap-3 mb-4">
        <h2 className="text-lg font-bold text-gray-900">후기</h2>
        {reviews && reviews.length > 0 && (
          <span className="text-xs text-gray-500">{reviews.length}건</span>
        )}
        <span className="ml-auto text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
          ✨ AI 생성 가상 데이터
        </span>
      </div>

      {reviews && reviews.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {reviews.map((r, i) => (
            <ReviewCard key={i} review={r} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="border border-gray-200 rounded-xl p-4 space-y-2">
              <div className="skeleton h-3 w-1/3" />
              <div className="skeleton h-4 w-2/3" />
              <div className="skeleton h-3" />
              <div className="skeleton h-3 w-5/6" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewCard({ review }: { review: DetailReview }) {
  const rating = Math.max(0, Math.min(5, Math.round(review.rating)));
  return (
    <article className="border border-gray-200 rounded-xl p-4 hover:border-violet-300 transition-colors bg-white">
      <div className="flex items-center gap-2 mb-2">
        <Stars rating={rating} />
        <span className="text-[11px] text-gray-500">{review.author || '익명'}</span>
      </div>
      <h4 className="text-sm font-semibold text-gray-900 mb-1.5">{review.title}</h4>
      <p className="text-xs text-gray-600 leading-relaxed">{review.body}</p>
    </article>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <div className="flex">
      {[1, 2, 3, 4, 5].map((i) => (
        <svg
          key={i}
          className={`w-3.5 h-3.5 ${i <= rating ? 'text-amber-400' : 'text-gray-200'}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 2l2.6 7.2H22l-6 4.5 2.4 7.3L12 16.7 5.6 21l2.4-7.3-6-4.5h7.4z" />
        </svg>
      ))}
    </div>
  );
}
