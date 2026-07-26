# HAR Import

Pathfinder는 브라우저 hook이 관찰하지 못한 Worker, Service Worker 또는 별도
클라이언트의 HTTP 요청을 HAR 1.2 파일에서 가져올 수 있다. 가져온 요청은 실시간
캡처와 같은 trace analyzer, 도구 선택, XGEN Collection create/merge 경로를
사용한다.

## 사용

1. Chrome DevTools의 Network 패널 등에서 HAR 파일을 내보낸다.
2. Pathfinder 상단의 `HAR 파일 가져오기` 버튼에서 `.har` 파일을 선택한다.
3. 분석된 host, 도구, contract coverage와 제외 항목을 확인한다.
4. 필요한 도구만 선택하고 XGEN Collection으로 등록하거나 기존 Collection에
   병합한다.

UI는 최대 10MB 파일을 받으며 importer는 앞의 500개 entry만 처리한다. 제한이
적용되거나 민감값이 제거되면 분석 패널에 상태를 표시한다.

## 지원 범위

| HAR 입력 | 처리 |
|---|---|
| HTTP/HTTPS request | method, scrubbed URL, header name, status, duration |
| JSON 및 `application/*+json` | bounded request/response shape와 sample |
| GraphQL over HTTP | 기존 GraphQL operation analyzer로 전달 |
| URL encoded form | key/value 구조로 정규화 |
| multipart form | text field와 file field/content type |
| base64 JSON response | UTF-8 decode 후 bounded JSON 분석 |

WebSocket, CONNECT, streaming message, arbitrary text body와 binary body는 tool
contract로 복원하지 않는다. 파일 이름과 파일 bytes도 저장하지 않는다.

## Privacy Boundary

HAR는 민감정보를 포함할 수 있으므로 원본을 XGEN에 그대로 보내지 않는다.
importer가 다음 값을 분석 전에 제거하거나 대체한다.

- URL의 `user:password@host`
- token, password, secret, session, cookie, API key 계열 query key
- Authorization, Cookie, Set-Cookie 및 proxy authorization header
- JSON/form의 민감 key
- 이메일, 전화번호, 주민번호형 식별자, 긴 숫자 및 JWT 값 패턴
- multipart filename과 file bytes

키 이름과 대표 값 패턴에 의존하는 scrub은 모든 업무 식별자를 판별할 수 없다.
민감한 HAR는 먼저 별도 도구로 검토하고, 등록 화면에서 sample 저장을 끄는 것을
권장한다. 가져온 HAR 원본은 extension storage나 XGEN Collection에 저장하지
않지만 파일을 읽고 분석하는 동안 sidepanel 메모리에는 존재한다.

## Verification

정적 검증은 URL 자격정보, header/cookie, query, JSON PII, GraphQL, multipart와
UTF-8 base64 JSON을 확인한다. Chromium runtime은 실제 파일 입력, 분석 패널,
민감값 비노출과 기존 캡처 회귀를 함께 검증한다.

```bash
npm run verify:pathfinder
```

이 검증은 XGEN dev의 graph build와 API 실행 성공을 대신하지 않는다. Collection
등록 이후 search, plan 및 read-only execute는 P4 통합 gate에서 별도로 확인한다.
