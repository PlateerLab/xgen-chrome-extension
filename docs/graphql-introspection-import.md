# GraphQL Introspection Import

Pathfinder는 표준 GraphQL introspection JSON과 실제 요청을 보낼 HTTP endpoint를
받아 XGEN API Collection source로 등록한다. 브라우저에서 임의 GraphQL query를
실행하거나 schema를 다시 해석하지 않고, XGEN의 graph-tool-call
`graphql-introspection` adapter가 query와 mutation을 canonical tool contract로
변환한다.

## Workflow

1. GraphQL 서버에서 표준 introspection 응답을 JSON 파일로 준비한다.
2. Pathfinder 상단 `소스 가져오기`에서 `GraphQL Introspection`을 선택한다.
3. 실제 실행 endpoint를 입력하고 JSON 파일을 고른다.
4. query, mutation, subscription 및 type 수를 확인한다.
5. 새 Collection 또는 기존 Collection을 선택한다.
6. `미리보기`에서 adapter, 도구 수, capability와 readiness를 확인한다.
7. `Collection에 등록`을 실행한다.

endpoint와 schema 문서를 분리해서 받는 이유는 introspection 응답만으로 실제
요청 URL을 안정적으로 알 수 없기 때문이다. 새 Collection을 만들 때 endpoint
host와 일치하는 XGEN 인증 프로필이 있으면 기존 OpenAPI import와 같은 방식으로
자동 연결한다.

## Supported Contract

입력 JSON은 다음 두 형태를 지원한다.

```json
{
  "data": {
    "__schema": {}
  }
}
```

```json
{
  "__schema": {}
}
```

query와 mutation은 실행 가능한 tool로 등록한다. subscription은 장기 연결과
streaming lifecycle을 다루는 별도 execution adapter가 필요하므로 현재 tool
등록에서 제외하고 UI에 경고를 표시한다. schema의 argument, input object, enum,
interface, union 및 output type 정보는 backend adapter가 request/response
contract와 semantic evidence로 변환한다.

## Security Boundary

- endpoint는 HTTP/HTTPS 절대 URL만 허용한다.
- URL userinfo, fragment 및 token, API key, cookie, session 계열 query key를
  거부한다.
- endpoint 인증값은 URL이나 introspection JSON에 넣지 않는다.
- introspection 응답의 top-level `errors` 원문은 XGEN에 보내지 않고 개수만
  비식별 placeholder로 보존한다.
- 파일은 20MB 이하이며 extension storage에 저장하지 않는다.
- schema description, default value와 directive metadata는 API contract의
  일부일 수 있으므로 보존된다. schema 자체에 secret을 기록하면 안 된다.
- 실제 실행 인증은 Collection `auth_profile_id`와 현재 XGEN 사용자 세션에서
  해석한다.

Pathfinder는 GraphQL endpoint를 직접 호출하지 않는다. 사용자가 별도로 생성한
introspection 파일만 읽으며 preview와 source 등록은 인증된 XGEN backend로
전달한다.

## XGEN Contract

Pathfinder는 범용 Collection source endpoint를 사용한다.

```text
GET    /api/tools/api-collections
POST   /api/tools/api-collections/preview
POST   /api/tools/api-collections
POST   /api/tools/api-collections/{collectionId}/sources
DELETE /api/tools/api-collections/{collectionId}
```

preview와 source 등록 body에는 다음 필드가 포함된다.

```json
{
  "format_hint": "graphql-introspection",
  "endpoint_url": "https://api.example.com/graphql",
  "spec": {
    "data": {
      "__schema": {}
    }
  },
  "required_capabilities": ["input_schema", "output_schema"]
}
```

backend가 `graphql-introspection` adapter를 제공하지 않으면 등록 가능한 것처럼
처리하지 않고 preview 오류를 그대로 표시한다. canonical query/mutation tool은
HTTP `POST` body의 `query`, `operationName`, `variables` binding으로 실행되며,
subscription-only schema는 실행 가능한 도구가 없어 등록을 차단한다.

## Verification

```bash
npm run verify:pathfinder
```

T0는 endpoint validation, operation count, 비표준 문서 거부와 introspection error
원문 제거를 검증한다. T1 Chromium runtime은 메뉴, JSON file 분석, XGEN preview,
Collection 생성, source 등록, endpoint/capability 전달 및 secret 비노출을
검증한다. 실제 XGEN에서 생성된 tool의 search, plan 및 authenticated execute는
T2 dev 검증 범위다.
