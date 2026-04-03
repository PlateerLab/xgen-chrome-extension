// ── API Hook: 캡처된 API 요청 ──

export interface CapturedApi {
  id: string;
  tabId: number;
  timestamp: number;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  contentType: string;
  duration: number; // ms
}

// ── XGEN Tool 정의 (saveTool API 스키마) ──

export interface ToolContent {
  function_name: string;
  function_id: string;
  description: string;
  api_url: string;
  api_method: string;
  api_header: Record<string, string>;
  api_body: Record<string, unknown>;
  static_body: Record<string, unknown>;
  body_type: string;
  api_timeout: number;
  is_query_string: boolean;
  response_filter: boolean;
  html_parser: boolean;
  response_filter_path: string;
  response_filter_field: string;
  status: string;
  metadata: Record<string, unknown>;
}

export interface ToolSaveRequest {
  function_name: string;
  content: ToolContent;
  user_id?: number;
}
