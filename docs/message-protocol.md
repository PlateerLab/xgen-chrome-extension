# Extension Message Protocol

이 문서는 Side Panel, Service Worker 및 Content Script 사이의 내부 메시지 계약을 설명한다. TypeScript의 기준 계약은 `src/shared/types.ts`다.

## 원칙

- Side Panel과 Content Script는 직접 연결된 것으로 가정하지 않는다. Service Worker가 라우팅과 대상 탭 선택을 담당한다.
- 탭에 종속된 명령은 가능하면 `tabId`를 명시한다.
- 페이지 조작은 최신 `snapshotId`를 포함하고 stale snapshot을 오류로 처리한다.
- `requestId`가 있는 명령은 같은 ID로 결과를 반환한다.
- 인증정보 원문은 응답, console 및 test artifact에 기록하지 않는다.

## 설정과 인증

| 메시지 | 방향 | 목적 |
|---|---|---|
| `SET_ORIGIN` | Content Script → Service Worker | 현재 XGEN origin 등록 |
| `SET_TOKEN` | Content Script → Service Worker | 검증된 XGEN origin의 token 갱신 |
| `GET_CHAT_CONFIG` | Side Panel → Service Worker | server URL, provider, model, token 존재 여부 및 page context 조회 |
| `CHAT_CONFIG` | Service Worker → Side Panel | 채팅 실행 설정 반환 |
| `PREPARE_COLLECTION_RUN_AUTH` | Side Panel → Service Worker | Collection과 auth profile을 확인하고 필요한 실행 인증만 준비 |
| `GET_LIVE_COOKIES` | Side Panel → Service Worker | 검증된 단일 URL의 cookie 조회를 진단하는 하위 호환 경로 |
| `LOOKUP_AUTH_PROFILE_FOR_HOST` | Side Panel → Service Worker | host에 연결된 XGEN auth profile 조회 |

`SET_TOKEN`은 임의 origin의 token 저장 API가 아니다. Service Worker의 XGEN origin 검증을 통과해야 한다.

Collection 실행은 현재 페이지 host를 인증 대상으로 추정하지 않는다.
`PREPARE_COLLECTION_RUN_AUTH`가 Collection `auth_profile_id`, profile `auth_type`,
Collection `base_url`을 순서대로 확인한다. `auth_type=cookie`일 때만 `base_url`의
optional host/cookie 권한을 확인하고 live cookie를 만든다. 페이지와 API host가
달라도 사용자가 API host 권한을 승인한 경우에만 허용하며, 그 외에는
`collection_cookie_permission_required`로 중단한다. Bearer 등 다른 profile과
인증이 없는 Collection 요청에는 `live_cookies` 필드가 존재하지 않는다.

Page context cache는 tab ID별로 격리된다. `PAGE_CONTEXT_UPDATE`,
`PAGE_COMMAND_RESULT`, `CANVAS_RESULT`는 sender tab만 갱신하고, Side Panel도 자신이
고정된 tab의 update만 수신한다. 탭 제거 또는 host 권한 회수 시 해당 cache를 폐기한다.

## Page Agent

| 메시지 | 방향 | 목적 |
|---|---|---|
| `GET_PAGE_CONTEXT` | Side Panel/Service Worker → Content Script | 현재 DOM snapshot 조회 |
| `PAGE_CONTEXT_UPDATE` | Content Script → Service Worker | navigation 또는 DOM 갱신 통지 |
| `PAGE_COMMAND` | Service Worker → Content Script | 클릭, 입력, 스크롤 등 페이지 명령 |
| `PAGE_COMMAND_RESULT` | Content Script → Service Worker | 명령 실행 및 재관찰 결과 |
| `RELAY_COMMAND` | Side Panel → Service Worker | backend SSE command를 대상 탭으로 relay |
| `COMMAND_RESULT` | Service Worker → Side Panel | relay 결과 반환 |

Page context의 핵심 필드:

- `pageType`
- `url`, `title`
- `elements`: `[index]` 기반 평탄화 DOM
- `snapshotId`: snapshot freshness 확인용 식별자
- `availableActions`
- `timestamp`

runtime test는 `PAGE_COMMAND` 자체와 Side Panel의 `RELAY_COMMAND` 흐름을 별도로 검증한다. 전자는 Content Script contract 검증이고, 후자는 Side Panel에서 callback까지 이어지는 통합 검증이다.

## API 캡처

| 메시지 | 방향 | 목적 |
|---|---|---|
| `API_CAPTURED` | Content Script → Service Worker | main-world hook에서 관찰한 API 전달 |
| `START_CAPTURE_SESSION` | Side Panel → Service Worker | 지정 탭의 사용자 캡처 시작 |
| `STOP_CAPTURE_SESSION` | Side Panel → Service Worker | 현재 캡처 종료 |
| `CAPTURE_SESSION_STATUS` | Service Worker → Side Panel | active 상태와 누적 건수 |
| `CAPTURE_SESSION_RESULT` | Service Worker → Side Panel | 종료된 세션 결과 |
| `GET_CAPTURE_RESULT` | Side Panel → Service Worker | Side Panel이 늦게 열린 경우 마지막 결과 1회 조회 |

`GET_CAPTURE_RESULT`는 Service Worker가 cache한 결과를 소비한다. 같은 결과를 반복 표시하기 위한 영속 API가 아니다.

캡처 결과의 `origin`:

- `user`: 사용자가 대상 페이지에서 직접 발생시킨 요청
- `ai`: Pathfinder가 페이지 명령으로 발생시킨 요청

사용자 캡처 세션은 기본적으로 `user` 요청을 수집해 AI 탐색 traffic과 구분한다.

## Stream

채팅 stream의 backend event는 `SSEEvent` 계약을 따른다.

- `token`
- `tool_start`, `tool_end`
- `canvas_command`, `page_command`
- `token_usage`
- `stage_change`, `plan_question`
- `done`, `error`

`page_command`에 `requestId`가 있으면 실행 결과를 `/api/ai-chat/command-result/{requestId}`로 반환한다. runtime mock은 고정 request ID를 사용해 라우팅을 검증하지만, 실제 backend는 요청마다 고유 ID를 발급해야 한다.

Collection plan의 step argument는 다음 placeholder 계약을 따른다.

- `${s1.body.id}`: 이전 step 결과를 실행 시 해석하는 binding이며 사용자 입력 누락이 아님
- `{customerId}`: 현재 contract에서는 해석되지 않은 literal placeholder이며 사용자 입력 필요
- `null`, `undefined`, 빈 문자열: 사용자 입력이 필요한 누락값
- 숫자 `0`, boolean `false`, 빈 배열: 유효한 명시 값

실행 전 plan guard는 정상 step binding을 통과시킨다. 실행 후에도 binding 문자열이
그대로 남아 HTTP 호출이 실패한 경우에만 사용자 입력으로 복구할 후보로 취급한다.

## 변경 규칙

메시지 필드를 변경할 때 다음을 같은 PR에 포함한다.

1. `src/shared/types.ts`
2. 송신자와 수신자 구현
3. `scripts/verify-runtime.mjs`
4. 이 문서

새 필드는 가능한 additive하게 추가하고, 기존 sender가 없는 필드를 처리할 수 있도록 optional로 시작한다.
