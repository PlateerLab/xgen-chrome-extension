import type { ProductDraft } from './types';

export const EXTRACTION_INSTRUCTION = `당신은 상품 정보 추출기입니다. 입력으로 1차 휴리스틱 결과와 페이지 텍스트가 주어집니다.

규칙:
- 출력은 오직 단일 JSON 객체. 마크다운 코드펜스(\`\`\`)나 설명 텍스트 금지.
- 페이지에 명확한 근거가 있는 정보만 채우세요. 추측 금지.
- 누락된 필드는 빈 문자열 "" 또는 빈 배열 [] 로.
- 휴리스틱 결과가 명백히 부정확하면 덮어쓰세요. 일치하면 그대로 두세요.

스키마:
{
  "title": "상품명. 상점명/광고 문구는 제거하고 핵심 상품명만",
  "description": "상품 핵심 특징 1-2문장 한국어 plain text 요약",
  "brand": "브랜드명",
  "modelName": "모델명",
  "manufacturer": "제조사",
  "origin": "원산지",
  "options": [{"name": "옵션 종류명 (예: 색상, 사이즈)", "values": ["옵션 값 배열"]}],
  "categoryHints": ["추정 표준카테고리 키워드 1-3개 (예: 의류 > 여성 > 블라우스)"]
}`;

export function buildExtractionUserMessage(
  draft: ProductDraft,
  pageSnippet: string,
): string {
  const heuristic = JSON.stringify(
    {
      title: draft.title,
      price: draft.price,
      currency: draft.currency,
      brand: draft.brand,
      modelName: draft.modelName,
      manufacturer: draft.manufacturer,
      description: draft.description,
      sourceHost: draft.sourceHost,
    },
    null,
    2,
  );

  return `${EXTRACTION_INSTRUCTION}

[휴리스틱 결과]
${heuristic}

[페이지 텍스트]
${pageSnippet}

[출력 JSON]:`;
}
