# OpenAPI Import

Pathfinder는 OpenAPI/Swagger 문서를 URL 또는 JSON/YAML 파일로 받아 XGEN API
Collection에 등록한다. 브라우저에서 별도의 tool 변환기를 구현하지 않고 XGEN의
`preview`와 `add source`가 같은 graph-tool-call adapter를 사용하도록 한다. 따라서
미리보기와 실제 등록의 tool 수, capability 및 readiness 판정이 같은 경로에서
계산된다.

## Workflow

1. 상단 `소스 가져오기`에서 `OpenAPI`를 선택한다.
2. OpenAPI/Swagger/Swagger UI URL을 입력하거나 JSON/YAML 파일을 고른다.
3. 새 Collection 또는 기존 Collection을 선택한다.
4. 미리보기에서 tool 수, 추가 edge, 이름 충돌, adapter, readiness와 blocker를
   확인한다.
5. `Collection에 등록`을 실행한다.

새 Collection에서는 문서 title 또는 URL host로 ID와 이름을 제안한다. spec의
`servers[0].url` 또는 Swagger 2의 host/basePath를 base URL과 domain 후보로
사용하고, 같은 host의 인증 프로필이 있으면 Collection 생성 시 연결한다. 기존
Collection에서는 source가 추가된 뒤 전체 graph가 다시 build된다.

## Supported Sources

| 입력 | 처리 |
|---|---|
| OpenAPI 3 JSON/YAML URL | XGEN backend에서 resolve, preview, ingest |
| Swagger 2 JSON/YAML URL | XGEN backend adapter로 변환 및 ingest |
| Swagger UI URL | UI config에서 실제 docs URL 후보 해석 |
| JSON/YAML file | sidepanel에서 bounded parse 후 spec 객체 전송 |
| 새 Collection | metadata 생성 후 source 추가 |
| 기존 Collection | conflict preview 후 source 추가와 graph rebuild |

파일은 5MB 이하이며 YAML alias는 최대 20개로 제한한다. 업로드한 문서의 내부
`$ref`는 유지되지만 로컬 파일에 상대적인 외부 `$ref` 파일은 함께 업로드되지
않는다. 이런 문서는 모든 ref가 접근 가능한 URL source로 가져오거나 하나의
문서로 bundle해야 한다.

OpenAPI callback과 webhook은 metadata evidence로만 다루며 실행 가능한 일반 HTTP
tool로 만들지 않는다. source 등록 시 deterministic semantic build를 먼저 수행하고
LLM Pass 2 enrichment는 자동 실행하지 않는다.

## Failure Safety

미리보기에서 adapter가 실행에 필요한 input/output schema capability를 제공하지
않거나 blocker가 있으면 등록 버튼을 활성화하지 않는다. 새 Collection을 만든 뒤
source ingest가 실패하면 Pathfinder가 방금 만든 빈 Collection을 삭제한다. 기존
Collection에 source를 추가하다 실패한 경우 backend transaction/preservation
정책을 따르며 기존 Collection을 삭제하지 않는다.

## Security Boundary

- URL은 HTTP/HTTPS만 허용하고 `user:password@host` 및 token/API key/session
  계열 query key를 거부한다.
- JSON/YAML 문서의 server, external `$ref`, OAuth endpoint URL에도 같은
  자격정보/query 검사를 적용한다.
- URL 문서는 브라우저가 아니라 XGEN backend가 fetch한다.
- private/internal host 지원은 고객사 연동을 위한 의도된 동작이다.
- URL 접근 권한, DNS, egress allowlist와 audit은 XGEN 운영 정책으로 제한한다.
- 파일 원문은 extension storage에 저장하지 않지만 parse 중 sidepanel 메모리에
  존재한다.
- API key, cookie 또는 token을 OpenAPI URL query나 문서 예시에 넣지 않는다.

## XGEN Contract

Pathfinder가 사용하는 공개 endpoint는 다음과 같다.

```text
GET    /api/tools/api-collections
POST   /api/tools/api-collections/preview
POST   /api/tools/api-collections
POST   /api/tools/api-collections/{collectionId}/sources
DELETE /api/tools/api-collections/{collectionId}
```

`preview`와 source 등록에는 `format_hint=openapi` 및
`required_capabilities=[input_schema, output_schema]`를 전달한다. 새 XGEN
backend가 이 계약을 제공하지 않으면 구조화된 API 오류를 표시하고 기존 HAR/trace
capture 기능은 계속 사용할 수 있다.

## Verification

```bash
npm run verify:pathfinder
```

검증은 API client method/path/body, URL preview와 신규 Collection 생성, YAML
preview와 기존 Collection 병합, 인증 header 전달, source ingest 실패 시 rollback,
기존 HAR와 runtime capture 회귀를 포함한다. 실제 고객사 OpenAPI의 search, plan 및
read-only execute 성공은 XGEN dev T2에서 별도로 확인한다.
