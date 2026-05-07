# TODO — 경쟁사 상품 → x2bee BO 자동 등록 (v1)

상세는 [plan.md](plan.md), 스펙은 [docs/SPEC-product-replicate.md](../docs/SPEC-product-replicate.md).

## S0 — 사이드 메뉴 셸 + 빈 상품 수집함 (1.5h) ✅ 검수 완료
- [x] `MenuDrawer.tsx`
- [x] `menu/items.ts`
- [x] `ProductInbox.tsx`
- [x] `App.tsx` 햄버거+드로어+라우팅
- [x] 빌드 + 사용자 수동 검증

## S1 — ProductDraft 타입 + storage 유틸 + 카드 (1h) ✅ 검수 완료

## CP-A — 데이터 모델 합의 ✅

## S2 — 캡처 버튼 + 휴리스틱 추출 (2h) ✅ 검수 완료

## S3 — AI 추출 보강 (2h) ✅ 검수 완료

## CP-B — 캡처 E2E ✅

## S4 — BO autofill 단순 필드 + Jodit 탐색 (2.5h) ✅ 검수 완료
- 결과: 상품명/모델명/제조사 3개 채움. 원산지는 LLM이 추출 못해 빈 값 → skip(정상).
- Jodit DOM 컨테이너 **3개** 발견 — 단일 에디터 아님. S5에서 "상품상세" 식별 필요.
- 라벨 매칭 fix: MUI Grid2의 `<h6>` 라벨 + `*`/ⓘ child 제외 위해 ownText 매칭으로 변경.

## CP-C — BO autofill 골조 ✅

## S5 — Jodit 정적 주입 (1h) ★ 사용자 검수 대기
- [x] `jodit-injector.ts` — findJoditContainerForLabel + injectJoditHtml (instance → wysiwyg fallback) + plainTextToHtml
- [x] 라벨 매칭으로 "상품상세 내용" 에디터만 타겟 (3개 중 1개 골라냄)
- [x] `bo-autofill/index.ts` — performUpload에서 description 주입 호출
- [x] `shared/types.ts` — joditInjected/joditInjectMethod 필드 추가
- [x] `ProductInbox.tsx` 토스트 — 주입 OK/실패 표시
- [x] `npm run build` 통과
- [ ] BO에서 카드 업로드 → 상세 에디터에 description 표시 + 임시저장 시 정상 직렬화 확인 (사용자)
- 진단으로 확인된 구조: instance 객체는 DOM에 안 붙음 → wysiwyg 경로 메인.

## S3 — AI 추출 보강 (2h)
- [ ] `src/shared/product/prompts.ts` — extraction system prompt
- [ ] `src/shared/product/extractor.ts` — streamChat 호출 + JSON 파싱
- [ ] `service-worker.ts` — 캡처 후 백그라운드 enrich
- [ ] 카드에 status='partial'/'enriched' 인디케이터
- [ ] 실패 시 partial 유지 동작

## CP-B — 캡처 E2E

## S4 — BO autofill 단순 필드 + Jodit 탐색 (2.5h)
- [ ] `src/content/bo-autofill/index.ts` — bo.x2bee.com 호스트 매칭 부트
- [ ] `src/content/bo-autofill/field-map.ts` — DOM 셀렉터 매핑
- [ ] `src/content/bo-autofill/jodit-probe.ts` — Jodit 인스턴스 탐색 + 콘솔 로그
- [ ] `src/content/index.ts` — 호스트별 라우팅
- [ ] `ProductCard.tsx` — "상품 업로드" 버튼
- [ ] `service-worker.ts` — PRODUCT_UPLOAD_REQUEST 라우팅
- [ ] BO 페이지에서 단순 필드 자동 채움 검증

## S5 — Jodit 정적 주입 (1h)
- [ ] `src/content/bo-autofill/jodit-injector.ts`
- [ ] `bo-autofill/index.ts` — description HTML 주입 호출
- [ ] 임시저장 시 정상 직렬화 확인

## CP-C — BO autofill 골조

## S6 — LLM 창작 스트리밍 (3h)
- [ ] `prompts.ts` — creative system prompt (구조화 출력)
- [ ] `bo-autofill/index.ts` — streamChat 청크 누적 + 디바운스 주입
- [ ] SEO 타이틀/설명/키워드 채움
- [ ] abort 처리

## S7 — 검색 필드 추천 툴팁 (1.5h)
- [ ] `src/content/bo-autofill/search-tooltip.tsx`
- [ ] 협력사·카테고리·브랜드 인풋 옆 마운트
- [ ] 복사 버튼 + 사용자 입력 시 숨김

## CP-D — v1 완성, 데모 가능

---

## 작업 외 메모
- 새 백엔드 엔드포인트 신설 X (streamChat 재사용)
- manifest 권한 추가 X (현재 `<all_urls>` content_scripts 활용)
- BO "등록" 버튼 자동 클릭 X (반드시 사람이 누름)
- 사용자 토큰 익스텐션 외부 전송 X
