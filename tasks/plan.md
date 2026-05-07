# PLAN — 경쟁사 상품 → x2bee BO 자동 등록 (v1)

스펙: [docs/SPEC-product-replicate.md](../docs/SPEC-product-replicate.md)

## 의존성 그래프

```
S0 사이드 메뉴 셸 + 빈 수집함 패널
   ↓
S1 ProductDraft 타입 + storage 유틸 + 카드 렌더
   ↓                                          ↘
S2 캡처 버튼 + 휴리스틱 추출(AI 없이)            S4 BO autofill 단순필드 + Jodit 탐색
   ↓                                            ↓                           ↓
S3 AI 추출(streamChat) — 카드 보강               S5 Jodit 정적 주입 (임시 HTML)
                                                ↓
                                           S6 LLM 창작 스트리밍 (상세/SEO)
                                                ↓
                                           S7 검색 필드 추천 툴팁
```

S2와 S4는 독립적이라 병렬 가능. 다만 S6에서 ProductDraft를 입력으로 쓰려면 S3이 끝나있는 게 안정적.

## 수직 슬라이스

각 슬라이스는 단독 머지 가능 + 수동 검증 가능 + 1~3시간.

### S0 — 사이드 메뉴 셸 + 빈 상품 수집함 (1.5h) ★ 첫 슬라이스

**파일**
- 신규: `src/sidepanel/components/MenuDrawer.tsx`
- 신규: `src/sidepanel/components/ProductInbox.tsx` (빈 상태)
- 신규: `src/sidepanel/menu/items.ts`
- 수정: `src/sidepanel/App.tsx` (햄버거 아이콘, 드로어 마운트, 패널 라우팅)

**범위**
- 햄버거 아이콘 헤더 좌측에 추가 (기존 버튼들 옆)
- `MenuDrawer`: 좌측에서 슬라이드인, dim 오버레이, 클릭 외부/Esc로 닫힘
- 메뉴 항목 1개("📦 상품 수집함") → 클릭 시 `ProductInbox` 패널로 본문 전환
- 빈 상태: "아직 캡처된 상품이 없습니다. 경쟁사 상품 페이지에서 캡처하세요."
- 본문에 "← 채팅으로" 같은 복귀 버튼

**수용 기준**
- [ ] 익스텐션 빌드 성공, 사이드패널 정상 렌더
- [ ] 햄버거 클릭 → 좌측 드로어 슬라이드인 (Tailwind transition)
- [ ] 외부 클릭/Esc로 닫힘
- [ ] "상품 수집함" 클릭 → 본문이 ProductInbox로 전환
- [ ] 빈 상태 메시지 표시
- [ ] "채팅으로" 버튼 → 기존 채팅 화면 복귀

**검증** (수동)
1. `npm run build` → dist/ 갱신 → 익스텐션 reload
2. 임의 페이지에서 사이드패널 열기 → 햄버거 클릭 → 드로어 확인
3. "상품 수집함" 클릭 → 빈 패널 확인 → 복귀

---

### S1 — ProductDraft 타입 + storage 유틸 + 카드 렌더 (1h)

**파일**
- 신규: `src/shared/product/types.ts`
- 신규: `src/shared/product/storage.ts`
- 신규: `src/sidepanel/components/ProductCard.tsx`
- 수정: `ProductInbox.tsx` (storage 구독 + 카드 목록)

**범위**
- `ProductDraft`: id, sourceUrl, title, price, currency, thumbnailUrl, description, options[], capturedAt, status('partial'|'enriched'), aiNotes
- `storage.ts`: `listProducts()`, `addProduct()`, `removeProduct()`, `updateProduct()`, `subscribe()`
- `chrome.storage.session` 키: `xgen.products.v1`
- 카드: 썸네일(48px) + 제목(2줄 truncate) + 가격 + 캡처 시각 + 삭제(X)

**수용 기준**
- [ ] storage CRUD 동작 (DevTools console에서 직접 호출 검증 가능)
- [ ] 카드 추가/삭제 시 ProductInbox 즉시 갱신 (subscribe 패턴)
- [ ] 새로고침 후에도 카드 유지 (session storage)
- [ ] 빈 목록일 때 빈 상태 표시

**검증** (수동)
1. DevTools console:
   ```js
   chrome.storage.session.set({ 'xgen.products.v1': [{ id:'t1', title:'테스트', price:1000, ... }] })
   ```
2. ProductInbox에 카드 표시 확인 → 삭제 → 빈 상태로 전환
3. 새로고침 → 카드 유지(있으면)

---

### S2 — 캡처 버튼 + 휴리스틱 추출 (AI 없이) (2h)

**파일**
- 수정: `ProductInbox.tsx` (헤더에 "이 페이지 캡처" 버튼)
- 신규: `src/content/product-extractor/heuristic.ts` (JSON-LD, OG 메타, microdata)
- 수정: `src/content/index.ts` (PRODUCT_CAPTURE_REQUEST 핸들러 추가)
- 수정: `src/shared/types.ts` (`PRODUCT_CAPTURE_REQUEST`/`_RESPONSE` 메시지)
- 수정: `src/background/service-worker.ts` (요청 라우팅)

**범위**
- 패널 헤더 버튼 → SW에 `PRODUCT_CAPTURE_REQUEST{tabId}` → SW가 content script로 포워딩
- 휴리스틱: `<script type="application/ld+json">` Product 스키마 우선 → OG 메타(`og:title`, `og:image`, `product:price:amount`) → fallback DOM 휴리스틱(h1, .price)
- 추출 결과 → SW → storage.session에 add
- 카드 status='partial'

**수용 기준**
- [ ] 쿠팡 상품 상세에서 캡처 → 카드에 제목/이미지/가격 표시
- [ ] JSON-LD 없는 페이지에서도 OG 메타로 최소 1개 필드 채워짐
- [ ] 추출 실패 시 사용자에게 토스트 (조용히 실패하지 않음)

**검증** (수동)
1. 쿠팡/네이버스마트스토어/11번가 각 1개 상품 페이지에서 캡처
2. 카드 표시 확인. 누락 필드는 비워둠

---

### S3 — AI 추출 (streamChat 재사용) — 카드 보강 (2h)

**파일**
- 신규: `src/shared/product/prompts.ts` (extraction system prompt)
- 신규: `src/shared/product/extractor.ts` (휴리스틱+페이지스니펫 → AI 호출 → ProductDraft 보강)
- 수정: `src/background/service-worker.ts` (캡처 후 백그라운드 enrich)

**범위**
- 캡처 직후 휴리스틱 결과(status='partial')로 카드 즉시 추가
- 백그라운드에서 streamChat 호출(JSON 모드) → 응답 파싱 → updateProduct(status='enriched')
- 입력: 휴리스틱 결과 + 페이지의 trimmed HTML 섹션 (head meta + main 영역)
- 출력 스키마: ProductDraft 필드들 + AI 추정 신뢰도 노트

**수용 기준**
- [ ] 캡처 즉시 카드 표시(partial), 5~15초 내 'enriched'로 갱신
- [ ] 카드에 'AI 보강 중...' 인디케이터(스피너) → 완료 시 사라짐
- [ ] AI 호출 실패해도 partial 카드는 유지 (fallback)

**검증** (수동)
1. 쿠팡 상품 캡처 → 휴리스틱 카드 즉시 표시
2. 잠시 후 제목/설명이 더 풍부해지는지 확인 (또는 status 변경)

---

### S4 — BO autofill 단순 필드 + Jodit 인스턴스 탐색 (2.5h)

**파일**
- 신규: `src/content/bo-autofill/index.ts` (호스트 매칭 시 부트)
- 신규: `src/content/bo-autofill/field-map.ts` (ProductDraft → DOM 셀렉터)
- 신규: `src/content/bo-autofill/jodit-probe.ts` (Jodit 탐색 + 로그)
- 수정: `src/content/index.ts` (호스트가 BO면 bo-autofill 부트)
- 수정: `ProductCard.tsx` ("상품 업로드" 버튼)
- 수정: `service-worker.ts` (PRODUCT_UPLOAD_REQUEST → BO 탭으로 forward)

**범위**
- 호스트 `bo.x2bee.com` 매칭 시 bo-autofill 모듈 활성
- 카드의 "상품 업로드" 클릭 → SW → BO 탭 content script → field-map 따라 input.value + dispatchEvent('input')
- 매핑 대상: 상품명, 모델명, 제조사, 원산지, 판매가(있으면), 검색키워드 사용 라디오 등
- Jodit 인스턴스 탐색: `window.Jodit?.instances`, `document.querySelector('.jodit-react-container')`, textarea sibling 탐색 — 셋 다 시도하고 콘솔에 로그 ("[bo-autofill] jodit found via X")

**수용 기준**
- [ ] BO 상품등록 페이지에서 카드 업로드 → 단순 텍스트 필드 1초 내 채워짐
- [ ] React controlled input도 정상 반영 (input event dispatch 확인)
- [ ] Jodit 탐색 결과가 콘솔에 로그됨 (값 주입은 S5에서)
- [ ] BO가 아닌 페이지에서는 bo-autofill 부트되지 않음

**검증** (수동)
1. BO 상품등록 페이지(general-goods-reg) 열기
2. 사이드패널에서 카드의 "상품 업로드" 클릭
3. 필드 채워짐 확인, DevTools 콘솔에서 jodit 탐색 로그 확인

---

### S5 — Jodit 정적 주입 (1h)

**파일**
- 신규: `src/content/bo-autofill/jodit-injector.ts`
- 수정: `bo-autofill/index.ts` (S4에서 받은 ProductDraft.description으로 Jodit에 한방 주입)

**범위**
- 탐색된 Jodit 인스턴스에 `editor.value = html` 또는 textarea + `dispatchEvent('input')`
- 안되면 ContentEditable div에 innerHTML 직접 + Jodit refresh
- 주입 후 검증: 에디터에 표시되는지 DOM 체크

**수용 기준**
- [ ] 카드 업로드하면 상세 에디터에 ProductDraft.description이 표시됨
- [ ] 폼 저장(임시저장) 시 정상 직렬화 (Jodit이 인지하는 상태로 들어감)

**검증** (수동)
1. 카드에 description="<p>테스트 상세입니다</p>" 가짜 데이터로 업로드
2. 상세 에디터에 표시되는지 확인

---

### S6 — LLM 창작 스트리밍 (상세 + SEO) (3h)

**파일**
- 수정: `src/shared/product/prompts.ts` (creative system prompt: 톤=일반, JSON 묶음 스트리밍 출력 — chunks of `{detailHtml, seoTitle, seoDescription, seoKeywords, categoryHints}`)
- 수정: `bo-autofill/index.ts` (업로드 시 streamChat → 청크 누적 → debounced jodit 주입 + SEO input 채움)

**범위**
- 업로드 동작이 두 단계: (1) 단순 필드 즉시 (2) LLM 호출하며 상세/SEO를 스트리밍으로 흘려넣기
- Jodit 주입: 누적 HTML을 100ms debounce로 `editor.value` 갱신
- SEO 타이틀/설명/키워드: 응답이 끝까지 모이면 한 번에 채움
- 호출 위치: content script가 SW에 PRODUCT_GENERATE 요청 → SW가 streamChat → 청크를 SSE처럼 content script로 다시 push
- 톤: 일반 (정보 정리 + 셀링포인트 bullet 3~5개)

**수용 기준**
- [ ] 업로드 클릭 → 단순 필드 채워진 후 상세 에디터에 텍스트가 흘러들어가는 게 시각적으로 보임
- [ ] SEO 타이틀/설명/키워드 채워짐
- [ ] 중간에 사용자가 페이지 이동/탭 닫음 → 깔끔히 abort

**검증** (수동)
1. BO 페이지에서 업로드 → 5~15초간 상세 에디터에 글이 흘러들어감
2. SEO 필드 채워짐 확인
3. 등록은 사용자가 검수 후 직접 클릭 (자동 클릭 X)

---

### S7 — 검색 필드 추천 툴팁 (1.5h)

**파일**
- 신규: `src/content/bo-autofill/search-tooltip.tsx`
- 수정: `bo-autofill/index.ts` (협력사·표준카테고리·브랜드 인풋 옆 툴팁 마운트)

**범위**
- BO autofill 부트 시 협력사·표준카테고리·브랜드 검색 인풋 위에 floating 툴팁 마운트
- 툴팁 내용: AI가 추천한 키워드 1줄 + "복사" 버튼 (S6 응답의 categoryHints 등 활용)
- 사용자가 복사 → 검색창에 붙여넣고 → 결과 클릭(직접)
- 인풋 변경 시 툴팁 갱신/숨김

**수용 기준**
- [ ] 협력사/표준카테고리/브랜드 인풋 위에 작은 보라색 툴팁 떠있음
- [ ] "복사" 클릭 → 클립보드에 추천값 들어감
- [ ] 인풋에 사용자가 직접 입력 시 툴팁 사라짐 (방해 안 됨)

**검증** (수동)
1. BO 페이지 업로드 후 위 3개 필드 위에 툴팁 확인
2. 복사 버튼 → 클립보드 확인 → 검색창 paste → 결과 선택 흐름

---

## 체크포인트

- **CP-A (S1 후)**: 데이터 모델 + 저장 동작. ProductDraft 형태가 굳어지는 시점.
- **CP-B (S3 후)**: 경쟁사 페이지에서 캡처 → AI 보강된 카드 까지 E2E. 데모 상반부 완성.
- **CP-C (S5 후)**: BO autofill 기본 골격 동작. 데모 하반부 골조.
- **CP-D (S7 후)**: v1 완성. 데모 가능.

각 체크포인트에서 사용자 검수 → 다음 슬라이스 진행.

## 리스크 / 미정

- **R1 — Jodit 인스턴스 접근**: BO가 사용 중인 Jodit 버전/마운트 방식이 명확하지 않음. S4의 probe 결과로 결정. 최악의 경우 S5에서 textarea 직접 조작 + Jodit refresh 우회.
- **R2 — BO 단일 페이지 SPA 라우팅**: 페이지 이동 시 content script가 다시 마운트 안 될 수 있음. URL 변경 감지(MutationObserver or chrome.webNavigation) 필요할 수 있음. S4에서 확인.
- **R3 — BO 폼이 React Hook Form/MobX/Vue 등 상태 라이브러리 사용**: 단순 `value` set + input dispatch로 안 먹을 수 있음. S4 검증에서 발견되면 native setter 우회 패턴 적용.
- **R4 — chrome.storage.session 5MB 제한**: 카드 100개 + 이미지 URL 정도면 안전. 이미지 데이터 자체는 저장 안 함.
- **R5 — LLM 응답 JSON 파싱 실패**: 스트리밍 중간 청크가 깨질 수 있어, 청크별 JSON 파싱이 아닌 누적 후 마지막에 한 번 시도. detailHtml은 상대적으로 안전한 텍스트 청크로 분리.
