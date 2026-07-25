# Troubleshooting

## Playwright를 찾을 수 없음

증상:

```text
Cannot find module 'playwright'
```

해결:

```bash
npm ci
```

Playwright는 프로젝트 dev dependency로 설치되어야 한다. 다른 저장소의 `node_modules`에 의존하지 않는다.

## Playwright Chromium이 없음

증상:

```text
Playwright Chromium is not installed
```

해결:

```bash
npx playwright install --with-deps chromium
```

## extension ID 또는 Service Worker 탐지 실패

1. `npm run build`로 `dist/manifest.json`이 생성됐는지 확인한다.
2. Playwright와 browser revision이 맞는지 확인한다.
3. `DEBUG=pw:browser npm run verify:pathfinder:runtime`으로 실행한다.
4. Chromium 실행 인자에 `--load-extension`과 `--disable-extensions-except`가 있는지 확인한다.
5. `chrome://extensions`에서 manifest error를 확인한다.

runtime harness는 Playwright Service Worker event가 늦거나 누락되는 경우 CDP target polling을 사용한다.

## Linux에서 브라우저가 시작되지 않음

기본 headless runtime에는 Xvfb가 필요하지 않다. headed 진단 시:

```bash
sudo apt-get install -y xvfb
xvfb-run -a npm run verify:pathfinder:runtime
```

추가 로그:

```bash
DEBUG=pw:browser npm run verify:pathfinder:runtime
```

## Side Panel에서 XGEN 로그인을 요구함

- XGEN 탭에서 먼저 로그인한다.
- 설정의 Server URL이 현재 XGEN origin인지 확인한다.
- `dev-xgen`, `stg-xgen` 등 환경별 host가 XGEN origin 규칙에 포함되는지 확인한다.
- httpOnly cookie 이름이 지원 목록과 일치하는지 확인한다.
- Chrome DevTools의 Extension Service Worker console에서 token lookup error를 확인한다.

토큰 원문을 issue나 로그에 첨부하지 않는다.

## 캡처 결과가 없음

- 캡처를 시작한 탭과 실제 조작한 탭이 같은지 확인한다.
- 페이지를 새로고침해 Content Script와 main-world hook을 다시 주입한다.
- 요청이 fetch/XHR인지 확인한다.
- 브라우저 extension error를 확인한다.
- 캡처 시작 전에 발생한 요청은 포함되지 않는다.
- Pathfinder 자체가 실행한 AI 요청은 사용자 API 캡처에서 제외될 수 있다.

## SPA 이동 후 캡처가 중단됨

- runtime verification의 navigation reinjection 시나리오를 실행한다.
- `webNavigation` event와 Content Script reinjection log를 확인한다.
- 대상 앱이 iframe 안에서 API를 호출하는지 확인한다.
- cross-origin iframe이면 해당 frame과 host permission을 별도로 검토한다.

## Collection 생성은 되지만 merge가 실패함

- XGEN backend의 from-trace merge route를 확인한다.
- extension의 `src/shared/api.ts`와 runtime mock route가 같은지 확인한다.
- Collection ID URL encoding을 확인한다.
- 401/403이면 XGEN 인증, 409이면 충돌 payload, 422이면 request schema를 확인한다.

## 고객사 환경에서만 실패함

- VPN, proxy, DNS 및 사설 CA를 먼저 확인한다.
- 같은 Chromium profile에서 대상 페이지와 XGEN이 모두 열리는지 확인한다.
- SSO session이 third-party cookie 정책의 영향을 받는지 확인한다.
- 개발자 도구가 정책으로 차단되어 있다면 내부 runner에서 Playwright artifact를 수집한다.
- 고객사 실제 secret이나 응답 body를 외부 issue tracker에 올리지 않는다.

