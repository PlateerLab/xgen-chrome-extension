# Security and Data Handling

## 권한

현재 manifest는 다음 주요 권한을 사용한다.

| 권한 | 목적 |
|---|---|
| `sidePanel` | XGEN Assistant UI |
| `storage` | 서버 설정과 origin별 XGEN token |
| `activeTab`, `scripting` | 사용자가 선택한 페이지의 Agent와 hook |
| `webNavigation` | SPA 및 페이지 이동 감지 |
| `contextMenus` | 사용자 주도 API 스캔 시작 |
| `cookies` | XGEN token 및 대상 host live cookie 해석 |
| `<all_urls>` | 다양한 고객사 host에서 API 관찰 |

`<all_urls>`와 `cookies`는 강한 권한이다. 배포 전에 조직 보안 검토를 받아야 하며, 캡처는 사용자 동작으로 시작하고 현재 대상 탭으로 제한해야 한다.

## 신뢰 경계

- 대상 페이지의 DOM과 JavaScript는 신뢰할 수 없는 입력이다.
- 캡처된 request/response는 신뢰할 수 없는 업무 데이터다.
- XGEN에서 받은 page command도 허용된 action과 parameter schema를 검증해야 한다.
- extension storage는 비밀 저장소가 아니다.
- browser console과 test artifact에는 secret을 기록하지 않는다.

## 현재 방어

Collection 등록 전에 다음을 적용한다.

- request/query/body sample에서 authorization, cookie, password, secret, token, API key 계열 key redaction
- 민감 query parameter 제외
- 문자열, 배열, 객체 key, depth 및 전체 JSON 크기 제한
- 최대 tool/edge 수 제한
- 선택된 tool 사이의 edge만 전송
- XGEN origin 검증
- 캡처 시점 cookie 대신 실행 시점 live cookie 사용

## 남는 위험

캡처 세션 중에는 브라우저 요청과 응답 원문이 extension 메모리에 일시적으로 존재한다. 등록 payload를 정제하는 것만으로 캡처 단계의 노출 위험이 없어지는 것은 아니다. 민감 화면에서는 캡처를 시작하지 않고, 세션 종료 시 원본을 즉시 폐기해야 한다.

관계 edge의 `sampleSharedValue`는 현재 길이만 제한된다. 민감한 실제 값 대신 field path, type 또는 hash 기반 evidence로 교체하기 전까지 해당 값을 로그나 장기 저장소에 남기지 않아야 한다.

키 이름이 평범한 개인정보나 업무 기밀은 정규식만으로 완전히 탐지할 수 없다. 예를 들어 `value`, `data`, `name` 아래의 주민번호나 전화번호는 schema와 값 패턴 검사가 추가로 필요하다.

운영 적용 전 권장 보완:

- 이메일, 전화번호, 계좌 및 식별번호 패턴 scrub
- 고객사별 deny field 목록
- request/response sample 저장 비활성화 옵션
- 캡처 payload 사용자 미리보기와 필드별 제외
- 보존 기간과 삭제 정책
- audit event에 값이 아닌 field path만 기록

## 로그 정책

허용:

- host, method, templated path
- field name과 value type
- redacted/truncated 여부
- tool/edge 수
- stage와 reason code
- header name

금지:

- Authorization 값
- Cookie header 값
- API key와 refresh token
- 사용자 ID 원문
- 이메일, 전화번호 및 업무 payload 원문
- Playwright persistent profile

## 취약점 관리

```bash
npm audit
npm outdated
```

자동 `npm audit fix --force`는 사용하지 않는다. dependency major 변경은 build, trace verification 및 browser runtime을 모두 통과한 뒤 반영한다.
