# Optional Permissions Design

## 결정

고객 사이트용 `<all_urls>` host permission과 `cookies` permission을 설치 시
필수 권한에서 제거했다. XGEN 제어 페이지의 기존 로그인 세션을 안정적으로
연결하기 위한 공식 prod/dev origin만 필수 host permission으로 한정하고,
그 밖의 권한은 기능을 사용하는 시점에 최소 범위로 요청한다.

## 목표 권한 모델

설치 시 필수 권한:

- `sidePanel`
- `storage`
- `activeTab`
- `scripting`
- `webNavigation`
- `contextMenus`
- `https://xgen.x2bee.com/*`
- `https://dev-xgen.x2bee.com/*`

사용 시 선택 권한:

- `optional_host_permissions: ["<all_urls>"]`
- `optional_permissions: ["cookies"]`

XGEN 두 origin의 host 권한은 로그인 쿠키를 페이지 context에서 읽고 현재
환경을 판별하는 데만 사용한다. 고객 사이트 host 권한은 사용자가 특정
사이트에서 캡처를 시작할 때 해당 origin 단위로 요청한다. `cookies`는 외부
API의 live cookie 기반 auth 연결에 필요하며 host 권한과 별도로 확인한다.
권한 거부는 빈 결과가 아니라
`host_permission_required` 또는 `cookie_permission_required` readiness로
표시한다.

## 구현

1. `chrome.permissions.contains()` 기반 readiness를 background와 sidepanel이
   동일하게 사용한다.
2. 캡처 시작 버튼의 사용자 gesture 안에서 현재 origin 권한을 요청한다.
3. 정적 content script 선언 대신 승인된 탭에
   `chrome.scripting.executeScript()`로 versioned bundle을 주입한다.
4. 페이지 이동 시 새 origin 권한을 확인하고, 없으면 hook을 재주입하지 않는다.
5. cookie 조회 전에 `cookies`와 대상 host 권한을 모두 확인한다.
6. 권한 회수 시 탭별로 기억한 origin pattern을 검사해 main-world hook과
   isolated relay를 중지하고 raw buffer, cached result, auth cache를 폐기한다.
7. extension action의 `activeTab`은 sidepanel/PageAgent를 여는 단발성 경로에만
   사용하며, 지속 캡처 권한의 대체물로 저장하지 않는다.
8. 주입된 탭의 origin pattern은 `chrome.storage.session`에도 보존해 MV3 Service
   Worker가 재시작된 뒤 발생한 revoke 이벤트도 기존 hook을 정리할 수 있게 한다.

## 마이그레이션

- 기존 설치가 업데이트될 때 이미 승인된 권한을 `chrome.permissions.contains()`로 읽는다.
- 강한 권한을 가진 이전 버전과 선택 권한 버전이 동일 storage를 공유해도 동작하도록 permission 상태를 저장된 설정의 진실 원천으로 사용하지 않는다.
- 권한 요청은 캡처 시작 또는 auth 연결처럼 사용자가 원인을 이해할 수 있는 시점에만 띄운다.
- 고객사 관리형 배포는 Chrome enterprise policy로 승인 origin을 선배포할 수 있게 문서화한다.

## 검증 행렬

| host | cookies | 기대 결과 |
|---|---|---|
| 허용 | 허용 | 캡처와 auth profile 자동 연결 |
| 허용 | 거부 | 캡처 가능, auth 연결은 readiness failure |
| 거부 | 허용 | 페이지 hook 차단, 캡처 시작 안 함 |
| 거부 | 거부 | sidepanel 문서/설정 UI만 동작 |
| 실행 중 revoke | 무관 | hook 해제, raw buffer 폐기, 구조화된 중단 |

T0는 source/dist manifest에 필수 `cookies`, 정적 `content_scripts`, 허용 목록
밖의 필수 host permission이 없는지와 동적 bundle 생성을 검사한다. T1 Chromium
runtime은 선택 권한이 전혀 없는 새 프로필에서 XGEN 세션 감지, 브라우저에
저장된 고객 사이트 승인 상태, 캡처/쿠키 사용,
실행 중 revoke와 payload 폐기를 검사한다.

headless Chromium은 사용자 승인 모달을 자동 수락할 수 없으므로 최초 승인과
회수 후 재승인 버튼은 릴리즈 후보의 수동 브라우저 체크리스트로도 확인한다.
CI의 승인 상태는 실제 Chrome profile의 persisted extension permission과 같은
형태로 부팅해 재현한다.
