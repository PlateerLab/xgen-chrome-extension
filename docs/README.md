# Pathfinder Documentation

이 문서는 XGEN Pathfinder Chrome Extension의 개발, 검증, XGEN 연동 및 고객사 환경 적용을 위한 기준 문서다.

## 시작하기

| 목적 | 문서 |
|---|---|
| 현재 우선순위와 완료 기준 확인 | [로드맵](ROADMAP.md) |
| 로컬에서 빌드하고 Chrome에 설치 | [개발 환경](development.md) |
| 구조와 데이터 흐름 이해 | [아키텍처](architecture.md) |
| 확장 내부 메시지 계약 확인 | [메시지 프로토콜](message-protocol.md) |
| 자동 검증 실행 및 결과 해석 | [검증 가이드](verification.md) |
| XGEN API와 API Collection 연동 | [XGEN 연동](xgen-integration.md) |
| 고객사 내부망에서 설치 및 검증 | [고객사 환경](customer-environment.md) |
| 권한, 인증정보, 캡처 데이터 보호 | [보안](security.md) |
| 강한 권한을 선택 권한으로 전환하는 설계 | [Optional Permissions](design/optional-permissions.md) |
| 설치 및 테스트 실패 해결 | [문제 해결](troubleshooting.md) |

초기 구현 과정은 [Historical Implementation Plan](PLAN.md)에 보존되어 있으며 현재 TODO로 사용하지 않는다.

## 문서 원칙

- 현재 코드에서 확인되는 동작과 향후 제안을 구분한다.
- mock 검증 결과를 실제 XGEN 통합 성공으로 표현하지 않는다.
- 인증 토큰, 쿠키, API key 및 개인정보 예시는 실제 값을 사용하지 않는다.
- 고객사별 예외를 라이브러리나 확장 프로그램의 범용 규칙으로 하드코딩하지 않는다.
- 코드와 문서의 명령이 달라지면 같은 변경에서 함께 갱신한다.

## 지원 범위

Pathfinder는 브라우저에서 발생하는 HTTP 요청을 관찰하고 정규화해 XGEN API Collection의 입력으로 전달한다. XGEN은 등록된 도구의 graph build, 검색, plan synthesis 및 실행을 담당한다.

Pathfinder가 자동으로 보장하지 않는 항목:

- 고객사 API의 업무적 의미와 데이터 정합성
- MFA, CAPTCHA 및 사용자 개입이 필요한 SSO
- 고객사 VPN, DNS, 방화벽 및 사설 인증서 설정
- mutating API 실행 후 데이터 원복
- XGEN backend 버전과 extension API 계약의 자동 호환
