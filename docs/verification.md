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

- GET/POST 및 query/body sample 분석
- path template 및 identifier 추론
- noise/analytics 요청 제외
- auth candidate 탐지
- 도구 간 관계 edge 생성
- semantic metadata 생성
- 등록 payload 크기 제한
- token, cookie, authorization 및 API key 제거
- Collection 생성 요청 계약

### Browser runtime

- unpacked extension 로딩
- Manifest V3 Service Worker 및 Side Panel 접근
- Page Agent context 추출
- 입력, 클릭, 스크롤 및 stale snapshot 처리
- SPA navigation 후 hook 재연결
- 대상 탭 고정
- fetch/XHR 요청 캡처
- 저장된 XGEN httpOnly cookie 인증
- dev XGEN origin 및 token 탐지
- `page_command` 결과 callback
- Side Panel 채팅 SSE relay
- capture 결과의 Collection 등록
- Collection 충돌 및 merge UI

## 검증 계층

| 계층 | 환경 | 실행 시점 | 보장 범위 |
|---|---|---|---|
| T0 정적/contract | Node.js | 모든 PR | 분석, sanitizer, payload 계약 |
| T1 browser mock | Playwright Chromium | 모든 PR | 확장 컨텍스트 간 메시지와 UI 흐름 |
| T2 XGEN dev | 실제 dev XGEN | merge 후 또는 nightly | 현재 backend API와 Collection 생성/build |
| T3 고객사 acceptance | 고객사 내부망 | 릴리스 후보 | 실제 인증, 업무 페이지, 네트워크 및 CA |

T1 통과는 T2나 T3 통과를 의미하지 않는다. mock endpoint는 backend의 현재 OpenAPI 또는 contract fixture와 정기적으로 비교해야 한다.

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

