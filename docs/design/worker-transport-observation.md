# Worker Transport Observation

## 결론

Pathfinder의 기본 캡처는 page/iframe hook과 HAR import를 유지한다.
Web Worker, Shared Worker 및 Service Worker 내부 fetch를 직접 수집하기 위해
`webRequest`나 `debugger` 권한을 기본으로 추가하지 않는다.

직접 관찰이 꼭 필요한 관리형 고객사 환경에서는 별도의
`enterprise diagnostics` 모드를 검토한다. 이 모드는 명시적 사용자 동작으로
`debugger` optional permission을 요청하고, 한 번의 capture session과 한 탭에만
CDP를 연결하는 방식이어야 한다.

## 검토한 선택지

### Page/iframe hook

현재 방식은 page와 권한이 허용된 iframe의 `fetch`/XHR request 및 response
payload를 복원할 수 있다. 하지만 Worker는 별도 JavaScript execution target이라
page main world hook을 상속하지 않는다.

이 방식은 최소 권한이고 payload를 sanitizer로 보내기 전에 session 범위에서
제어할 수 있으므로 기본 경로로 적합하다.

### `chrome.webRequest`

`webRequest`는 host permission이 허용된 HTTP(S) traffic의 lifecycle과 request
type을 관찰할 수 있다. `onBeforeRequest`의 request body와 response
status/header는 일부 얻을 수 있다.

다음 한계 때문에 완전한 contract capture로 사용하지 않는다.

- response body를 읽는 API가 없다.
- `Authorization` 등 일부 header는 기본 event에서 제공되지 않는다.
- request URL과 initiator 모두에 host access가 필요할 수 있다.
- `extraHeaders`는 성능 영향이 있고 더 넓은 민감정보를 노출할 수 있다.
- WebSocket은 handshake만 보이며 message payload는 보이지 않는다.

따라서 향후 구현하더라도 `worker_request_observed` 같은 coverage evidence를
보완하는 metadata-only 경로로 제한한다.

### `chrome.debugger` + CDP

`chrome.debugger`는 Network와 Target CDP domain을 사용할 수 있다. Chrome
125부터 flat child session을 지원하므로 page target에서 관련 iframe/worker를
auto-attach하고 child `sessionId`로 Network command를 보낼 수 있다.

CDP Network domain은 다음 contract 복원 신호를 제공할 수 있다.

- `Network.requestWillBeSent`
- `Network.getRequestPostData`
- `Network.responseReceived`
- `Network.getResponseBody`
- `Network.loadingFinished`

하지만 `debugger` permission은 사용자에게 page debugger backend 접근 및 모든
사이트 데이터 읽기/변경 경고를 표시한다. DevTools가 같은 탭에 열리면 extension
debugger session이 강제로 분리될 수도 있다. child target auto-attach도 재귀적이지
않으므로 각 child session에서 다시 설정해야 한다.

이 위험과 복잡성 때문에 일반 배포의 기본 기능으로 채택하지 않는다.

### DevTools Network / HAR

DevTools Network export는 사용자 의도가 명확하고 Worker traffic을 포함할 수
있다. Pathfinder의 privacy-safe HAR importer는 raw archive를 영구 저장하지 않고
sanitized capture contract로 변환하므로 현재 가장 안전한 보완 경로다.

## Enterprise diagnostics 설계 조건

향후 prototype은 다음 조건을 모두 만족해야 한다.

1. `debugger`는 install-time permission이 아니라 optional permission이다.
2. 권한 요청은 사용자가 `Worker 진단 캡처`를 누른 시점에만 수행한다.
3. attach 범위는 선택한 한 탭과 capture session lifetime으로 제한한다.
4. root target과 관련 `worker`, `shared_worker`, `service_worker`, `iframe`
   child session에 `Network.enable`을 적용한다.
5. child target auto-attach는 각 child session에서 재귀적으로 설정한다.
6. `Fetch` interception이나 request mutation은 사용하지 않는다.
7. request/response payload는 기존 sanitizer와 size cap을 통과하기 전에는
   persistence, log 또는 XGEN 전송 대상이 아니다.
8. capture 종료, 탭 종료, permission revoke 및 `onDetach`에서 모든 in-memory
   request state를 폐기한다.
9. DevTools 충돌이나 attach 실패는 기존 page hook/HAR 경로를 중단시키지 않고
   coverage issue로만 남긴다.
10. Chrome 125 미만에서는 기능을 노출하지 않는다.

## Prototype acceptance

구현 여부는 별도 fixture에서 다음을 먼저 증명한 뒤 결정한다.

- page hook에 보이지 않는 Service Worker fetch가 child target에서 관찰됨
- request post data와 response body가 같은 request ID로 결합됨
- token, cookie, PII 및 file bytes가 artifact와 log에 남지 않음
- DevTools open, detach, target close, permission revoke가 모두 정상 정리됨
- page/iframe/HAR 기존 회귀가 그대로 통과함
- debugger permission을 거부해도 기본 캡처가 계속 동작함

## Primary references

- Chrome `webRequest`:
  <https://developer.chrome.com/docs/extensions/reference/api/webRequest>
- Chrome `debugger`:
  <https://developer.chrome.com/docs/extensions/reference/api/debugger>
- Chrome optional permissions:
  <https://developer.chrome.com/docs/extensions/reference/api/permissions>
- Chrome permission warnings:
  <https://developer.chrome.com/docs/extensions/reference/permissions-list>
- CDP Target domain:
  <https://chromedevtools.github.io/devtools-protocol/tot/Target/>
- CDP Network domain:
  <https://chromedevtools.github.io/devtools-protocol/tot/Network/>
