# Security and Data Handling

## 권한

현재 manifest는 다음 설치 시 필수 권한을 사용한다.

| 권한 | 목적 |
|---|---|
| `sidePanel` | XGEN Assistant UI |
| `storage` | 서버 설정과 origin별 XGEN token |
| `activeTab`, `scripting` | 사용자가 선택한 페이지의 Agent와 hook |
| `webNavigation` | SPA 및 페이지 이동 감지 |
| `contextMenus` | 사용자 주도 API 스캔 시작 |

강한 권한은 사용 시 선택적으로 요청한다.

| 선택 권한 | 요청 시점 | 범위 |
|---|---|---|
| `<all_urls>` 선언의 일부 origin | 해당 사이트에서 캡처 시작 | 현재 origin만 |
| `cookies` | live cookie 기반 auth 연결 | 별도 사용자 승인과 host 권한 필요 |

정적 `<all_urls>` content script와 필수 `cookies` 권한은 없다.
`web_accessible_resources.matches`의 `<all_urls>` 표시는 리소스 노출 대상
선언이며 host 접근 권한을 부여하지 않는다. 상세한 readiness, revoke 및
마이그레이션 정책은 [Optional Permissions 설계](design/optional-permissions.md)를
따른다.

## 신뢰 경계

- 대상 페이지의 DOM과 JavaScript는 신뢰할 수 없는 입력이다.
- 캡처된 request/response는 신뢰할 수 없는 업무 데이터다.
- XGEN에서 받은 page command도 허용된 action과 parameter schema를 검증해야 한다.
- extension storage는 비밀 저장소가 아니다.
- browser console과 test artifact에는 secret을 기록하지 않는다.

## 현재 방어

Collection 등록 전에 다음을 적용한다.

- request/query/body sample에서 authorization, cookie, password, secret, token, API key 계열 key redaction
- 평범한 key 아래의 이메일, 전화번호, 주민번호형 식별자, 긴 숫자 및 JWT 값 패턴 redaction
- 민감 query parameter 제외
- 문자열, 배열, 객체 key, depth 및 전체 JSON 크기 제한
- 최대 tool/edge 수 제한
- 선택된 tool 사이의 edge만 전송
- 관계 edge에는 실제 공유값 대신 source/target field path와 value type만 전송
- 실패 runtime log에서 token/cookie뿐 아니라 이메일, 전화번호와 12~19자리
  숫자 패턴도 redaction
- Playwright 실패 trace에는 verifier 소스 파일을 포함하지 않고, artifact probe가
  trace 압축 내부까지 synthetic secret/PII 원문을 검사
- 등록 화면에서 request/response sample 전송을 끄고 필드 구조만 등록 가능
- 탭별 raw capture FIFO 500건 제한, 세션 종료 후 탭 버퍼 삭제, 미소비 결과 5분 TTL
- host 권한 회수 시 main-world hook/relay 종료, tab buffer와 cached result 즉시 폐기
- XGEN origin 검증
- 캡처 시점 cookie 대신 실행 시점 live cookie 사용

HAR 파일은 브라우저 개발자 도구가 인증 헤더, 쿠키 및 응답 원문을 포함해
내보낼 수 있으므로 더 강한 입력 경계로 취급한다. 가져오는 즉시 URL userinfo,
민감 query key, Authorization/Cookie/Set-Cookie 계열 header와 파일 이름을
제거한다. JSON 구조만 bounded sample로 유지하며 임의 text와 binary body는
Collection payload에 넣지 않는다. 상세한 지원 범위와 제한은
[HAR 가져오기](har-import.md)를 따른다.

OpenAPI URL 가져오기는 브라우저가 문서를 직접 fetch하지 않고 인증된 XGEN
backend의 source resolver를 사용한다. 고객사 내부망 API를 지원하기 위해 XGEN
배포망에서 접근 가능한 private host도 대상이 될 수 있으므로, URL import 권한과
egress 정책은 XGEN 운영 경계에서 제한해야 한다. Pathfinder는 URL userinfo를
허용하지 않으며 파일 import는 5MB와 YAML alias 수를 제한한다. 자세한 흐름은
[OpenAPI 가져오기](openapi-import.md)를 따른다.

Postman Collection import는 variable, header, query, body, saved response와
script에 민감값이 있을 수 있다고 가정한다. importer는 원본 값을 저장하지 않고
request/response shape, parameter 이름과 auth 요구사항만 OpenAPI 3.1로
정규화한다. pre-request/test script는 실행하거나 전송하지 않는다. collection,
folder 및 request 표시 이름도 값 패턴 scrub을 거친다. 자세한 지원 범위는
[Postman 가져오기](postman-import.md)를 따른다.

GraphQL introspection import는 실행 endpoint와 schema JSON을 분리해서 받는다.
endpoint URL의 userinfo, fragment와 민감 query key를 거부하고, introspection
응답의 top-level error 원문은 전송 전에 제거한다. 실제 API 인증은 URL이나
schema에 포함하지 않고 XGEN Collection 인증 프로필에서 해석한다. 자세한 범위는
[GraphQL Introspection 가져오기](graphql-introspection-import.md)를 따른다.

## 남는 위험

캡처 세션 중에는 브라우저 요청과 응답 원문이 extension 메모리에 일시적으로 존재한다. 등록 payload를 정제하는 것만으로 캡처 단계의 노출 위험이 없어지는 것은 아니다. 세션 결과는 sidepanel이 소비할 때까지 또는 최대 5분 동안 메모리에 남을 수 있으므로 민감 화면에서는 캡처를 시작하지 않아야 한다.

키 이름이 평범한 업무 기밀은 정규식만으로 완전히 탐지할 수 없다. 값 패턴 scrub이 대표적인 개인정보 형식을 제거하지만 임의 고객번호, 주문번호 또는 도메인 고유 식별자는 분류할 수 없다. 이 경우 샘플 저장을 끄거나 고객사 deny field 정책을 적용해야 한다.

운영 적용 전 권장 보완:

- 고객사별 deny field 목록
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

2026-07-26 기준으로 build-only 의존성의 기존 5건을 다음 호환 버전으로 해소했다.

| 패키지 | 적용 버전 | 영향 |
|---|---:|---|
| `@crxjs/vite-plugin` | 2.7.1 | extension bundle 생성 시 사용하는 개발 의존성 |
| `vite` | 6.4.3 | 개발 서버와 production build용 개발 의존성 |
| `postcss` | 8.5.23 | CSS build용 개발 의존성 |
| `@babel/core` | 7.29.7 | React transform의 전이 개발 의존성 |
| `rollup` | 2.80.0 / 4.60.0 | CRXJS와 Vite의 전이 개발 의존성 |

런타임 확장 bundle에 package manager나 개발 서버가 포함되는 문제는 아니었지만, 공격자가 조작한 로컬 source/source map을 빌드하는 환경에서는 파일 접근 위험이 있었다. 업데이트 후 `npm audit` 결과는 0건이며 build, trace contract, Chromium runtime을 함께 회귀 검증한다.
