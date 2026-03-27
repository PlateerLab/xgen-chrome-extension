# XGEN Chrome Extension — Implementation Plan

## Overview

XGEN AI 어시스턴트를 Chrome Extension으로 구현.
데스크탑 앱(Tauri)의 AI CLI 기능을 브라우저에서 동일하게 제공한다.

백엔드는 xgen-workflow의 `/api/ai-chat/stream` 엔드포인트를 그대로 사용.

## 기존 구현 참고

### 데스크탑 앱 (Tauri) — 이미 동작 중
```
Tauri 앱
├── src-cli/cli.html          → Chrome Extension Side Panel UI로 변환
├── src-tauri/llm_client.rs   → 불필요 (백엔드 API가 LLM 호출)
├── src-tauri/tool_search.rs  → 불필요 (백엔드가 graph-tool-call 사용)
├── patch-canvas-chatbot.js   → Content Script의 canvas-bridge.ts로 변환
└── patch-sidebar-cli.js      → 불필요 (Extension 아이콘으로 접근)
```

### 웹 백엔드 (xgen-workflow feat/ai-chatbot) — 이미 구현됨
```
xgen-workflow/
├── controller/aiChatController.py   → POST /api/ai-chat/stream (SSE)
├── service/ai_chat/
│   ├── ai_chat_service.py           → LangGraph agent + gateway tools
│   └── canvas_tools.py              → canvas_* + navigate tools
└── controller/models/ai_chat.py     → AiChatRequest schema
```

## Design Decisions

### Side Panel vs Popup vs Content Script UI

| 방식 | 장점 | 단점 |
|------|------|------|
| **Side Panel** (선택) | XGEN 페이지와 나란히 표시, 지속적 | Chrome 114+ 필요 |
| Popup | 간단, 호환성 좋음 | 클릭하면 닫힘, 페이지와 동시에 안 보임 |
| Content Script UI | 페이지 내 임베딩 | XGEN CSS 충돌, 유지보수 어려움 |

**Side Panel 선택 이유**: 캔버스 편집하면서 AI 채팅을 동시에 볼 수 있어야 함.

### 캔버스 조작 방식

**데스크탑 앱**: Tauri IPC → canvasRef (같은 프로세스)
**Chrome Extension**: Content Script → XGEN 페이지의 canvasRef 접근

두 가지 방법:
1. **window 전역 변수 노출** — xgen-frontend 패치로 `window.__XGEN_CANVAS_REF__` 노출
2. **CustomEvent 브릿지** — Content Script ↔ XGEN 페이지 간 CustomEvent 통신

**2번 선택**: 프론트엔드 패치 최소화. Content Script가 CustomEvent를 발생시키면, xgen-frontend의 이벤트 핸들러가 canvasRef를 통해 실행.

```javascript
// Content Script → XGEN 페이지
window.dispatchEvent(new CustomEvent('xgen:canvas-command', {
    detail: { requestId, action: 'add_node', params: { node_type: 'agents/xgen' } }
}));

// XGEN 페이지 → Content Script
window.addEventListener('xgen:canvas-result', (e) => {
    const { requestId, result } = e.detail;
    // result를 background SW로 전달
});
```

이 이벤트 핸들러는 xgen-frontend의 `feat/ai-chatbot` 브랜치에서 캔버스 page.tsx에 추가하면 됨.
데스크탑 앱의 Tauri 이벤트(`canvas:command`)와 구조가 동일.

### 인증

XGEN 웹 페이지에 로그인하면 쿠키/localStorage에 access_token이 저장됨.
Content Script가 이 토큰을 읽어서 Background SW로 전달 → API 호출 시 Authorization 헤더에 포함.

```javascript
// Content Script
const token = localStorage.getItem('xgen_access_token')
    || document.cookie.match(/access_token=([^;]+)/)?.[1];
chrome.runtime.sendMessage({ type: 'SET_TOKEN', token });
```

## Implementation Phases

### Phase 1: MVP — 채팅 + API 호출 (Side Panel only)

**목표**: Side Panel에서 채팅, search_tools + call_tool 동작

파일:
```
manifest.json
src/background/service-worker.ts    — SSE 관리
src/sidepanel/index.html
src/sidepanel/App.tsx               — 채팅 UI (cli.html을 React로 변환)
src/sidepanel/hooks/useChat.ts      — 채팅 상태
src/sidepanel/hooks/useSSE.ts       — SSE 스트리밍 파싱
src/shared/types.ts
src/shared/api.ts                   — /api/ai-chat/stream 클라이언트
```

구현 순서:
1. manifest.json (side_panel, permissions)
2. Background service worker (SSE fetch + 메시지 라우팅)
3. Side Panel React 앱 (Vite + React)
4. 채팅 UI (cli.html 기반)
5. SSE 스트리밍 파싱 + 마크다운 렌더링
6. 인증 토큰 자동 추출

### Phase 2: 캔버스 조작 (Content Script)

**목표**: canvas_* tool이 실제 XGEN 캔버스를 조작

파일:
```
src/content/canvas-bridge.ts        — CustomEvent 브릿지
src/content/token-extractor.ts      — 인증 토큰 추출
```

구현 순서:
1. Content Script (canvas-bridge.ts)
2. CustomEvent 핸들러 등록
3. Background SW ↔ Content Script 메시지 중계
4. xgen-frontend에 CustomEvent 리스너 추가 (feat/ai-chatbot 브랜치)
5. 캔버스 조작 테스트

### Phase 3: UX 개선

- 마크다운 렌더링 개선
- 다크/라이트 모드
- 대화 히스토리 저장 (chrome.storage)
- 옵션 페이지 (서버 URL, 프로바이더, 모델)
- 키보드 단축키 (Ctrl+Shift+X로 Side Panel 토글)

### Phase 4: Chrome Web Store 배포

- 아이콘/스크린샷 제작
- Privacy policy
- Chrome Web Store 등록
- 자동 업데이트

## manifest.json 구조 (초안)

```json
{
  "manifest_version": 3,
  "name": "XGEN AI Assistant",
  "version": "0.1.0",
  "description": "자연어로 XGEN AI 플랫폼을 제어하는 AI 어시스턴트",
  "permissions": [
    "sidePanel",
    "storage",
    "activeTab"
  ],
  "host_permissions": [
    "https://xgen.x2bee.com/*"
  ],
  "side_panel": {
    "default_path": "sidepanel/index.html"
  },
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://xgen.x2bee.com/*"],
      "js": ["content/canvas-bridge.js", "content/token-extractor.js"]
    }
  ],
  "action": {
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    },
    "default_title": "XGEN AI Assistant"
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

## 메시지 흐름 상세

```
Side Panel                Background SW              Content Script          XGEN Page
    │                          │                          │                      │
    │── SEND_MESSAGE ─────────→│                          │                      │
    │                          │── fetch SSE ────────────────────────────────────→│ (백엔드)
    │                          │←─ token ─────────────────│                      │
    │                          │                          │                      │
    │←─ STREAM_TOKEN ──────────│←─ SSE: token ───────────────────────────────────│
    │←─ TOOL_START ────────────│←─ SSE: tool_start ──────────────────────────────│
    │                          │                          │                      │
    │                          │←─ SSE: canvas_command ──────────────────────────│
    │                          │── CANVAS_COMMAND ────────→│                      │
    │                          │                          │── CustomEvent ──────→│
    │                          │                          │←─ CustomEvent ───────│
    │                          │←─ CANVAS_RESULT ─────────│                      │
    │                          │── SSE continue ─────────────────────────────────→│
    │                          │                          │                      │
    │←─ STREAM_DONE ───────────│←─ SSE: done ────────────────────────────────────│
    │                          │                          │                      │
```

## 예상 일정

| Phase | 기간 | 산출물 |
|-------|------|--------|
| Phase 1 (MVP) | 3-5일 | Side Panel 채팅 + API 호출 동작 |
| Phase 2 (캔버스) | 2-3일 | Content Script 캔버스 조작 |
| Phase 3 (UX) | 2-3일 | 히스토리, 옵션, 단축키 |
| Phase 4 (배포) | 1-2일 | Chrome Web Store |
