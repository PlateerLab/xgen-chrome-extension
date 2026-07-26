# Capture Coverage

Pathfinder의 브라우저 캡처는 관찰한 사실과 추론을 분리한다. 지원하지 않는 transport를 REST tool처럼 꾸미지 않고, tool별 `captureMetadata`에 coverage, confidence, schema variation 및 issue code를 남긴다.

## 지원 범위

| 입력 | 현재 처리 |
|---|---|
| `fetch`, `XMLHttpRequest` JSON | request/response field shape, content type, query/path, envelope |
| GraphQL over HTTP JSON | query/mutation/subscription type, operationName, root field, variables, operation별 identity |
| `FormData` multipart | text field와 file field/type/size. 파일 bytes와 filename은 저장하지 않음 |
| URL encoded form | key/value 구조를 JSON shape로 정규화 |
| Blob, ArrayBuffer, typed array | binary body 존재와 제한 issue만 기록 |
| same-origin 또는 승인된 cross-origin iframe | frame별 fetch/XHR hook, `top_frame/subframe` 출처 evidence |
| 동일 operation 반복 관찰 | request/response shape signature별 observed count |
| nested object/array | 최대 depth와 field 상한 안에서 leaf/path 구조 보존 |
| common response envelope | `data`, `result`, `payload`, `items`, `rows` 등의 후보 path 표시 |

GraphQL operation은 extension 안에서 서로 다른 tool로 유지된다. 현재 XGEN `from-trace`가 같은 HTTP method/path의 여러 GraphQL operation을 OpenAPI fragment로 표현하려면 backend 계약 보강이 필요하므로 `xgen_graphql_contract_upgrade_required` issue를 함께 보낸다.

## Coverage와 Confidence

각 tool은 다음 evidence를 갖는다.

- request/response content type
- request body kind
- request/response schema variants와 관찰 횟수
- response envelope 후보
- file field metadata
- `coverageScore`와 `confidence`
- 안정 issue code

`coverageScore`는 operation identity, request contract, response contract, content type 관찰 여부로 계산한다. `confidence`는 점수와 warning 유무를 함께 사용한다. 이 값은 API의 업무적 정확성을 보증하지 않으며, 캡처 artifact가 얼마나 완전한지만 나타낸다.

## 관찰 불가능하거나 제한적인 영역

| 영역 | 이유 | 계획 |
|---|---|---|
| 권한이 거부된 cross-origin iframe | 현재 문서의 frame origin 권한이 필요 | 결과의 blocked frame/origin 진단 후 해당 origin 권한 승인 |
| Web Worker fetch | page `window.fetch`와 별도 실행 환경 | HAR/CDP 기반 보완 입력 |
| Service Worker fetch | page wrapper 바깥에서 실행 | HAR/CDP 또는 브라우저 debugger 권한 검토 |
| WebSocket / GraphQL subscription | HTTP request/response 모델이 아님 | 별도 message trace contract 연구 |
| EventSource/streaming | 종료 전 전체 body clone이 불완전할 수 있음 | stream metadata와 bounded event sample |
| opaque/CORS response | browser가 body/header 접근을 제한 | status와 limitation issue만 기록 |
| GraphQL batched request | 하나의 HTTP body에 여러 operation | operation fan-out contract 추가 |
| binary request/response | 원문 저장은 보안·크기 위험 | media type, size, hash/evidence만 유지 |

캡처 시작 시 현재 문서의 iframe origin을 열거하고 설치 권한이 아니라 현재 origin
단위의 optional permission만 요청한다. 허용된 frame에는 API relay/hook만 주입하며
PageAgent와 화면 overlay는 top frame에만 유지한다. 요청에는 query/path를 포함한
frame URL 대신 `frameOrigin`과 `top_frame/subframe`만 저장한다.

미지원 영역은 `captureMetadata.issues` 또는 session `captureCoverage`로 노출한다.
Service Worker 제어가 감지되면 worker 내부 fetch가 보이지 않는다는 warning을
표시한다. 조용히 빈 schema를 만들어 높은 confidence를 주지 않는다.

직접 transport 관찰 후보와 권한/보안 결론은
[`design/worker-transport-observation.md`](design/worker-transport-observation.md)에
정리한다. 기본 배포에는 `webRequest`나 `debugger` 권한을 추가하지 않는다.

## 검증

정적 fixture는 REST, GraphQL, multipart, nested envelope, schema variation, frame
evidence와 path identifier 오탐을 확인한다. Chromium runtime은 실제 `fetch`, XHR,
same-origin iframe fetch, GraphQL 2개 operation, FormData file upload, 등록 payload
및 캡처 종료 후 관찰 중단을 검증한다. Service Worker fixture 요청은 서버 도달을
확인하되 page capture에 섞이지 않고 limitation으로 남는지도 검사한다.

```bash
npm run verify:pathfinder
```
