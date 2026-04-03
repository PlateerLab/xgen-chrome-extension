import { useState } from 'react';
import type { CapturedApi } from '../../shared/api-hook-types';

interface Props {
  api: CapturedApi;
  onBack: () => void;
  onConvert: () => void;
}

function JsonBlock({ label, data }: { label: string; data: string | null | Record<string, string> }) {
  const [open, setOpen] = useState(false);
  if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) return null;

  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  return (
    <div className="border-t border-gray-100">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-500 hover:bg-gray-50 flex items-center gap-1"
      >
        <span className="text-[10px]">{open ? '\u25BC' : '\u25B6'}</span>
        {label}
      </button>
      {open && (
        <pre className="px-3 pb-2 text-[10px] font-mono text-gray-600 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
          {tryFormatJson(text)}
        </pre>
      )}
    </div>
  );
}

function tryFormatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-green-100 text-green-700',
  POST: 'bg-blue-100 text-blue-700',
  PUT: 'bg-orange-100 text-orange-700',
  PATCH: 'bg-yellow-100 text-yellow-700',
  DELETE: 'bg-red-100 text-red-700',
};

export function ApiDetailPanel({ api, onBack, onConvert }: Props) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
        <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600">
          &larr; Back
        </button>
        <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${METHOD_COLORS[api.method] || 'bg-gray-100 text-gray-600'}`}>
          {api.method}
        </span>
        <span className={`text-[11px] font-mono ${api.responseStatus >= 400 ? 'text-red-500' : 'text-gray-500'}`}>
          {api.responseStatus}
        </span>
        <span className="text-[10px] text-gray-300 ml-auto">{api.duration}ms</span>
      </div>

      {/* URL */}
      <div className="px-3 py-2 border-b border-gray-100">
        <p className="text-[11px] font-mono text-gray-600 break-all">{api.url}</p>
        <p className="text-[10px] text-gray-300 mt-1">
          {new Date(api.timestamp).toLocaleTimeString()}
        </p>
      </div>

      {/* Sections */}
      <div className="flex-1 overflow-y-auto">
        <JsonBlock label="Request Headers" data={api.requestHeaders} />
        <JsonBlock label="Request Body" data={api.requestBody} />
        <JsonBlock label="Response Headers" data={api.responseHeaders} />
        <JsonBlock label="Response Body" data={api.responseBody} />
      </div>

      {/* Convert button */}
      <div className="px-3 py-2 border-t border-gray-200">
        <button
          onClick={onConvert}
          className="w-full text-xs py-2 bg-blue-500 text-white rounded font-medium hover:bg-blue-600 transition-colors"
        >
          XGEN Tool로 변환
        </button>
      </div>
    </div>
  );
}
