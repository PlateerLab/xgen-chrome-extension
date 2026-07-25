# Pathfinder Roadmap

이 문서는 Pathfinder의 현재 작업 순서와 완료 기준을 정의하는 단일 기준이다. 고객사별 path, tool name 또는 field를 엔진 규칙에 하드코딩하지 않고, 모든 개선은 재현 가능한 fixture와 실환경 검증을 함께 남긴다.

## 상태 정의

- `done`: 코드, 문서 및 명시된 검증 gate가 모두 통과
- `in progress`: 구현 또는 검증이 진행 중
- `planned`: 선행 작업 이후 착수
- `research`: 지원 범위와 contract를 먼저 결정해야 함

## P0. Mainline Baseline

상태: `in progress`

목표: 캡처 안정화, 브라우저 runtime 검증 및 운영 문서를 `main` 기준선으로 만든다.

- [x] `feature/pathfinder-verification-and-stability`에서 build/trace/runtime 검증 구성
- [x] dev/stg 및 prefix/suffix 형태 XGEN origin 인식
- [x] 개발, 검증, XGEN 연동, 고객사 환경 및 보안 문서
- [x] 기존 `docs/PLAN.md`를 historical 문서로 표시
- [ ] feature 전체를 `main`으로 반영하는 통합 PR
- [ ] `main` 머지 후 깨끗한 checkout에서 전체 검증

완료 gate:

```bash
npm ci
npx playwright install --with-deps chromium
npm run verify:pathfinder
```

## P1. Verification Automation

상태: `in progress`

목표: PR마다 정적 contract와 실제 Chromium extension runtime을 자동 검증하고, 실패 원인을 재현할 artifact를 남긴다.

- [x] GitHub Actions T0 build/trace/contract job
- [x] GitHub Actions T1 Chromium runtime job
- [x] 실패 시 Playwright trace, screenshot 및 runtime log 업로드
- [x] extension client와 runtime mock의 XGEN endpoint 계약 검사
- [x] 실제 XGEN dev T2 smoke를 opt-in script로 분리
- [x] PR workflow에서 secret을 참조하지 않도록 분리
- [ ] main 대상 통합 PR에서 T0/T1 green 확인

완료 gate:

- 새 runner에서 `npm ci`부터 사람 개입 없이 통과
- PR의 T0/T1 required check가 green
- 의도적으로 만든 runtime 실패에서 artifact 다운로드 가능
- T2는 token 원문을 출력하지 않고 health/provider/auth capability를 진단

## P2. Security and Privacy

상태: `done`

목표: 브라우저에서 관찰한 원본 payload가 Collection, 로그 및 test artifact에 민감값으로 남지 않게 한다.

- [x] `sampleSharedValue` 원문을 field path/type evidence로 교체
- [x] 이메일, 전화번호, 계정번호 및 identifier 값 패턴 scrub
- [x] request/response sample 저장 비활성화 옵션
- [x] 캡처 종료·탭 종료 시 원본 payload 메모리 폐기와 TTL 검증
- [x] `<all_urls>`와 `cookies` optional permission 전환 가능성 및 마이그레이션 설계
- [x] optional permission 전환과 거부/persisted grant/revoke runtime test
- [x] npm audit 5건의 runtime 영향 분석, 호환 업데이트 및 0건 확인

완료 gate:

- sanitizer fixture에 secret/PII 원문이 없음
- 등록 payload와 실패 artifact secret scan 통과
- 권한을 거부해도 핵심 UI가 구조화된 readiness 상태를 표시
- dependency 변경 후 T0/T1 회귀 통과

## P3. Capture Quality

상태: `done`

목표: 어떤 고객사 API가 들어오더라도 관찰 가능한 contract를 최대한 정확하게 복원하고 불확실성을 표시한다.

- [x] GraphQL operation, query 및 variables 인식
- [x] multipart/form-data 및 file upload contract
- [x] nested request/response와 response envelope
- [x] path parameter와 identifier 오탐 감소
- [x] 동일 operation의 schema variation 보존 및 중복 병합
- [x] iframe, Web Worker, Service Worker 및 streaming 요청의 관찰 범위 조사
- [x] 도구별 coverage, confidence 및 evidence 표시

완료 gate:

- REST/GraphQL/multipart fixture corpus
- 같은 입력 trace에서 deterministic artifact
- schema variation 손실 없이 중복 tool 감소
- 미지원 transport는 조용히 누락하지 않고 coverage issue로 표시

## P4. XGEN Integration

상태: `planned`

목표: 캡처한 API가 실제 XGEN에서 Collection build, 검색, plan 및 read-only 실행까지 이어지는 것을 검증한다.

- [ ] capture → Collection create/merge dev 검증
- [ ] auth profile 자동 연결과 갱신
- [ ] graph build status 추적
- [ ] readiness, semantic summary 및 edge quality 표시
- [ ] Quality Lab search/plan/read-only execute
- [ ] backend capability와 extension contract 버전 진단

완료 gate:

- 고객사형 dev 페이지에서 캡처한 tool이 XGEN search Top-K에 진입
- 선택된 tool로 plan 생성
- 로그인 사용자 auth context로 read-only execute 성공
- 실패는 auth, contract, search, plan 및 HTTP stage로 구분

## P5. Universal Inputs

상태: `in progress`

목표: 브라우저 runtime trace만으로 충분하지 않은 환경도 같은 Collection artifact로 수렴시킨다.

- [x] privacy-safe HAR 1.2 import
- [x] OpenAPI/Swagger URL 및 JSON/YAML file import
- [ ] GraphQL introspection
- [ ] Postman Collection
- [ ] MCP tool catalog
- [ ] 수동 contract 작성 및 수정 UI

모든 importer가 만들어야 하는 공통 결과:

- normalized operation identity
- request/response contract
- auth and context requirements
- semantic metadata and evidence
- provenance and source version
- readiness issues

## 운영 원칙

- T0/T1은 모든 PR에서 실행한다.
- T2는 dev 배포 후 또는 nightly로 실행한다.
- 고객사 acceptance는 내부망 runner와 전용 read-only 계정을 사용한다.
- write API는 allowlist, 명시적 승인 및 cleanup이 없으면 실행하지 않는다.
- 품질 개선은 fixture와 측정값 없이 완료로 표시하지 않는다.
- `main` 반영 후 ROADMAP 상태를 같은 PR에서 갱신한다.
