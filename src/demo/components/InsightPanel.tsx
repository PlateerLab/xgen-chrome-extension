import type {
  InsightContent,
  InsightPricingStrategy,
  InsightOperationalRisk,
  InsightGrowthLever,
  InsightMarketingPlay,
  InsightWeekPlan,
  Verdict,
} from '../../shared/product/demo-prompts';
import type { SideState, StreamPhase } from '../hooks/useDemoStreams';

interface Props {
  insight: SideState<InsightContent>;
}

export function InsightPanel({ insight }: Props) {
  const r = insight.result;
  const phase = insight.phase;

  return (
    <div className="space-y-3">
      <PanelHeader phase={phase} verdict={r?.verdict} />

      {insight.error ? (
        <Card>
          <div className="text-sm text-red-600">생성 실패: {insight.error}</div>
        </Card>
      ) : (
        <>
          <ExecSummaryCard summary={r?.executiveSummary} category={r?.category} verdict={r?.verdict} phase={phase} />
          <MarketReadinessCard data={r?.marketReadiness} phase={phase} />
          <PricingStrategyCard data={r?.pricingStrategy} phase={phase} />
          <RisksCard risks={r?.operationalRisks} phase={phase} />
          <GrowthCard levers={r?.growthLevers} phase={phase} />
          <MarketingCard plays={r?.marketingPlaybook} phase={phase} />
          <PlanCard plan={r?.thirtyDayPlan} phase={phase} />
          <ListCard
            title="🔗 번들/연관 SKU 후보"
            items={r?.complementarySKUs}
            phase={phase}
            tone="violet"
          />
          <ListCard
            title="✅ 등록 전 체크리스트"
            items={r?.watchouts}
            phase={phase}
            tone="amber"
            bulletStyle="check"
          />
        </>
      )}
    </div>
  );
}

function PanelHeader({ phase, verdict }: { phase: StreamPhase; verdict?: Verdict }) {
  return (
    <div className="bg-stone-900 rounded text-white px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] tracking-[0.2em] uppercase font-semibold text-stone-400">MD Brief</span>
        <span className="text-sm font-semibold ml-1">검토 보고서</span>
        {verdict && <VerdictBadge verdict={verdict} />}
        {phase === 'streaming' && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] tracking-wider uppercase text-stone-300">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            분석 중
          </span>
        )}
        {phase === 'done' && !verdict && (
          <span className="ml-auto text-[10px] tracking-wider uppercase text-stone-400">완료</span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-stone-400 leading-relaxed">실무 MD 관점 — GO/HOLD/SKIP + 운영 액션</p>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const map: Record<Verdict, { label: string; cls: string }> = {
    go: { label: 'GO', cls: 'bg-emerald-400 text-emerald-950' },
    hold: { label: 'HOLD', cls: 'bg-amber-300 text-amber-950' },
    skip: { label: 'SKIP', cls: 'bg-rose-400 text-rose-950' },
  };
  const m = map[verdict];
  return <span className={`ml-auto px-2 py-0.5 rounded-md text-[10px] font-bold ${m.cls}`}>{m.label}</span>;
}

function Card({ children, accent }: { children: React.ReactNode; accent?: 'violet' | 'green' | 'amber' | 'red' | 'blue' }) {
  const accentMap = {
    violet: 'border-violet-200',
    green: 'border-emerald-200',
    amber: 'border-amber-200',
    red: 'border-red-200',
    blue: 'border-blue-200',
  };
  return (
    <div className={`bg-white rounded-xl border ${accent ? accentMap[accent] : 'border-gray-200'} p-4 shadow-sm`}>
      {children}
    </div>
  );
}

function CardLabel({ children, color = 'slate' }: { children: React.ReactNode; color?: string }) {
  const colorMap: Record<string, string> = {
    slate: 'text-slate-700',
    violet: 'text-violet-700',
    green: 'text-emerald-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
    blue: 'text-blue-700',
  };
  return <div className={`text-[11px] font-semibold uppercase tracking-wider mb-2.5 ${colorMap[color] ?? colorMap.slate}`}>{children}</div>;
}

function Skeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton h-3" style={{ width: `${70 + ((i * 7) % 25)}%` }} />
      ))}
    </div>
  );
}

function ExecSummaryCard({
  summary,
  category,
  verdict,
  phase,
}: { summary?: string; category?: string; verdict?: Verdict; phase: StreamPhase }) {
  const ready = summary || category;
  return (
    <Card accent="violet">
      <CardLabel color="violet">📌 요약</CardLabel>
      {ready ? (
        <>
          {category && <p className="text-[11px] text-gray-500 mb-1.5">{category}</p>}
          {summary && <p className="text-sm text-gray-900 leading-relaxed font-medium">{summary}</p>}
          {verdict && (
            <div className="mt-2 text-[11px] text-gray-500">
              MD 판단: <VerdictInline verdict={verdict} />
            </div>
          )}
        </>
      ) : phase === 'streaming' || phase === 'loading-config' ? <Skeleton lines={3} /> : null}
    </Card>
  );
}

function VerdictInline({ verdict }: { verdict: Verdict }) {
  const map: Record<Verdict, { label: string; cls: string }> = {
    go: { label: 'GO (진행)', cls: 'text-emerald-700 bg-emerald-50' },
    hold: { label: 'HOLD (보류)', cls: 'text-amber-700 bg-amber-50' },
    skip: { label: 'SKIP (제외)', cls: 'text-rose-700 bg-rose-50' },
  };
  const m = map[verdict];
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${m.cls}`}>{m.label}</span>;
}

function MarketReadinessCard({ data, phase }: { data?: InsightContent['marketReadiness']; phase: StreamPhase }) {
  if (!data && phase !== 'streaming' && phase !== 'loading-config') return null;
  return (
    <Card accent="blue">
      <CardLabel color="blue">📊 시장 진단</CardLabel>
      {data ? (
        <div className="space-y-2 text-xs">
          <DiagnoseRow icon="🔍" label="수요 신호" value={data.demandSignal} />
          <DiagnoseRow icon="📅" label="시즌성" value={data.seasonality} />
          <DiagnoseRow icon="⚔️" label="경쟁 강도" value={data.competition} />
        </div>
      ) : <Skeleton lines={3} />}
    </Card>
  );
}

function DiagnoseRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="flex-shrink-0">{icon}</span>
      <div className="flex-1">
        <div className="text-[10px] text-gray-500 font-medium">{label}</div>
        <div className="text-gray-900 leading-relaxed">{value}</div>
      </div>
    </div>
  );
}

function PricingStrategyCard({ data, phase }: { data?: InsightPricingStrategy; phase: StreamPhase }) {
  if (!data && phase !== 'streaming' && phase !== 'loading-config') return null;
  return (
    <Card accent="green">
      <CardLabel color="green">💰 가격 전략</CardLabel>
      {data ? (
        <>
          <PriceBar low={data.marketLowKRW} avg={data.marketAvgKRW} high={data.marketHighKRW} entry={data.recommendedEntryKRW} />
          <div className="mt-3 space-y-1.5">
            {data.marginScenarios?.slice(0, 3).map((sc) => (
              <ScenarioRow key={sc.label} sc={sc} />
            ))}
          </div>
          {data.rationale && (
            <p className="mt-3 text-[11px] text-gray-600 leading-relaxed border-t border-gray-100 pt-2">{data.rationale}</p>
          )}
        </>
      ) : <Skeleton lines={4} />}
    </Card>
  );
}

function PriceBar({ low, avg, high, entry }: { low: number; avg: number; high: number; entry: number }) {
  const range = Math.max(high - low, 1);
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - low) / range) * 100));
  return (
    <div>
      <div className="flex justify-between text-[10px] text-gray-500 mb-1">
        <span>최저 ₩{Math.round(low).toLocaleString('ko-KR')}</span>
        <span>최고 ₩{Math.round(high).toLocaleString('ko-KR')}</span>
      </div>
      <div className="relative h-7 rounded-md bg-gradient-to-r from-emerald-100 via-amber-100 to-rose-100">
        <div className="absolute top-0 bottom-0 border-l-2 border-gray-400" style={{ left: `${pct(avg)}%` }} title={`평균 ₩${Math.round(avg).toLocaleString('ko-KR')}`} />
        <div
          className="absolute top-0 bottom-0 w-2 -ml-1 bg-violet-600 rounded shadow-md"
          style={{ left: `${pct(entry)}%` }}
          title={`추천 진입가 ₩${Math.round(entry).toLocaleString('ko-KR')}`}
        />
        <div
          className="absolute -bottom-5 text-[10px] font-bold text-violet-700 -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${pct(entry)}%` }}
        >
          ₩{Math.round(entry).toLocaleString('ko-KR')} 추천
        </div>
      </div>
      <div className="mt-7 text-[10px] text-gray-400 text-center">시장가 ↔ 추천 진입가</div>
    </div>
  );
}

function ScenarioRow({ sc }: { sc: { label: string; supplyKRW: number; saleKRW: number; marginPercent: number } }) {
  const bgMap: Record<string, string> = {
    보수: 'bg-blue-50 border-blue-100',
    표준: 'bg-emerald-50 border-emerald-100',
    공격: 'bg-rose-50 border-rose-100',
  };
  return (
    <div className={`border ${bgMap[sc.label] ?? 'bg-gray-50 border-gray-100'} rounded-lg px-2.5 py-1.5 grid grid-cols-[auto_1fr_1fr_auto] gap-2 items-center text-[11px]`}>
      <span className="font-bold text-gray-800">{sc.label}</span>
      <span className="text-gray-600">공급가 ₩{Math.round(sc.supplyKRW).toLocaleString('ko-KR')}</span>
      <span className="text-gray-900 font-medium">판매가 ₩{Math.round(sc.saleKRW).toLocaleString('ko-KR')}</span>
      <span className="font-bold text-emerald-700">{sc.marginPercent}%</span>
    </div>
  );
}

function RisksCard({ risks, phase }: { risks?: InsightOperationalRisk[]; phase: StreamPhase }) {
  if (!risks && phase !== 'streaming' && phase !== 'loading-config') return null;
  return (
    <Card accent="red">
      <CardLabel color="red">⚠️ 운영 리스크</CardLabel>
      {risks ? (
        <ul className="space-y-2">
          {risks.map((r, i) => (
            <li key={i} className="flex gap-2">
              <SeverityChip severity={r.severity} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-gray-900">{r.title}</div>
                <div className="text-[11px] text-gray-600 leading-relaxed">{r.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : <Skeleton lines={3} />}
    </Card>
  );
}

function SeverityChip({ severity }: { severity: 'high' | 'mid' | 'low' }) {
  const map = {
    high: { label: 'HIGH', cls: 'bg-rose-100 text-rose-700' },
    mid: { label: 'MID', cls: 'bg-amber-100 text-amber-700' },
    low: { label: 'LOW', cls: 'bg-slate-100 text-slate-600' },
  };
  const m = map[severity] || map.mid;
  return <span className={`flex-shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide ${m.cls}`}>{m.label}</span>;
}

function GrowthCard({ levers, phase }: { levers?: InsightGrowthLever[]; phase: StreamPhase }) {
  if (!levers && phase !== 'streaming' && phase !== 'loading-config') return null;
  return (
    <Card>
      <CardLabel color="violet">🚀 성장 레버</CardLabel>
      {levers ? (
        <ul className="space-y-2.5">
          {levers.map((l, i) => (
            <li key={i} className="border-l-2 border-violet-300 pl-2.5">
              <div className="text-[10px] text-violet-700 font-semibold uppercase">{l.lever}</div>
              <div className="text-xs text-gray-900 mt-0.5">{l.tactic}</div>
              <div className="text-[11px] text-emerald-700 font-medium mt-0.5">→ {l.expectedImpact}</div>
            </li>
          ))}
        </ul>
      ) : <Skeleton lines={3} />}
    </Card>
  );
}

function MarketingCard({ plays, phase }: { plays?: InsightMarketingPlay[]; phase: StreamPhase }) {
  if (!plays && phase !== 'streaming' && phase !== 'loading-config') return null;
  return (
    <Card>
      <CardLabel color="blue">📣 마케팅 플레이북</CardLabel>
      {plays ? (
        <ul className="space-y-2">
          {plays.map((p, i) => (
            <li key={i} className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[11px] font-bold text-slate-900">{p.channel}</span>
                <span className="text-[10px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">{p.kpi}</span>
              </div>
              <div className="text-[11px] text-gray-700 leading-relaxed">{p.tactic}</div>
            </li>
          ))}
        </ul>
      ) : <Skeleton lines={3} />}
    </Card>
  );
}

function PlanCard({ plan, phase }: { plan?: InsightWeekPlan[]; phase: StreamPhase }) {
  if (!plan && phase !== 'streaming' && phase !== 'loading-config') return null;
  return (
    <Card>
      <CardLabel color="amber">🗓 30일 액션 플랜</CardLabel>
      {plan ? (
        <ol className="space-y-1.5">
          {plan.map((p, i) => (
            <li key={i} className="flex gap-2 items-start">
              <span className="flex-shrink-0 w-7 h-5 mt-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold flex items-center justify-center">
                {p.week}
              </span>
              <span className="flex-1 text-[11px] text-gray-800 leading-relaxed">{p.action}</span>
            </li>
          ))}
        </ol>
      ) : <Skeleton lines={4} />}
    </Card>
  );
}

function ListCard({
  title,
  items,
  phase,
  tone,
  bulletStyle = 'dot',
}: { title: string; items?: string[]; phase: StreamPhase; tone?: 'violet' | 'amber'; bulletStyle?: 'dot' | 'check' }) {
  if (!items && phase !== 'streaming' && phase !== 'loading-config') return null;
  return (
    <Card accent={tone}>
      <CardLabel color={tone === 'amber' ? 'amber' : 'violet'}>{title}</CardLabel>
      {items && items.length > 0 ? (
        <ul className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2 text-xs text-gray-800 leading-relaxed">
              <span className={`flex-shrink-0 ${tone === 'amber' ? 'text-amber-600' : 'text-violet-600'}`}>
                {bulletStyle === 'check' ? '✓' : '•'}
              </span>
              <span className="flex-1">{it}</span>
            </li>
          ))}
        </ul>
      ) : <Skeleton lines={3} />}
    </Card>
  );
}
