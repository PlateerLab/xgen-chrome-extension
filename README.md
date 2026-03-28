# XGEN AI Assistant — Chrome Extension

브라우저에서 자연어로 XGEN AI 플랫폼을 제어하는 Chrome Extension.

## 핵심 기능

### 1. 멀티스텝 페이지 네비게이션
AI가 여러 페이지를 연속으로 이동하며 작업을 수행합니다.
- "도구 관리 페이지 열어줘" → 사용자 관리 클릭 → 도구 관리 클릭 (자동 경로 탐색)
- 매 스텝마다 실제 DOM 상태를 AI에게 피드백하여 정확한 다음 액션 결정
- 최대 15스텝 연속 실행 가능

### 2. 메뉴 사전탐색
접힌 사이드바 메뉴를 자동으로 스캔하여 AI에게 전체 네비게이션 구조를 제공합니다.
```
[메뉴 구조]
워크플로우 > [워크플로우 소개, 워크플로우 캔버스, 워크플로우 관리, 실행도구, ...]
지식관리 > [지식컬렉션]
채팅하기 > [채팅 소개, 새 채팅, 현재 채팅, 기존 채팅 불러오기]
```
- XGEN CSS 모듈 패턴(`sidebarToggle` / `navItem`) 자동 인식
- `aria-expanded` 기반 표준 메뉴도 지원
- `nav > ul > li` 범용 패턴 폴백

### 3. Tool Result Feedback Loop
기존 fire-and-forget 방식을 양방향 결과 피드백으로 교체했습니다.
```
Before: AI → "클릭 성공" (거짓) → AI 눈 감고 진행
After:  AI → SSE page_command → 프론트엔드 실행 → DOM 재스캔 → POST /command-result → AI가 실제 결과 확인
```
- `PageCommandBridge`: asyncio 기반 요청-응답 브릿지
- `POST /api/ai-chat/command-result/{requestId}`: 콜백 엔드포인트
- AI가 실패를 감지하고 대안을 제시 가능

### 4. Smart Wait (DOM 안정화 대기)
고정 300ms 대기 → MutationObserver 기반 DOM 안정화 감지로 교체.
- DOM 변경이 300ms간 없으면 안정 판단
- 최대 5초 타임아웃 (애니메이션 페이지 대응)
- SPA 네비게이션, AJAX 로딩 등에 자동 적응

### 5. 확장된 뷰포트 스캔
`viewportExpansion: 0 → 3`으로 변경하여 화면 밖 요소도 AI가 인식합니다.
- 뷰포트 ±3배 범위의 DOM 요소 포함
- 스크롤 없이도 아래쪽 목록 항목 클릭 가능

### 6. 수동 ReAct 에이전트 루프
LangGraph `create_react_agent`를 수동 ReAct 루프로 교체하여 전체 제어권 확보.
- LLM 스트리밍 → tool_calls 감지 → 도구별 분기 처리
- page_command: SSE emit → 프론트엔드 결과 대기 → ToolMessage에 새 DOM 포함
- canvas_command: fire-and-forget (기존 유지)
- gateway tools: 로컬 실행 + tool_start/tool_end SSE

### 7. 자연어 API 제어 + 캔버스 조작
- **API 검색/호출**: "워크플로우 목록 보여줘", "LLM 상태 확인"
- **캔버스 노드 관리**: "RAG 노드 추가해줘", "두 노드 연결해줘"
- **문서 인덱싱**: 컬렉션 생성, 파일 업로드, 인덱싱 실행

### 8. 토큰 사용량 모니터링
매 대화마다 LLM 토큰 사용량을 실시간 표시합니다.
- 입력 토큰 / 출력 토큰 / 합계
- 각 AI 응답 하단에 표시

### 9. 기타
- **멀티 인스턴스 지원**: origin별 JWT 토큰 관리 (xgen.x2bee.com / jeju-xgen.x2bee.com 동시 사용)
- **컨텍스트 연속성**: 대화 요약 자동 생성 + DOM 재스캔 + canvas state 캐싱
- **실시간 스트리밍**: SSE 기반 LLM 응답 + 마크다운 렌더링
- **다크/라이트 모드**: 시스템 설정 연동

## 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│  Chrome Browser                                              │
│                                                              │
│  ┌─────────────────────┐   ┌─────────────────────────────┐  │
│  │  XGEN 웹 페이지      │   │  Extension Side Panel        │  │
│  │                      │   │  (React 채팅 UI)             │  │
│  │  Content Script:     │   │                              │  │
│  │  - PageAgent         │←→│  토큰 사용량 표시             │  │
│  │  - GenericHandler    │   │  도구 호출 뱃지              │  │
│  │  - 메뉴 사전탐색     │   │  마크다운 렌더링             │  │
│  └──────────┬──────────┘   └──────────────┬──────────────┘  │
│             │                              │                 │
│  ┌──────────┴──────────────────────────────┴──────────────┐  │
│  │  Background Service Worker                              │  │
│  │  - SSE 스트리밍 관리                                     │  │
│  │  - PAGE_COMMAND_RESULT → POST /command-result (결과 피드백)│
│  │  - 멀티 인스턴스 토큰 관리                               │  │
│  └────────────────────────┬───────────────────────────────┘  │
└───────────────────────────┼──────────────────────────────────┘
                            │ HTTPS (SSE)
              ┌─────────────┴─────────────┐
              │  xgen-workflow (백엔드)     │
              │  수동 ReAct 루프           │
              │  PageCommandBridge         │
              │  POST /command-result      │
              └───────────────────────────┘
```

### 데이터 흐름

```
1. 사용자 입력 → Side Panel
2. Background SW → Content Script에서 page_context + menuMap 수집
3. Background SW → POST /api/ai-chat/stream (SSE)
4. 백엔드 ReAct 루프:
   ┌─ LLM 호출 → tool_calls 감지
   │  ├─ page_command → SSE emit → 프론트엔드 실행 → POST /command-result → 결과 대기
   │  ├─ canvas_command → SSE emit (fire-and-forget)
   │  └─ gateway tool → 로컬 실행 → tool_start/tool_end SSE
   └─ tool_calls 없으면 → 최종 응답 + token_usage SSE → done
5. Side Panel: 토큰 스트리밍 + 도구 호출 표시 + 토큰 사용량
```

## 기술 스택

| 영역 | 기술 |
|------|------|
| Extension | Manifest V3, TypeScript, React, Vite, Tailwind CSS |
| DOM 조작 | @page-agent/page-controller (alibaba/page-agent) |
| 백엔드 | Python, FastAPI, LangChain, LangGraph |
| API 엔진 | graph-tool-call (OpenAPI → LLM 도구 자동 생성) |
| 통신 | SSE (서버→클라이언트), HTTP POST (결과 콜백) |

## 설치

### 릴리즈 설치
1. [Releases](https://github.com/PlateerLab/xgen-chrome-extension/releases)에서 zip 다운로드
2. 압축 해제
3. Chrome → `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → 폴더 선택

### 개발 환경
```bash
git clone https://github.com/PlateerLab/xgen-chrome-extension.git
cd xgen-chrome-extension
npm install
npm run dev
# chrome://extensions → Load unpacked → dist/
```

## 설정

Extension 사이드 패널에서 설정:
- **LLM Provider**: Anthropic / OpenAI / Google / Bedrock / vLLM
- **Model**: claude-sonnet-4-20250514, gpt-4o, gemini-2.0-flash 등

인증 토큰은 XGEN 웹 페이지 로그인 시 자동 추출됩니다.

## 관련 프로젝트

| 프로젝트 | 역할 |
|---------|------|
| [xgen-workflow](https://gitlab.x2bee.com/xgen2.0/xgen-workflow) | AI 챗봇 백엔드 (ReAct 루프, PageCommandBridge) |
| [xgen-frontend](https://gitlab.x2bee.com/xgen2.0/xgen-frontend) | XGEN 웹 UI (canvas_command 핸들러) |
| [graph-tool-call](https://github.com/SonAIengine/graph-tool-call) | API 검색/실행 엔진 |

## License

MIT
