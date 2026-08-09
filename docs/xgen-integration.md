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
| `POST /api/tools/api-collections/{id}/from-trace` | 기존 Collection과 trace 병합 |
| `POST /api/tools/api-collections/preview` | OpenAPI/GraphQL 등 source adapter capability와 readiness 확인 |
| `POST /api/tools/api-collections/{id}/sources` | 검증된 범용 source를 Collection에 추가 |
| `GET /api/tools/api-collections/capabilities` | Pathfinder contract version과 기능 지원 범위 확인 |
| `GET /api/tools/api-collections/{id}` | 등록 후 graph build, readiness 및 semantic/edge 품질 상태 확인 |
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

auth profile 자동 연결 우선순위는 다음과 같다.

1. 같은 host에 명시적으로 연결된 기존 Collection의 `auth_profile_id`
2. 정규화한 host와 `service_id` 또는 자동 생성 profile 이름이 정확히 일치
3. 캡처된 로그인 request/response contract로 Pathfinder 관리 profile 생성

이름 일부가 우연히 같은 profile은 자동 연결하지 않는다. 같은 우선순위에서 서로
다른 profile이 발견되면 `ambiguous`로 중단한다. 로그인 재캡처 시
`[pathfinder:auto]` marker가 있는 관리 profile만 갱신하고, 운영자가 만든 profile은
연결만 하며 설정을 덮어쓰지 않는다. JWT에서 숫자 user id를 확인할 수 있으면
Session Station 요청에 `X-User-ID`를 함께 전달하지만 token이나 로그인 payload는
로그에 남기지 않는다.

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

등록이 성공하면 Pathfinder는 Collection 상세를 짧게 polling해 tool/source 수와
`graph_tool_call_version`, `collection_graph_version`, `readiness_summary`,
`semantic_summary`, `edge_quality_summary`를 표시한다. 예상 tool 수보다 적거나
graph metadata가 아직 없으면 경고 상태로 남긴다. 상세 endpoint가 `404` 또는
`405`를 반환하면 등록 실패로 오해하지 않고 backend contract 호환성 부족으로
분류한다.

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

자동 acceptance:

```bash
PATHFINDER_XGEN_RUN_COLLECTION_FLOW=1 \
PATHFINDER_XGEN_TEST_GRAPHQL=1 \
PATHFINDER_XGEN_RUN_WORKFLOW=1 \
npm run verify:xgen-dev
```

이 검증은 임시 Collection을 만들고 source ingest 후 반환되는
`graph_tool_call_version`, `collection_graph_version`, `readiness_summary`,
`semantic_summary`, `edge_quality_summary`를 확인한다. 이어서 실제
`test-search`와 `synthesize-plan`을 호출하고 정상 종료와 실패 모두에서 임시
Collection을 삭제한다. LLM/HTTP 실행은 `PATHFINDER_XGEN_RUN_EXECUTE=1`에서만
추가된다. `PATHFINDER_XGEN_RUN_WORKFLOW=1`은 live node catalog로 임시 4노드
캔버스를 만들고 `APICollectionLoader -> Agent Xgen` 연결을 실제 워크플로우
저장·SSE 실행 경로로 검증한 뒤 워크플로우와 Collection을 모두 삭제한다.
