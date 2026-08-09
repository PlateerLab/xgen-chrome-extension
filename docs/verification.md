# Verification

## 목표

Chrome Extension은 일반 웹 앱과 달리 Service Worker, Content Script, main-world script, Side Panel 및 대상 페이지가 서로 다른 실행 컨텍스트에 있다. 검증은 이 경계를 실제 Chromium에서 통과해야 한다.

Playwright runtime test는 bundled Chromium을 persistent context로 실행하고 `dist/` 확장을 side-load한다. extension ID는 Service Worker target을 통해 탐지한다.

## 로컬 실행

```bash
npm ci
npx playwright install --with-deps chromium
npm run verify:pathfinder
```

Playwright browser 설치 여부만 확인하려면:

```bash
node -e "const { chromium } = require('playwright'); console.log(chromium.executablePath())"
```

headed 진단이 필요한 Linux 서버에서는:

```bash
xvfb-run -a npm run verify:pathfinder:runtime
```

기본 runtime 검증은 `channel: chromium`의 headless persistent context를 사용하므로 정상 실행에는 Xvfb가 필요하지 않다.

## 현재 자동 검증 범위

### Trace contract

- source/dist manifest의 optional host/cookie 권한 계약
- 동적 content script bundle 생성
- GET/POST 및 query/body sample 분석
- path template 및 identifier 추론
- noise/analytics 요청 제외
- auth candidate 탐지
- 도구 간 관계 edge 생성
- semantic metadata 생성
- 등록 payload 크기 제한
- token, cookie, authorization 및 API key 제거
- Collection 생성 요청 계약
- 수동 Tool Contract의 URL/schema/security 정규화와 민감 literal 차단
- Postman v2.0/v2.1 중첩 request, auth, body/response variation과 민감값 비노출
- GraphQL introspection endpoint/schema 검증, operation 수와 error 원문 제거

### Browser runtime

- unpacked extension 로딩
- Manifest V3 Service Worker 및 Side Panel 접근
- Page Agent context 추출
- 입력, 클릭, 스크롤 및 stale snapshot 처리
- SPA navigation 후 hook 재연결
- 대상 탭 고정
- fetch/XHR 요청 캡처
- 캡처 start/stop 직렬화, 동일 탭 멱등 시작 및 탭 간 세션 교체 cleanup
- 캡처 결과 ID/ACK 중복 방지와 Manifest V3 Service Worker 강제 종료 후
  `interrupted` 복구
- 저장된 XGEN httpOnly cookie 인증
- dev XGEN origin 및 token 탐지
- `page_command` 결과 callback
- Side Panel 채팅 SSE relay
- 수동 Tool Contract 작성, XGEN preview 및 Collection source 등록
- Postman 파일 분석, Base URL 보완, XGEN preview 및 Collection source 등록
- GraphQL introspection 분석, XGEN preview 및 endpoint/capability 포함 source 등록
- Collection 등록 후 graph build/readiness/semantic/edge 품질 상태와 구버전
  backend의 detail endpoint 미지원 분류
- XGEN capability manifest 계약, 필수 기능 누락, client/backend 버전 불일치와
  read-only legacy fallback
- 기존 Collection의 명시적 auth profile 연결, 로그인 캡처 기반 관리 profile 생성
  및 재로그인 후 갱신
- same-origin/승인된 iframe API 캡처, frame 출처 evidence와 Service Worker
  비가시성 coverage 진단
- capture 결과의 Collection 등록
- Collection 충돌 및 merge UI
- host/cookie 최초 미승인 readiness와 persisted 승인 상태
- 실행 중 host permission revoke 후 hook, relay, raw buffer 폐기

### XGEN endpoint contract

`contracts/xgen-api-contract.json`은 extension client가 사용하는 핵심 XGEN endpoint를 고정한다. T0 검증은 client source와 runtime mock이 같은 endpoint를 포함하는지 확인한다. endpoint를 변경할 때는 contract manifest, client, runtime fixture 및 XGEN 연동 문서를 같은 PR에서 갱신한다.

## 검증 계층

| 계층 | 환경 | 실행 시점 | 보장 범위 |
|---|---|---|---|
| T0 정적/contract | Node.js | 모든 PR | 분석, sanitizer, payload 계약 |
| T1 browser mock | Playwright Chromium | 모든 PR | 확장 컨텍스트 간 메시지와 UI 흐름 |
| T2 XGEN dev | 실제 dev XGEN | merge 후 또는 nightly | 현재 backend API와 Collection 생성/build |
| T3 고객사 acceptance | 고객사 내부망 | 릴리스 후보 | 실제 인증, 업무 페이지, 네트워크 및 CA |

T1 통과는 T2나 T3 통과를 의미하지 않는다. mock endpoint는 backend의 현재 OpenAPI 또는 contract fixture와 정기적으로 비교해야 한다.

## GitHub Actions

`.github/workflows/pathfinder-verification.yml`은 모든 PR에서 다음 job을 실행한다.

- `T0 Build and Contract`: build, XGEN endpoint contract, trace 분석, 등록 payload,
  T2 verifier의 synthetic Collection acceptance
- `T1 Chromium Runtime`: bundled Chromium에 extension을 로드한 runtime

T1 실패 시 `pathfinder-runtime-*` artifact에 다음을 저장한다.

- `trace.zip`
- `page-*.png`
- `runtime.log`
- `runtime-summary.json`

runtime log는 token/cookie 계열 값을 scrub한다. screenshot은 synthetic fixture에서만 자동 수집한다. 실제 고객사 페이지의 screenshot을 공용 CI artifact로 업로드하지 않는다.

artifact 파이프라인 자체를 검증하려면 Actions의 `Run workflow`에서
`verify_failure_artifacts`를 켠다. 이 실행은 synthetic token, 이메일, 전화번호,
긴 숫자가 포함된 의도적 runtime 실패를 만든 뒤 파일 생성과 redaction을 확인하고
일부러 job을 실패시킨다. 따라서 `pathfinder-runtime-*` artifact를 실제로
다운로드해 볼 수 있다. 검사는 runtime log와 summary뿐 아니라 trace 압축 내부까지
대상으로 하며, trace에는 verifier source를 포함하지 않는다. 일반 PR/push 실행에는
추가 browser 비용이 없다.

## Dev XGEN T2 Smoke

T2의 기본 probe는 PR workflow와 분리된 비파괴 검증이다.

```bash
export PATHFINDER_XGEN_URL='https://dev-xgen.x2bee.com'
export PATHFINDER_XGEN_TOKEN='...'
export PATHFINDER_XGEN_USER_ID='...'
npm run verify:xgen-dev
```

검증 범위:

- `/api/health`
- `/api/ai-chat/providers`
- `/api/session-station/v1/auth-profiles`
- `/api/tools/api-collections/capabilities`의 Pathfinder contract version,
  필수 capability 및 Collection build endpoint 계약
- 노출된 경우 `/openapi.json` 또는 `/api/openapi.json`과 endpoint contract 비교

token과 user ID 원문은 출력하지 않는다. 인증 없는 공개 endpoint만 확인할 때는 `PATHFINDER_XGEN_ALLOW_ANONYMOUS=1`을 명시한다. OpenAPI 문서 노출을 필수 gate로 만들 때는 `PATHFINDER_XGEN_REQUIRE_OPENAPI=1`을 사용한다.

실제 API Collection adapter와 graph/search/plan을 확인하려면 임시 read-only
Collection acceptance를 명시적으로 켠다.

```bash
export PATHFINDER_XGEN_RUN_COLLECTION_FLOW=1
export PATHFINDER_XGEN_TEST_GRAPHQL=1
npm run verify:xgen-dev
```

이 모드는 다음 순서로 실행한다.

1. OpenAPI fixture preview
2. 선택 시 GraphQL introspection fixture preview
3. 임시 Collection 생성과 Pathfinder `from-trace` payload 등록
4. build 결과의 tool/source 수, graph-tool-call 및 graph version 확인
5. readiness, semantic, edge quality summary 확인
6. health 질의 search Top-K와 deterministic plan synthesis 확인
7. `finally`에서 임시 Collection 삭제

실제 확장 등록 계약을 검증하기 위해 Collection flow는 기본적으로 `from-trace`를
사용한다. 구버전 backend와 OpenAPI source 경로만 진단해야 하는 경우에만
`PATHFINDER_XGEN_TEST_TRACE=0`으로 끌 수 있다.

LLM provider와 실제 HTTP runner까지 확인할 때만 다음을 추가한다.

```bash
export PATHFINDER_XGEN_RUN_EXECUTE=1
npm run verify:xgen-dev
```

execute fixture는 현재 XGEN의 `GET /api/health`만 호출하며 `intent.parsed`,
`plan.synthesized`, `step.completed`, `response.generated` SSE event를 모두
요구한다. XGEN 기본 LLM provider를 사용하므로 비용과 provider readiness를
확인한 뒤 실행한다. 실패 조사 때문에 Collection을 보존해야 할 때만
`PATHFINDER_XGEN_KEEP_COLLECTION=1`을 사용하고, 이후 수동 삭제한다.

T2 verifier 자체는 실제 credential 없이 다음 명령으로 검증한다.

```bash
npm run verify:pathfinder:xgen-dev-fixture
```

이 fixture 통과는 실제 dev 통과를 의미하지 않는다. verifier의 request 순서,
capability manifest 형식과 필수 기능 판정, search/plan assertion, cleanup과
secret 비노출만 보장한다. 특히 `/capabilities`가 동적 Collection 상세 route로
잘못 처리되는 경우도 contract name 검증에서 실패해야 한다.

## XGEN dev integration 권장 시나리오

1. dev XGEN에 테스트 사용자로 로그인한다.
2. read-only 대상 페이지를 연다.
3. Pathfinder에서 캡처를 시작한다.
4. 목록 조회, 상세 조회와 검색 조건 변경을 수행한다.
5. 캡처를 종료하고 선택한 도구를 Collection에 등록한다.
6. XGEN에서 source, tool metadata 및 auth profile 연결을 확인한다.
7. graph build를 실행한다.
8. Quality Lab에서 검색과 plan을 실행한다.
9. read-only execute로 실제 API 호출을 확인한다.

mutating API는 dev host allowlist, 명시적 허용 및 cleanup이 모두 있을 때만 실행한다.

## 결과물

CI나 수동 검증 실패 시 다음 정보를 남긴다.

- extension git SHA 및 manifest version
- Node, Playwright 및 Chromium version
- XGEN 환경과 backend build version
- 실패한 test layer와 stage
- Playwright trace 및 screenshot
- browser console과 Service Worker error
- 민감정보가 제거된 요청/응답 구조

토큰, Cookie header, 사용자 식별자 및 실제 업무 payload는 artifact에 포함하지 않는다.

## 확인된 기준 환경

2026-07-26 기준 다음 환경에서 `build + verify:pathfinder:runtime`을 확인했다.

- Ubuntu 24.04
- Node.js 22.22.1
- npm 10.9.4
- Playwright 1.62.0
- Playwright Chromium 151.0.7922.34
