# Postman Collection Import

Pathfinder는 Postman Collection v2.0/v2.1 JSON을 OpenAPI 3.1 contract로
정규화한 뒤, 기존 OpenAPI preview와 XGEN API Collection 등록 경로를
재사용한다. Postman runtime이나 script를 실행하는 기능이 아니라 HTTP
operation의 구조만 가져오는 importer다.

구현 기준은 Postman의
[Collection v2.1 schema](https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json)와
[Collection export 문서](https://learning.postman.com/docs/getting-started/importing-and-exporting/exporting-data/)다.

## 사용

1. Postman에서 Collection v2.0 또는 v2.1 JSON을 export한다.
2. Pathfinder의 `소스 가져오기`에서 `Postman Collection`을 선택한다.
3. JSON 파일을 선택한다.
4. host가 `{{baseUrl}}` 같은 환경 변수이고 Collection 변수로 해석되지 않으면
   실제 API의 Base URL만 입력해 다시 분석한다.
5. 변환 요약과 경고를 확인한 뒤 XGEN preview, readiness 및 인증 프로필을
   확인하고 새 Collection 또는 기존 Collection source로 등록한다.

파일 크기는 10MB, 처리 request는 앞의 500개로 제한한다. 원본 파일은
extension storage나 XGEN에 저장하지 않는다.

## 변환 계약

| Postman 입력 | OpenAPI/XGEN 결과 |
|---|---|
| 중첩 folder/item | operation의 `folder_path` provenance |
| request method와 URL | OpenAPI path와 operation |
| `:id`, `{{id}}` path 변수 | required path parameter |
| query/header | 이름과 위치만 parameter로 보존 |
| raw JSON body | 값 없는 JSON Schema |
| urlencoded/form-data/file | object/binary request schema |
| GraphQL body | query/variables request schema와 operation name |
| saved response | status/content type별 response schema |
| collection/folder/request auth | OpenAPI security scheme/requirement |
| 같은 method/path의 여러 request | schema variation과 variant 이름 병합 |
| 여러 API host | operation-level server로 보존 |

Bearer/OAuth2, Basic, Digest 및 API key header/query 요구사항을 지원한다.
OAuth2 flow 자체와 token 값은 가져오지 않는다. 지원하지 않는 auth 방식은
경고로 표시하고 XGEN에서 인증 프로필을 별도로 설정한다.

## Privacy Boundary

importer는 Collection을 실행하지 않으며 다음 원문을 결과 artifact에 넣지 않는다.

- Collection/environment variable 값
- Authorization, Cookie, API key 및 민감 query 값
- request/response/body/header의 sample 값
- saved response의 개인정보 값
- multipart 파일 이름, 경로 및 bytes
- pre-request/test script source

request/response sample은 필드 이름과 type을 나타내는 JSON Schema로만 변환한다.
collection, folder, request 이름과 설명도 이메일·전화번호·token형 값을
scrub한다. 결과의 `x-pathfinder-source`에는
`sample_values_persisted: false`, `scripts_executed: false`를 남긴다.

평범한 이름을 가진 업무 기밀값이나 사용자 정의 script가 만들어내는 동적
request를 자동 복원할 수는 없다. 이런 Collection은 preview에서 contract를
확인하고, 필요한 operation은 OpenAPI 또는 수동 Tool Contract로 보완한다.

## 지원하지 않는 항목

- Postman environment/globals 파일의 자동 병합
- pre-request/test script 실행
- dynamic variable, mock server 및 example의 런타임 동작 재현
- WebSocket, Socket.IO, gRPC request
- OAuth2 authorization flow 설정 자동 이관
- 실제 API 호출과 인증 성공 검증

## Verification

T0는 중첩 folder, 변수, auth 상속, JSON/form/file/GraphQL body, saved response,
중복 variation 및 민감값 비노출을 검증한다. T1은 Chromium에서 파일 선택,
Base URL 보완, XGEN preview와 Collection/source 등록을 검증한다.

```bash
npm run verify:pathfinder
```

이 검증은 mock backend 기준이다. 실제 graph build, search, plan 및 read-only
execute는 XGEN dev T2에서 별도로 확인한다.
