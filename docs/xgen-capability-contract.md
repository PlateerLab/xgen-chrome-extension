# XGEN Capability Contract

Pathfinder는 XGEN의 API Collection 기능을 호출하기 전에 다음 read-only
manifest를 조회한다.

```text
GET /api/tools/api-collections/capabilities
```

현재 Pathfinder client contract version은 `1`이다. manifest에는 다음 정보만
포함되며 token, cookie, 사용자 ID, auth profile 설정값은 포함하지 않는다.

- contract name/version과 지원 client version 범위
- `graph-tool-call` package version
- API Collection 기능별 지원 여부
- 기능별 method/path

## 판정

| 상태 | 의미 | 동작 |
|---|---|---|
| `compatible` | client version과 필수 기능이 모두 맞음 | 실행 |
| `compatible_with_warnings` | 필수 기능은 있고 일부 선택 기능이 없음 | 실행, 기능별 경고 |
| `legacy_unverified` | capability endpoint가 없는 구버전 XGEN | 안전한 GET probe 후 기존 동작 유지 |
| `authentication_required` | manifest 또는 legacy probe가 401/403 | 로그인 안내, 실행 중단 |
| `backend_outdated` | 필수 기능 누락 또는 backend client 상한 초과 | XGEN 업데이트 안내 |
| `extension_outdated` | XGEN이 요구하는 client version보다 낮음 | Pathfinder 업데이트 안내 |
| `invalid_manifest` | manifest schema가 계약과 다름 | 실행 중단 |
| `unavailable` | 서버에 연결할 수 없음 | 연결 상태 확인 |

구버전 fallback은 Collection 목록, provider, auth profile, MCP session과 같은
read-only endpoint만 호출한다. 호환성 확인을 위해 Collection을 생성하거나
source를 추가하지 않는다.

## 필수 기능

캡처 결과를 Collection으로 등록할 때 다음 기능이 필수다.

- `trace_collection_import`
- `collection_build_status`

검색, plan, execute, Quality Lab 및 auth profile은 desired capability로 진단한다.
필수 기능이 있으면 등록을 허용하되, 누락된 후속 기능은 설정 화면에서
구조화된 경고로 표시한다.

실제 endpoint가 401/403/404/405를 반환한 경우에도 API client는 이를 일반
HTTP 오류로 숨기지 않고 로그인 필요 또는 해당 capability 미지원으로
분류한다.
