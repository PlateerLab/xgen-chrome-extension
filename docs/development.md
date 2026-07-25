# Development

## 요구 환경

- Node.js 22 LTS
- npm 10 이상
- Chrome 114 이상
- Linux CI에서는 Playwright bundled Chromium
- headed browser 실행 시 Xvfb

## 설치

```bash
git clone https://github.com/PlateerLab/xgen-chrome-extension.git
cd xgen-chrome-extension
npm ci
npx playwright install --with-deps chromium
npm run build
```

`npm ci`는 `package-lock.json`에 고정된 의존성을 사용한다. `npm install`은 의존성을 변경할 때만 사용한다.

## Chrome에 개발 빌드 설치

1. `npm run build`를 실행한다.
2. Chrome에서 `chrome://extensions`를 연다.
3. 개발자 모드를 켠다.
4. `압축해제된 확장 프로그램을 로드합니다`를 선택한다.
5. 저장소의 `dist/` 디렉터리를 선택한다.

소스 변경을 계속 빌드하려면 다음 명령을 사용한다.

```bash
npm run dev
```

Vite watch가 새 `dist/`를 만들면 `chrome://extensions`에서 Pathfinder를 다시 로드한다. Service Worker나 manifest 변경은 반드시 확장 재로드가 필요하다.

## 주요 명령

| 명령 | 목적 |
|---|---|
| `npm run dev` | TypeScript/Vite watch build |
| `npm run build` | typecheck 및 production build |
| `npm run verify:pathfinder:trace` | trace 분석·정규화·등록 계약 검증 |
| `npm run verify:pathfinder:runtime` | Chromium에 실제 확장을 로드한 runtime 검증 |
| `npm run verify:pathfinder` | build, trace, runtime 전체 검증 |

## 개발 구조

```text
src/
  background/       Manifest V3 Service Worker
  content/          Content Script, Page Agent, API hook relay
  shared/           API client, 타입 및 상수
  sidepanel/        React UI, 캡처 분석 및 등록
scripts/
  verify-all.mjs
  verify-pathfinder.mjs
  verify-runtime.mjs
docs/
```

## 변경 시 검증 기준

- trace 분석 변경: trace verification 필수
- Service Worker, Content Script, Side Panel 변경: runtime verification 필수
- XGEN endpoint 또는 payload 변경: mock 계약과 실제 dev integration 모두 확인
- 권한 또는 host permission 변경: [보안 문서](security.md) 갱신
- 고객사 인증 흐름 변경: 내부망 acceptance test 갱신

