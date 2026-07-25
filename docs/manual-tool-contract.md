# Manual Tool Contract

수동 Tool Contract 편집기는 캡처, HAR 또는 원본 OpenAPI 문서가 없는 API를
XGEN API Collection에 등록하기 위한 입력 경로다. 편집 결과는 별도 전용 포맷이
아니라 OpenAPI 3.1 문서로 정규화되며, OpenAPI import와 동일한 XGEN preview,
readiness 및 ingest 경로를 사용한다.

## 사용 순서

1. Side Panel 상단의 `소스 가져오기`를 연다.
2. `수동 Tool Contract`를 선택한다.
3. HTTP method와 절대 endpoint URL을 입력한다.
4. operationId와 도구 설명을 작성한다. operationId를 비우면 method와 path에서
   결정적으로 생성한다.
5. query, path, header 또는 cookie parameter를 추가한다.
6. request/response JSON Schema와 content type을 입력한다.
7. API가 요구하는 인증 방식을 선택한다. 실제 token이나 cookie 값은 입력하지
   않는다.
8. `contract 검증`을 누른 뒤 XGEN readiness 결과를 확인한다.
9. 새 Collection을 만들거나 기존 Collection에 source를 추가한다.

`/orders/{orderId}`처럼 URL에 선언된 path parameter는 별도 행이 없어도
`required: true`, `type: string`으로 생성된다. 더 구체적인 타입이 필요하면 같은
이름의 path parameter 행을 추가한다.

## 지원 계약

| 항목 | 지원 범위 |
|---|---|
| HTTP method | GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS |
| Parameter 위치 | path, query, header, cookie |
| Parameter 타입 | string, integer, number, boolean, string array |
| Body | request/response JSON Schema |
| Content type | 유효한 media type |
| Response status | 100-599 또는 `default` |
| Auth | none, Bearer, Basic, API key header/query, cookie |
| Target | 새 Collection 또는 기존 Collection |

여러 operation을 한 번에 입력해야 한다면 OpenAPI 파일 import가 더 적합하다. 수동
편집기는 한 번에 한 operation을 만들고, 기존 Collection에 반복해서 추가할 수 있다.

## 생성되는 OpenAPI

생성 문서는 다음 provenance를 operation에 포함한다.

```json
{
  "x-pathfinder-source": {
    "kind": "manual_contract",
    "version": 1,
    "sample_values_persisted": false
  }
}
```

endpoint의 origin은 `servers[0].url`, path는 `paths`, 인증 요구사항은
`components.securitySchemes`와 operation `security`로 저장된다. 이 문서는
XGEN backend의 동일한 OpenAPI parser를 통과하므로 graph-tool-call의 contract
추출, semantic metadata 및 readiness 진단 대상이 된다.

## 보안 규칙

- endpoint URL에 사용자명, 비밀번호, query 값 또는 fragment를 넣을 수 없다.
- 실제 Authorization, cookie, API key 값은 입력하지 않는다.
- JSON Schema의 `example`, `examples`, `default`, `x-example`은 등록 전에
  제거한다.
- 이메일, 전화번호, 장문 식별자, JWT 형태의 literal은 입력 단계에서 차단한다.
- 민감 필드의 `enum`과 `const` 실제 값은 차단한다.
- 외부 `$ref`는 해석하지 않는다. self-contained schema 또는 OpenAPI 파일
  import를 사용한다.
- JSON Schema는 100KB, 2,000 nodes, depth 24 이하로 제한한다.

인증 방식은 API가 무엇을 요구하는지만 설명한다. 실행 자격정보는 Collection의
`auth_profile_id`와 로그인 사용자 세션을 통해 XGEN에서 해석한다.

## 검증

T0는 builder가 다음을 보장하는지 검사한다.

- operation identity와 templated path
- path/query parameter 위치, 필수 여부 및 타입
- nested request/response schema
- security scheme
- sample/default 제거와 민감값 차단
- 외부 `$ref`, 잘못된 URL, 중복/mismatched path parameter 거부

T1은 실제 Chromium Side Panel에서 다음 흐름을 실행한다.

```text
소스 메뉴 → 수동 contract 작성 → OpenAPI 생성 → XGEN preview
→ Collection 생성 → source 등록
```

T1은 mock XGEN 계약 검증이다. 실제 graph build, 검색, plan 및 execute는 dev
배포 후 T2에서 확인한다.
