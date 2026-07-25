# XGEN Integration

## 전제 조건

- 사용자가 XGEN에 로그인되어 있어야 한다.
- Pathfinder가 XGEN origin과 인증 token 또는 cookie를 확인할 수 있어야 한다.
- XGEN backend가 Pathfinder와 API Collection endpoint를 제공해야 한다.
- 대상 API host의 auth profile을 조회하거나 생성할 권한이 있어야 한다.

## 사용하는 XGEN API

| 경로 | 용도 |
|---|---|
| `GET /api/ai-chat/providers` | 사용 가능한 LLM provider/model 조회 |
| `POST /api/ai-chat/stream` | Side Panel 채팅 및 SSE |
| `POST /api/ai-chat/command-result/{requestId}` | 페이지 명령 실제 결과 반환 |
| `GET /api/pathfinder/resolve` | URL 기반 Collection/실행 컨텍스트 해석 |
| `POST /api/pathfinder/greet` | 외부 페이지 진입 컨텍스트 생성 |
| `POST /api/tools/api-collections/from-trace` | 캡처 결과로 Collection 생성 |
| `POST /api/tools/api-collections/{id}/from-trace/merge` | 기존 Collection과 trace 병합 |
| `POST /api/tools/api-collections/{id}/run` | Collection tool 실행 |
| `/api/session-station/v1/auth-profiles` | 대상 host 인증 profile 조회/생성 |

backend route 또는 schema가 변경되면 `src/shared/api.ts`, runtime mock 및 이 표를 같은 PR에서 갱신한다.

핵심 endpoint의 machine-readable 기준은 `contracts/xgen-api-contract.json`이다.

## 인증 해석

Pathfinder는 XGEN origin별 token을 분리한다. 서버 URL은 XGEN origin으로 검증하고, 비-XGEN 페이지에서 발견한 token을 XGEN token으로 저장하지 않는다.

인증 소스 우선순위:

1. 현재 XGEN origin에 연결된 메모리 cache
2. `chrome.storage.local`의 origin별 token
3. XGEN host의 알려진 httpOnly cookie
4. 호환용 기본 token

대상 API 실행 인증은 XGEN auth profile과 현재 대상 페이지의 live cookie를 사용한다. trace에 포함된 오래된 cookie 값을 실행 인증으로 신뢰하지 않는다.

## Collection 등록

등록 payload는 다음 정보를 포함할 수 있다.

- host
- method 및 templated path
- path/query parameter
- 제한되고 정제된 request/response sample
- semantic metadata
- 관찰된 tool 관계
- 연결할 `auth_profile_id`

기존 Collection이 있을 때는 자동 overwrite하지 않고 충돌 결과를 표시한 뒤 사용자가 merge를 선택하도록 한다.

## graph-tool-call 연결

Pathfinder는 브라우저에서 관찰 가능한 contract evidence를 제공한다. graph-tool-call은 XGEN backend에서 다음을 수행한다.

- tool schema와 IO contract 정규화
- action/resource/module semantic metadata
- data-flow 및 evidence edge 구성
- tool retrieval 및 target selection
- plan synthesis와 실행 trace

Pathfinder가 특정 고객사의 tool name이나 path를 기반으로 ranking 규칙을 만들면 안 된다. 고객사별 alias와 context는 XGEN adapter 옵션 또는 Collection metadata로 전달한다.

## 호환성 점검

릴리스 전 최소 점검:

- providers 응답의 model이 문자열과 객체 배열 모두에서 동작
- chat SSE event taxonomy가 Side Panel과 일치
- from-trace create/merge schema가 backend와 일치
- auth profile 필드명이 backend와 일치
- graph build 후 tool 수와 source 수가 등록 결과와 일치
- search/plan/execute 실패가 구조화된 reason으로 표시
