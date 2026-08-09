# Pathfinder Hardening TODO

기준일: 2026-08-05
기준 소스: `main@cfe816a` (`origin/main`과 동일)

이 문서는 코드 점검에서 확인된 보안, 실행 정확성, Manifest V3 생명주기 및
유지보수성 개선을 실제 머지 가능한 작업으로 나눈 실행 계획이다. 현재 우선순위와
상태의 단일 기준은 [`docs/ROADMAP.md`](../docs/ROADMAP.md)이며, 이 문서는
`P0-H` 트랙의 상세 TODO다.

## 목표와 원칙

- 캡처 원문, 인증 토큰 및 Cookie 값을 로그나 Tool 정의에 남기지 않는다.
- 정상적인 다단계 plan binding을 사용자 입력 누락으로 판정하지 않는다.
- 한 번에 하나의 캡처 세션만 명시적인 상태 전이로 관리한다.
- Service Worker 재시작을 정상 상황으로 취급하되, raw request/response body를
  복구 목적으로 `chrome.storage.local/session`에 영속화하지 않는다.
- 대상 페이지에서 들어오는 DOM, CustomEvent 및 API capture를 신뢰하지 않는다.
- 각 수정은 정적 fixture와 실제 Chromium runtime 회귀 검증을 함께 추가한다.

## 권장 구현 순서

```text
H0 기준 fixture
 ├─ H1 비밀정보·legacy 등록 경로 차단
 └─ H2 plan binding 정확성
       ↓
H3 캡처 신뢰 경계·URL·body 상한
       ↓
H4 캡처 세션 상태 머신·MV3 재시작
       ↓
H5 탭별 context·실행 인증 최소 권한
       ↓
H6 SSE/취소·모듈 분리·의존성 갱신
```

`H1`과 `H2`는 독립적으로 진행할 수 있다. `H4`는 캡처 입력의 검증 규칙이 정해진
뒤 진행하며, 의존성 갱신은 기능 수정과 분리한다.

## H0. 회귀 기준 고정

우선순위: `P0`
크기: `S`

- [ ] 현재 결함을 재현하는 synthetic fixture를 먼저 추가한다.
  - [x] 정상 binding `${s1.body.id}`를 포함한 다단계 plan
  - [x] password/token/PII 필드를 포함한 캡처 body
  - [x] 잘못된 타입, 과대 body 및 비정상 URL을 가진 `API_CAPTURED`
  - [ ] 탭 A/B가 교차해 `PAGE_COMMAND_RESULT`를 보내는 시나리오
- [x] fixture 문자열은 실제 credential과 구분되는 synthetic marker만 사용한다.
- [x] 추가된 검증을 `npm run verify:pathfinder`에 포함한다.

완료 gate:

- 수정 전에는 의도한 assertion이 실패하고 수정 후 통과한다.
- 실패 artifact와 console log에 synthetic secret 원문이 남지 않는다.

## H1. 비밀정보 노출과 legacy Tool 등록 경로 차단

우선순위: `P0 / release blocker`
크기: `M`

대상:

- `src/sidepanel/hooks/useChat.ts`
- `src/background/service-worker.ts`
- `src/sidepanel/components/ElementPickerButton.tsx`
- `src/sidepanel/lib/trace-registration.ts`

TODO:

- [x] `GET_CHAT_CONFIG` 전체 응답 로그를 제거하고 `hasToken`, origin, stage 같은
  허용 필드만 기록한다.
- [x] `RELAY_COMMAND`, `plan`, `args_resolved` 등 사용자 값이 포함될 수 있는 객체
  전체 로그를 제거하거나 구조적 요약으로 바꾼다.
- [x] safe logging contract fixture를 추가해 운영 bundle에서 payload 객체 전체를
  기록하는 회귀를 차단한다.
- [x] `register_tool`의 `static_body = captured request body` 경로를 제거한다.
- [x] 요소 선택 등록도 값 없는 schema 변환과 크기 제한을 거치게 하거나
  안전한 Collection 등록 API로 통합한다.
- [x] `get_captured_apis` 결과에서 raw request/response preview를 제거하고 method,
  templated path, field path/type 및 redaction 상태만 반환한다.
- [x] 사용자가 명시적으로 확정하지 않은 captured literal을 `static_body`에 저장하지
  않는다.
- [x] legacy `/api/tools/storage/save`가 계속 필요하면 deprecated 상태와 제거 시점을
  문서화하고, sanitizer를 우회할 수 없게 한다.

완료 gate:

- synthetic password, bearer token, email 및 긴 숫자가 console, command result,
  `/api/tools/storage/save` 요청 body에 존재하지 않는다.
- 요소 선택 등록과 Capture Session 등록이 동일한 privacy invariant를 만족한다.
- T0 sanitizer fixture와 T1 등록 runtime이 통과한다.

## H2. 다단계 plan binding 판정 수정

우선순위: `P0 / correctness`
크기: `S`

대상:

- `src/sidepanel/hooks/useChat.ts`

TODO:

- [x] `null`, `undefined`, 빈 문자열과 정상 binding expression의 판정을 분리한다.
- [x] `${s1.body.id}` 같은 이전 step binding은 누락값이 아닌 실행 시 해석될 값으로
  통과시킨다.
- [x] `{key}` 형식이 실제 누락 placeholder인지 backend binding인지 contract로
  확정한 뒤 판정한다.
- [x] 실제 빈 literal 필드만 사용자 질문으로 전환한다.
- [x] 중첩 object/array, 숫자 `0`, boolean `false` 및 빈 배열의 기대 동작을 fixture로
  고정한다.
- [x] helper를 독립 모듈로 옮겨 React hook 없이 단위 검증할 수 있게 한다.

완료 gate:

- 다단계 create → detail plan이 추가 질문 없이 실행된다.
- 실제 필수 인자가 비어 있는 plan은 기존 popup 복구 흐름을 유지한다.
- binding/누락 판정 fixture가 T0에서 통과한다.

## H3. 캡처 입력 신뢰 경계와 자원 상한 강화

우선순위: `P0`
크기: `L`

대상:

- `src/content/api-hook/main-world-hook.ts`
- `src/content/api-hook/relay.ts`
- `src/background/service-worker.ts`
- `src/shared/api-hook-types.ts`

TODO:

- [x] Service Worker 진입점에서 `CapturedApi` runtime validator를 적용한다.
- [x] method, URL protocol, timestamp, status, duration, header/body 타입과 최대 크기를
  검증하고 알 수 없는 필드는 폐기한다.
- [x] relay에서 받은 객체를 그대로 변형하지 않고 bounded normalized object로
  새로 생성한다.
- [x] `fetch`와 XHR 상대 URL을 `new URL(rawUrl, document.baseURI)`로 해석한다.
- [x] `//host/path`, `<base href>`, query-only URL 및 malformed URL fixture를 추가한다.
- [x] `Response.clone().text()`로 전체 body를 읽은 뒤 자르는 방식을 제한된 stream
  reader로 교체한다.
- [x] `Content-Length`가 상한을 넘거나 binary/streaming 응답이면 body를 읽지 않고
  limitation metadata만 기록한다.
- [x] 대상 페이지가 `xgen:api-captured` CustomEvent를 위조할 수 있음을 provenance에
  표시하고, 사용자 검토 전 자동 등록·실행하지 않는다.
- [x] malformed/oversized event가 캡처 세션이나 Service Worker listener를 중단시키지
  않는 runtime test를 추가한다.

완료 gate:

- 상대 URL이 브라우저 fetch 해석 결과와 동일하다.
- 단일 capture가 정해진 메모리·문자열 상한을 넘지 않는다.
- 위조·비정상 이벤트는 구조화된 reason으로 폐기되고 정상 capture는 계속된다.

## H4. 캡처 세션 상태 머신과 MV3 생명주기

우선순위: `P1`
크기: `L`

대상:

- `src/background/service-worker.ts`
- `src/sidepanel/hooks/useCaptureSession.ts`
- `scripts/verify-runtime.mjs`

TODO:

- [ ] 전역 nullable 상태를 `idle → starting → active → stopping → completed/interrupted`
  상태 머신으로 교체한다.
- [ ] session ID와 tab ID를 start/stop/status/result 메시지에 포함한다.
- [ ] start/stop을 직렬화해 빠른 더블 클릭과 탭 A/B 동시 시작을 막는다.
- [ ] 새 세션 시작 전 이전 탭의 main-world hook, relay, overlay, frame state 및 raw
  buffer를 모두 정리한다.
- [ ] STOP 응답의 `bufferedCount`를 삭제 전에 계산하거나 의미 없는 필드를 제거한다.
- [ ] 완료 결과에 result ID와 acknowledgement를 추가해 broadcast/query 중복 노출을
  막는다.
- [ ] `chrome.storage.session`에는 session ID, tab ID, 시작 시각 및 interrupted marker
  같은 비민감 메타데이터만 저장한다.
- [ ] Service Worker 재시작 시 active metadata가 남아 있으면 세션을 조용히 유실하지
  않고 `interrupted`로 종료하며 hook/buffer cleanup을 수행한다.
- [ ] raw request/response body는 MV3 복구 목적으로 storage에 저장하지 않는다.
- [ ] runtime test에서 캡처 중 Service Worker를 종료·재시작한 뒤 상태와 cleanup을
  검증한다.

완료 gate:

- 동시에 active인 캡처 세션은 항상 1개다.
- 탭 전환, 더블 클릭, 탭 종료, 권한 회수 및 Service Worker 재시작 후 stale hook과
  raw buffer가 남지 않는다.
- 결과는 정확히 한 번 UI에 노출된다.

## H5. 탭별 context와 실행 인증 최소 권한

우선순위: `P1`
크기: `M`

대상:

- `src/background/service-worker.ts`
- `src/sidepanel/hooks/useChat.ts`
- `src/shared/types.ts`

TODO:

- [ ] 단일 `cachedPageContext`를 `Map<tabId, PageContext>` 또는 동등한 탭별 cache로
  교체한다.
- [ ] `PAGE_COMMAND_RESULT`와 `CANVAS_RESULT`가 sender tab의 context만 갱신하도록
  한다.
- [ ] `GET_CHAT_CONFIG` fallback은 요청한 tab의 cache만 사용하며 다른 탭 context를
  반환하지 않는다.
- [ ] 탭 제거·권한 회수 시 해당 context cache를 정리한다.
- [ ] `GET_LIVE_COOKIES`의 `host`와 `url`을 하나의 검증된 URL에서 파생한다.
- [ ] Collection auth contract가 Cookie 인증을 요구하고 사용자가 연결한 경우에만
  live cookie를 전송한다.
- [ ] 현재 페이지 host와 실제 Tool endpoint/auth service host가 다를 때 사용할
  명시적 정책과 사용자 표시를 정의한다.
- [ ] 서로 다른 두 탭의 context/result/cookie가 섞이지 않는 T1 fixture를 추가한다.

완료 gate:

- 탭 A의 page/canvas result가 탭 B의 chat context에 나타나지 않는다.
- Cookie 미사용 Collection run에는 `live_cookies` 필드가 존재하지 않는다.
- 권한 없는 host 또는 host/url 불일치 요청은 구조화된 오류로 거절한다.

## H6. 스트리밍 복구성과 유지보수 구조

우선순위: `P2`
크기: `M–L`

TODO:

- [ ] `streamChat`, `streamCollectionRun`, `streamGreet`의 중복 SSE 파서를 공통 모듈로
  통합한다.
- [ ] 표준 `data:` 형식, 여러 data line, CRLF, 마지막 buffer flush와 `[DONE]` 처리를
  검증한다.
- [ ] malformed JSON을 조용히 버리지 않고 bounded diagnostic 또는 stream error로
  전달한다.
- [ ] 스트리밍 중 대화 초기화를 누르면 먼저 AbortController를 취소하고 이전 stream이
  UI를 다시 채우지 못하게 generation ID를 적용한다.
- [ ] `service-worker.ts`를 capture/session, auth, page-command, collection-registration
  모듈로 분리한다.
- [ ] message payload의 `any` cast를 줄이고 action별 validator를 둔다.
- [ ] ESLint와 작은 단위 test runner 도입 여부를 별도 PR로 결정한다.
- [ ] `@page-agent/page-controller` 1.6.2 → 1.12.2 호환성을 별도 PR에서 검증한다.
- [ ] dependency 갱신 후 `eval` 경고, bundle size 및 Page Agent 동작 변화를 기록한다.

완료 gate:

- SSE parser fixture와 abort/clear runtime test가 통과한다.
- Service Worker 분리 전후 메시지 및 endpoint contract가 동일하다.
- dependency PR은 기능 PR과 분리되고 T0/T1 전체가 통과한다.

## PR 단위 제안

| PR | 범위 | 필수 검증 |
|---|---|---|
| 1 | H0 + H1 safe logging/legacy 등록 차단 | T0 sanitizer + T1 요소 등록 |
| 2 | H2 plan binding 판정 | T0 plan fixture + T1 collection run |
| 3 | H3 capture validator/URL/bounded body | T0 capture corpus + T1 fetch/XHR |
| 4 | H4 session state machine/MV3 restart | T1 capture lifecycle |
| 5 | H5 tab context/cookie 최소 권한 | T1 multi-tab + T2 read-only run |
| 6 | H6 SSE/abort/모듈 분리 | T0/T1 전체 |
| 7 | dependency 전용 갱신 | build + T0/T1 + bundle 비교 |

## 공통 완료 조건

모든 PR:

```bash
npm run build
npm run verify:pathfinder
npm audit
```

XGEN 계약이나 Collection 실행이 바뀌는 PR:

```bash
PATHFINDER_XGEN_RUN_COLLECTION_FLOW=1 npm run verify:xgen-dev
```

- [ ] 문서와 코드의 privacy invariant가 일치한다.
- [ ] 실제 credential, 고객 데이터 및 persistent browser profile을 fixture/artifact에
  사용하지 않는다.
- [ ] 새 error path는 silent failure가 아니라 사용자 또는 진단 가능한 reason code를
  남긴다.
- [ ] `main` 반영 후 `docs/ROADMAP.md` 상태를 같은 PR에서 갱신한다.
