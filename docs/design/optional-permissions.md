# Optional Permissions Design

## 결정

현재의 `<all_urls>` host permission과 `cookies` permission은 이번 보안 변경에서 바로 제거하지 않는다. 정적 content script, background cookie 조회, 페이지 이동 후 재주입이 모두 이 권한에 의존하므로 manifest만 축소하면 캡처와 인증 프로필 연결이 조용히 실패한다.

대신 다음 릴리즈에서 사용자 승인 기반 권한 모델로 전환할 수 있도록 구현 경계를 고정한다.

## 목표 권한 모델

설치 시 필수 권한:

- `sidePanel`
- `storage`
- `activeTab`
- `scripting`
- `webNavigation`
- `contextMenus`

사용 시 선택 권한:

- `optional_host_permissions: ["<all_urls>"]`
- `optional_permissions: ["cookies"]`

host 권한은 사용자가 특정 사이트에서 캡처를 시작할 때 해당 origin 단위로 요청한다. `cookies`는 auth profile 자동 연결을 켤 때 별도로 요청한다. 권한 거부는 예외나 빈 결과가 아니라 `host_permission_required` 또는 `cookie_permission_required` readiness로 표시한다.

## 필요한 코드 변경

1. `chrome.permissions.contains()` 결과를 반환하는 capability service를 background에 둔다.
2. 캡처 시작 버튼의 사용자 gesture 안에서 현재 tab origin 권한을 요청한다.
3. 정적 `<all_urls>` content script를 제거하고 승인된 origin에 `chrome.scripting.registerContentScripts()` 또는 명시적 `executeScript()`로 relay를 주입한다.
4. 페이지 이동 후에는 새 origin 권한을 다시 확인하고, 없으면 자동 재주입하지 않는다.
5. cookie 조회 전에 `cookies`와 대상 host 권한을 모두 확인한다.
6. 권한 revoke 이벤트에서 등록된 script, tab buffer 및 auth capability cache를 폐기한다.

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

Chromium runtime test에는 최초 허용, 거부, revoke, navigation 후 재승인 시나리오를 넣는다. 이 행렬이 통과하기 전에는 manifest의 필수 권한을 줄이지 않는다.
