import { useState } from 'react';
import type { CapturedApi, ToolSaveRequest, ToolContent } from '../../shared/api-hook-types';
import type { ExtensionMessage } from '../../shared/types';

interface Props {
  api: CapturedApi;
  onClose: () => void;
}

function deriveBodyType(contentType: string): string {
  if (contentType.includes('json')) return 'application/json';
  if (contentType.includes('xml')) return 'application/xml';
  if (contentType.includes('form-urlencoded')) return 'application/x-www-form-urlencoded';
  if (contentType.includes('multipart')) return 'multipart/form-data';
  if (contentType.includes('text/plain')) return 'text/plain';
  return 'application/json';
}

function parseBodySchema(body: string | null): Record<string, unknown> {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    // 값에서 타입 스키마 추론
    const schema: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      schema[key] = {
        type: typeof value,
        description: '',
        example: value,
      };
    }
    return schema;
  } catch {
    return {};
  }
}

function generateFunctionId(): string {
  return `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function ToolDefinitionForm({ api, onClose }: Props) {
  const reqContentType = api.requestHeaders['content-type'] || api.contentType || 'application/json';

  const [form, setForm] = useState<ToolContent>({
    function_name: '',
    function_id: generateFunctionId(),
    description: '',
    api_url: api.url,
    api_method: api.method,
    api_header: { ...api.requestHeaders },
    api_body: parseBodySchema(api.requestBody),
    static_body: {},
    body_type: deriveBodyType(reqContentType),
    api_timeout: 30,
    is_query_string: api.method === 'GET',
    response_filter: false,
    html_parser: false,
    response_filter_path: '',
    response_filter_field: '',
    status: 'active',
    metadata: {},
  });

  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [serverUrl, setServerUrl] = useState('');

  // XGEN 서버 URL 로드
  useState(() => {
    chrome.storage.local.get('serverUrl', (data) => {
      setServerUrl(data.serverUrl || '');
    });
  });

  function updateField<K extends keyof ToolContent>(key: K, value: ToolContent[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!form.function_name.trim()) {
      setResult({ success: false, error: 'Tool 이름을 입력해주세요' });
      return;
    }

    if (!serverUrl) {
      setResult({ success: false, error: 'XGEN 서버에 먼저 접속해주세요' });
      return;
    }

    setSaving(true);
    setResult(null);

    const tool: ToolSaveRequest = {
      function_name: form.function_name,
      content: form,
    };

    // 결과 리스너
    const listener = (message: ExtensionMessage) => {
      if (message.type === 'SAVE_TOOL_RESULT') {
        setResult({ success: message.success, error: message.error });
        setSaving(false);
        chrome.runtime.onMessage.removeListener(listener);
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.runtime.sendMessage({
      type: 'SAVE_TOOL',
      tool,
      serverUrl,
    } satisfies ExtensionMessage);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">
          &larr; Back
        </button>
        <span className="text-xs font-medium text-gray-700">XGEN Tool 변환</span>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {/* function_name */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">Tool 이름 *</label>
          <input
            type="text"
            value={form.function_name}
            onChange={(e) => updateField('function_name', e.target.value)}
            placeholder="예: get_user_info"
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded focus:outline-none focus:border-blue-300"
          />
        </div>

        {/* description */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">설명</label>
          <textarea
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            placeholder="이 도구가 하는 일을 설명해주세요"
            rows={2}
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded focus:outline-none focus:border-blue-300 resize-none"
          />
        </div>

        {/* api_url */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">API URL</label>
          <input
            type="text"
            value={form.api_url}
            onChange={(e) => updateField('api_url', e.target.value)}
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded focus:outline-none focus:border-blue-300 font-mono"
          />
        </div>

        {/* method + body_type */}
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-[11px] text-gray-500 block mb-1">Method</label>
            <select
              value={form.api_method}
              onChange={(e) => updateField('api_method', e.target.value)}
              className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded"
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="text-[11px] text-gray-500 block mb-1">Body Type</label>
            <select
              value={form.body_type}
              onChange={(e) => updateField('body_type', e.target.value)}
              className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded"
            >
              {[
                'application/json',
                'application/x-www-form-urlencoded',
                'multipart/form-data',
                'text/plain',
                'url-params',
              ].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>

        {/* api_header */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">Headers (JSON)</label>
          <textarea
            value={JSON.stringify(form.api_header, null, 2)}
            onChange={(e) => {
              try { updateField('api_header', JSON.parse(e.target.value)); } catch {}
            }}
            rows={3}
            className="w-full text-[10px] px-2 py-1.5 border border-gray-200 rounded focus:outline-none focus:border-blue-300 font-mono resize-none"
          />
        </div>

        {/* api_body */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">Body Schema (JSON)</label>
          <textarea
            value={JSON.stringify(form.api_body, null, 2)}
            onChange={(e) => {
              try { updateField('api_body', JSON.parse(e.target.value)); } catch {}
            }}
            rows={4}
            className="w-full text-[10px] px-2 py-1.5 border border-gray-200 rounded focus:outline-none focus:border-blue-300 font-mono resize-none"
          />
        </div>

        {/* timeout + options */}
        <div className="flex gap-2 items-center">
          <div>
            <label className="text-[11px] text-gray-500 block mb-1">Timeout(s)</label>
            <input
              type="number"
              value={form.api_timeout}
              onChange={(e) => updateField('api_timeout', Number(e.target.value))}
              className="w-16 text-xs px-2 py-1.5 border border-gray-200 rounded"
            />
          </div>
          <label className="flex items-center gap-1 text-[11px] text-gray-500 mt-4">
            <input
              type="checkbox"
              checked={form.is_query_string}
              onChange={(e) => updateField('is_query_string', e.target.checked)}
            />
            Query String
          </label>
          <label className="flex items-center gap-1 text-[11px] text-gray-500 mt-4">
            <input
              type="checkbox"
              checked={form.response_filter}
              onChange={(e) => updateField('response_filter', e.target.checked)}
            />
            Response Filter
          </label>
        </div>

        {/* XGEN Server */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">XGEN Server URL</label>
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://jeju-xgen.x2bee.com"
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded focus:outline-none focus:border-blue-300 font-mono"
          />
        </div>

        {/* Result */}
        {result && (
          <div className={`text-xs px-2 py-1.5 rounded ${result.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {result.success ? 'Tool 등록 완료!' : `오류: ${result.error}`}
          </div>
        )}
      </div>

      {/* Save button */}
      <div className="px-3 py-2 border-t border-gray-200">
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full text-xs py-2 bg-blue-500 text-white rounded font-medium hover:bg-blue-600 transition-colors disabled:opacity-50"
        >
          {saving ? '저장 중...' : 'XGEN에 등록'}
        </button>
      </div>
    </div>
  );
}
