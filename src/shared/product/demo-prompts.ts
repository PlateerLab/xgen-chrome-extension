import type { ProductDraft } from './types';

// Core: hero / sellingPoints / detailBodyHtml / relatedKeywords — 잘림 위험 최소화
const DETAIL_CORE_INSTRUCTION = `당신은 한국 e커머스 상품 상세 페이지 에디터입니다.

엄격한 규칙:
- 응답은 반드시 \`{\` 로 시작하는 단일 JSON 객체. 마크다운/설명/코드펜스 금지.
- 입력에 근거 있는 사실만. 가짜 스펙/허위 광고 금지.
- 톤: 한국 일반 e커머스 (쿠팡/스마트스토어). 친절·명확·살짝 감성.
- 출력 길이 엄수. 초과 금지.

스키마:
{
  "heroHeadline": "후크 1줄 (12~18자)",
  "heroSubheadline": "보조 1줄 (20~30자)",
  "sellingPoints": ["포인트 (15~25자)"] (정확히 4개),
  "detailBodyHtml": "<h3>...</h3><p>...</p><p>...</p> (총 200~350자 이내, 단순 텍스트만 — 따옴표 사용 금지)",
  "relatedKeywords": ["..."] (5개)
}`;

// Extras: reviews / qna — 별도 스트림. 잘려도 핵심 콘텐츠엔 영향 없음.
const DETAIL_EXTRAS_INSTRUCTION = `당신은 한국 e커머스 상품 상세 페이지의 가상 후기·Q&A 작성자입니다.

엄격한 규칙:
- 응답은 반드시 \`{\` 로 시작하는 단일 JSON 객체. 마크다운/설명 금지.
- 후기·Q&A는 가상 데이터. 자연스럽되 짧게.
- 본문에 따옴표(") 사용 금지.

스키마:
{
  "fakeReviews": [{"author": "닉네임 (예: '김**')", "rating": 4 또는 5, "title": "한줄 (15자 이내)", "body": "1줄 후기 (40자 이내)"}] (정확히 3개),
  "fakeQna": [{"q": "질문 (15자 이내)", "a": "답변 (30자 이내)"}] (정확히 2개)
}`;

const INSIGHT_INSTRUCTION = `당신은 한국 e커머스 베테랑 MD(상품기획자)입니다. 신규 상품 검토 보고서를 작성합니다. 실제로 매입·판매·운영 결정에 쓸 수 있는 깊이로 분석하세요.

엄격한 규칙:
- 출력은 오직 단일 JSON 객체. 마크다운/설명 금지.
- 출력 톤: 실무 MD가 회의 자료에 쓰는 한국어. 짧고 단정적. 두루뭉술 X. "할 것" / "주의" / "기회" 명확히.
- 모든 수치는 추정임을 명시(접미 "추정"). 카테고리·브랜드·가격대를 근거로 합리적 숫자 제시. 데이터 없다고 회피 X.
- 카테고리별 특화: 가전/패션/식품/뷰티/리빙 등. 각 카테고리 고유 리스크·기회를 짚으세요 (예: 식품 → 유통기한·식약처, 가전 → KC 인증·AS, 패션 → 시즌·재고회전).
- 한국 e커머스 컨텍스트: 쿠팡 로켓배송, 네이버 스마트스토어 검색 노출, 11번가 십일절, 메타광고 ROAS 등.

스키마(반드시 모든 필드 채울 것):
{
  "category": "표준 카테고리 (예: '가전 > 컴퓨터/노트북' 또는 '뷰티 > 스킨케어 > 토너')",
  "executiveSummary": "한 줄 결론 — 'GO/HOLD/SKIP + 근거 1줄' (예: 'GO — 마진 좁지만 부속 상품 시너지 +18% 추정')",
  "verdict": "go" 또는 "hold" 또는 "skip",
  "marketReadiness": {
    "demandSignal": "수요 신호 1~2줄 (검색량 추정 + 시즌성)",
    "seasonality": "시즌성 한 줄 (피크월/저점월 명시)",
    "competition": "경쟁 강도 한 줄 (low/mid/high + 근거)"
  },
  "pricingStrategy": {
    "marketLowKRW": 0,
    "marketAvgKRW": 0,
    "marketHighKRW": 0,
    "recommendedEntryKRW": 0,
    "marginScenarios": [
      {"label": "보수", "supplyKRW": 0, "saleKRW": 0, "marginPercent": 0},
      {"label": "표준", "supplyKRW": 0, "saleKRW": 0, "marginPercent": 0},
      {"label": "공격", "supplyKRW": 0, "saleKRW": 0, "marginPercent": 0}
    ],
    "rationale": "가격 전략 근거 1~2줄"
  },
  "operationalRisks": [
    {"severity": "high|mid|low", "title": "짧은 제목", "detail": "구체 리스크 + 대응 액션 1줄"}
  ] (3개, 카테고리 특화),
  "growthLevers": [
    {"lever": "광고/번들/제휴/콘텐츠 등 카테고리", "tactic": "구체 액션 1줄", "expectedImpact": "예상 효과 (예: '객단가 +18%', '노출 +30%')"}
  ] (3개),
  "marketingPlaybook": [
    {"channel": "쿠팡 로켓 / 스마트스토어 / 메타광고 / 인플루언서 / 카카오 등", "tactic": "구체 운영안 1줄", "kpi": "측정 KPI (예: 'ROAS 4.0+', 'CTR 2%+')"}
  ] (3~4개),
  "complementarySKUs": ["연관/번들 후보 카테고리 또는 상품 (예: 'USB-C 허브', '보호 케이스')"] (3~5개),
  "thirtyDayPlan": [
    {"week": "W1", "action": "주차별 액션 1줄 (구체적, 측정가능)"},
    {"week": "W2", "action": "..."},
    {"week": "W3", "action": "..."},
    {"week": "W4", "action": "..."}
  ],
  "watchouts": ["반드시 점검할 체크리스트 항목 (예: '정품 인증 요건', '반품률 모니터')"] (2~3개)
}`;

function summarize(draft: ProductDraft): string {
  return JSON.stringify(
    {
      title: draft.title,
      brand: draft.brand,
      modelName: draft.modelName,
      manufacturer: draft.manufacturer,
      origin: draft.origin,
      price: draft.price,
      currency: draft.currency,
      description: draft.description,
      options: draft.options,
      categoryHints: draft.categoryHints,
      sourceHost: draft.sourceHost,
    },
    null,
    2,
  );
}

export function buildDetailCorePrompt(draft: ProductDraft): string {
  return `${DETAIL_CORE_INSTRUCTION}\n\n[상품 정보]\n${summarize(draft)}\n\n[출력 JSON]:`;
}

export function buildDetailExtrasPrompt(draft: ProductDraft): string {
  return `${DETAIL_EXTRAS_INSTRUCTION}\n\n[상품 정보]\n${summarize(draft)}\n\n[출력 JSON]:`;
}

export function buildInsightPrompt(draft: ProductDraft): string {
  return `${INSIGHT_INSTRUCTION}\n\n[상품 정보]\n${summarize(draft)}\n\n[출력 JSON]:`;
}

// ── Output type definitions ──

export interface DetailReview {
  author: string;
  rating: number;
  title: string;
  body: string;
}

export interface DetailQna {
  q: string;
  a: string;
}

export interface DetailCoreContent {
  heroHeadline?: string;
  heroSubheadline?: string;
  sellingPoints?: string[];
  detailBodyHtml?: string;
  relatedKeywords?: string[];
}

export interface DetailExtrasContent {
  fakeReviews?: DetailReview[];
  fakeQna?: DetailQna[];
}

/** 합쳐진 detail (Core + Extras 병합 결과). 화면 표시용. */
export interface DetailContent extends DetailCoreContent, DetailExtrasContent {}

// ── Insight (MD 관점) ──

export type Verdict = 'go' | 'hold' | 'skip';

export interface InsightMarketReadiness {
  demandSignal: string;
  seasonality: string;
  competition: string;
}

export interface InsightMarginScenario {
  label: string;
  supplyKRW: number;
  saleKRW: number;
  marginPercent: number;
}

export interface InsightPricingStrategy {
  marketLowKRW: number;
  marketAvgKRW: number;
  marketHighKRW: number;
  recommendedEntryKRW: number;
  marginScenarios: InsightMarginScenario[];
  rationale: string;
}

export interface InsightOperationalRisk {
  severity: 'high' | 'mid' | 'low';
  title: string;
  detail: string;
}

export interface InsightGrowthLever {
  lever: string;
  tactic: string;
  expectedImpact: string;
}

export interface InsightMarketingPlay {
  channel: string;
  tactic: string;
  kpi: string;
}

export interface InsightWeekPlan {
  week: string;
  action: string;
}

export interface InsightContent {
  category?: string;
  executiveSummary?: string;
  verdict?: Verdict;
  marketReadiness?: InsightMarketReadiness;
  pricingStrategy?: InsightPricingStrategy;
  operationalRisks?: InsightOperationalRisk[];
  growthLevers?: InsightGrowthLever[];
  marketingPlaybook?: InsightMarketingPlay[];
  complementarySKUs?: string[];
  thirtyDayPlan?: InsightWeekPlan[];
  watchouts?: string[];
}

// ── Comparison (다중 상품 비교 분석) ──

const COMPARISON_INSTRUCTION = `당신은 한국 e커머스 베테랑 MD입니다. 같은(또는 유사한) 상품을 여러 채널에서 캡처한 데이터를 비교해 채널/판매처별 강약점을 진단합니다.

규칙:
- 출력은 오직 단일 JSON 객체. 마크다운/설명 금지.
- 톤: 짧고 단정적. 두루뭉술 X. 숫자/데이터 근거 명시.
- 입력에 있는 정보(가격, 옵션, 브랜드, sourceHost 등)와 sourceHost로부터 추론 가능한 채널 특성(예: lotteon=백화점 신뢰, ehyundai=백화점 프리미엄, coupang=가격/배송, smartstore=중소셀러 다양성, musinsa=패션 큐레이션)을 결합해 분석.
- 각 axis에서 어떤 productIndex가 우세한지 명확히. tie면 leader=-1.
- 모든 수치 추정에는 "추정" 또는 "추정값" 명시.

스키마:
{
  "verdict": "한 줄 결론 (어느 채널이 더 매력? 왜? — 30~60자)",
  "winner": 0 | 1 | 2 | -1 (-1 = 무승부),
  "summary": "2~3 문장 요약 (각 상품의 포지션을 다르게 짚을 것)",
  "axes": [
    {
      "axis": "축 이름 (예: '가격', '신뢰성', '배송', '혜택', '상세 정보 풍부도', '리뷰', '구성/포장', '채널 적합성')",
      "leader": 0 | 1 | 2 | -1,
      "evaluation": "구체 평가 (실제 숫자/근거 인용 — 예: 'A 23,940원 (10%) vs B 25,500원 (5%) — A가 ₩1,560 + 할인폭 우위')"
    }
  ] (정확히 5~6개, 카테고리 적합한 축 선택),
  "perProductSummary": [
    {
      "productIndex": 0,
      "label": "한 줄 라벨 (예: '가격 우위형', '백화점 신뢰형')",
      "strengths": ["...", "...", "..."],
      "weaknesses": ["...", "..."]
    }
  ] (입력 상품 수만큼),
  "actionPoints": ["실행 가능한 의사결정 액션 (3~5개) — 예: '두 채널 동시 입점, 가격 ±200원 차등으로 노출 분산'"]
}`;

export type ComparisonLeader = number; // productIndex 또는 -1 (tie)

export interface ComparisonAxis {
  axis: string;
  leader: ComparisonLeader;
  evaluation: string;
}

export interface ComparisonPerProduct {
  productIndex: number;
  label: string;
  strengths: string[];
  weaknesses: string[];
}

export interface ComparisonContent {
  verdict?: string;
  winner?: ComparisonLeader;
  summary?: string;
  axes?: ComparisonAxis[];
  perProductSummary?: ComparisonPerProduct[];
  actionPoints?: string[];
}

function summarizeForCompare(draft: ProductDraft, index: number): object {
  return {
    index,
    sourceHost: draft.sourceHost,
    title: draft.title,
    brand: draft.brand,
    modelName: draft.modelName,
    manufacturer: draft.manufacturer,
    origin: draft.origin,
    price: draft.price,
    currency: draft.currency,
    description: draft.description,
    options: draft.options,
    categoryHints: draft.categoryHints,
    detailImageCount: draft.detailImageUrls?.length ?? 0,
  };
}

export function buildComparisonPrompt(drafts: ProductDraft[]): string {
  const inputs = drafts.map((d, i) => summarizeForCompare(d, i));
  return `${COMPARISON_INSTRUCTION}\n\n[비교 대상 상품들]\n${JSON.stringify(inputs, null, 2)}\n\n[출력 JSON]:`;
}
