# v1 SPEC — 경쟁사 상품 → x2bee BO 자동 등록

## 목적
경쟁사 상품 상세 페이지에서 정보를 캡처해 메모리에 적재하고, x2bee BO 상품등록 폼을 한 번에 자동 채움(LLM 창작 포함). 상품 도메인 wow 데모.

## 사용자
x2bee BO 운영자(상품 등록 담당). 매번 경쟁사 상품을 손으로 옮겨 등록하는 부담을 1/N로 줄이는 것이 목표.

## v1 스코프

### In
1. **사이드 메뉴 셸** — 헤더 햄버거 → 좌측 슬라이드 드로어 (`MenuDrawer`). 메뉴 항목 1개("상품 수집함")부터 시작.
2. **데이터 모델** — `src/shared/product/` 신규 폴더, `ProductDraft` 타입 + 추출/저장 유틸.
3. **상품 수집함 패널** — 캡처 시작/중지, 카드 목록 표시, 삭제, `chrome.storage.session` 영속.
4. **AI 추출** — 캡처된 API 응답 + DOM 스니펫 → `ProductDraft` 정규화. 기존 `streamChat()` 재사용(새 system prompt).
5. **BO 폼 자동 채움** — content script가 BO 페이지에 마운트, 단순 필드 즉시 채움 + Jodit 에디터 HTML 주입.
6. **LLM 창작 채움** — 상품상세/SEO 타이틀·설명·키워드를 스트리밍으로 폼에 흘려넣기. 톤: 일반적(정보 정리 + 셀링포인트 bullet).
7. **검색 필드 추천 툴팁** — 협력사·표준카테고리·브랜드 필드 위에 AI 추천 텍스트 + 복사 버튼.

### Out (v2 이상)
- 기존 헤더 버튼들의 메뉴 이주(점진)
- pathfinder Chip 자동 트리거
- BO 검색 API 직접 호출로 자동 선택
- 대표이미지 자동 업로드 (URL→blob→drop)
- 일괄 등록 큐
- 브랜드 톤 학습

## 아키텍처

```
[경쟁사 상품 상세 페이지]
   사이드패널 햄버거 → "상품 수집함" → "이 페이지 캡처"
   ├─ content script: 활성 캡처에서 API 응답 모음 + DOM 보조 추출
   ├─ background SW: streamChat 호출 → ProductDraft JSON 정규화
   └─ chrome.storage.session: products[] (브라우저 세션 영속)

[x2bee BO 상품등록 페이지 (bo.x2bee.com/.../general-goods-reg/)]
   사이드패널 → "상품 수집함" → 카드 선택 → "상품 업로드"
   ├─ content script: BO 폼 단순 필드 즉시 채움
   ├─ background SW: streamChat 스트리밍 (상세 HTML, SEO 묶음)
   ├─ content script: Jodit `editor.value` 누적 주입(디바운스 100ms)
   └─ 검색 필드(협력사/카테고리/브랜드) 위 추천 툴팁 마운트
```

## 핵심 파일

| 영역 | 파일 |
|---|---|
| 타입·추출 | `src/shared/product/types.ts`, `src/shared/product/extractor.ts`, `src/shared/product/storage.ts`, `src/shared/product/prompts.ts` |
| 사이드 메뉴 | `src/sidepanel/components/MenuDrawer.tsx`, `src/sidepanel/menu/items.ts` |
| 상품 수집함 | `src/sidepanel/components/ProductInbox.tsx` |
| BO 자동 채움 | `src/content/bo-autofill/index.ts`, `field-map.ts`, `jodit-injector.ts`, `search-tooltip.tsx` |
| 메시지 타입 | `src/shared/types.ts`에 `PRODUCT_CAPTURE_*`, `PRODUCT_UPLOAD_*` 추가 |
| 매니페스트 | `manifest.json` content_scripts에 BO 호스트 매칭 추가 |

## 결정된 사항
- **LLM 경로**: 기존 `streamChat()` 재사용 (`/api/chat`). 추출용·창작용 system prompt 분리.
- **저장소**: `chrome.storage.session` (브라우저 종료 시 비움 — v1 충분).
- **사이드 메뉴**: 햄버거 → 좌측 슬라이드 드로어. 기존 헤더 버튼은 유지(점진 이주는 v2).
- **톤**: 일반적, 정보 정리 + 셀링포인트 bullet.
- **검색 필드**: 자동 선택 안 함. AI 추천 툴팁만 노출, 사용자가 클릭/검색.

## 수용 기준
- [ ] 햄버거 클릭 → 좌측 드로어 슬라이드인, "상품 수집함" 메뉴 노출
- [ ] 경쟁사 상품 페이지에서 "이 페이지 캡처" → 10초 내 카드 1개 추가, 상품명·가격·썸네일·추출 시각 표시
- [ ] 카드 삭제 동작
- [ ] 새로고침/탭 닫고 다시 열기 → 같은 브라우저 세션 동안 카드 유지
- [ ] BO 상품등록 페이지 진입 → 사이드패널의 카드에서 "상품 업로드" → 단순 필드 1초 내 채움
- [ ] 상품상세 Jodit 에디터에 LLM 결과가 **스트리밍으로** 흘러들어감(정적 갱신 X)
- [ ] 협력사·표준카테고리·브랜드 필드 위에 AI 추천 툴팁 + 복사 버튼

## 미정 (구현하면서 결정)
- 경쟁사 사이트별 DOM 추출 휴리스틱 — 1차는 쿠팡 베이스, JSON-LD/OG 메타 우선
- BO 폼 셀렉터 매핑 테이블 — 실제 페이지 DOM 검사 후 한 번에 작성
- Jodit 인스턴스 접근 경로 (`window.Jodit.instances` vs textarea sibling 탐색)
- AI 추출 프롬프트 정확도 — 쿠팡 1상품으로 베이스라인 잡고 반복

## 경계
- **항상 한다**: BO 폼 검증 로직 그대로 활용(검수는 사람), `streamChat` 재사용, `chrome.storage.session` 사용.
- **먼저 묻는다**: 새 백엔드 엔드포인트 신설, manifest 권한 추가, 기존 헤더 버튼 제거/이동.
- **하지 않는다**: BO 검색 API 임의 호출, 사용자 인증 토큰을 익스텐션 외부로 전송, BO 페이지 등록 버튼 자동 클릭(반드시 사람이 누름).
