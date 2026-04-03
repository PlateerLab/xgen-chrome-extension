import { useState } from 'react';
import { useApiMonitor } from '../hooks/useApiMonitor';
import { ApiDetailPanel } from './ApiDetailPanel';
import { ToolDefinitionForm } from './ToolDefinitionForm';
import type { CapturedApi } from '../../shared/api-hook-types';

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-green-100 text-green-700',
  POST: 'bg-blue-100 text-blue-700',
  PUT: 'bg-orange-100 text-orange-700',
  PATCH: 'bg-yellow-100 text-yellow-700',
  DELETE: 'bg-red-100 text-red-700',
};

export function ApiMonitor() {
  const {
    capturedApis,
    allCount,
    isCapturing,
    filter,
    setFilter,
    startCapture,
    stopCapture,
    clearCaptured,
  } = useApiMonitor();

  const [selectedApi, setSelectedApi] = useState<CapturedApi | null>(null);
  const [toolFormApi, setToolFormApi] = useState<CapturedApi | null>(null);

  function shortenUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  }

  if (toolFormApi) {
    return (
      <ToolDefinitionForm
        api={toolFormApi}
        onClose={() => setToolFormApi(null)}
      />
    );
  }

  if (selectedApi) {
    return (
      <ApiDetailPanel
        api={selectedApi}
        onBack={() => setSelectedApi(null)}
        onConvert={() => {
          setToolFormApi(selectedApi);
          setSelectedApi(null);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="px-3 py-2 border-b border-gray-200 space-y-2">
        <div className="flex items-center gap-2">
          <button
            onClick={isCapturing ? stopCapture : startCapture}
            className={`text-xs px-3 py-1 rounded font-medium transition-colors ${
              isCapturing
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-blue-500 text-white hover:bg-blue-600'
            }`}
          >
            {isCapturing ? 'Stop' : 'Start'}
          </button>
          <button
            onClick={clearCaptured}
            className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-500 hover:text-gray-700 hover:border-gray-400 transition-colors"
          >
            Clear
          </button>
          <span className="text-[11px] text-gray-400 ml-auto">
            {capturedApis.length}/{allCount}
          </span>
        </div>

        {/* Filters */}
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="URL 필터"
            value={filter.url}
            onChange={(e) => setFilter({ ...filter, url: e.target.value })}
            className="flex-1 text-xs px-2 py-1 border border-gray-200 rounded focus:outline-none focus:border-blue-300"
          />
          <select
            value={filter.method}
            onChange={(e) => setFilter({ ...filter, method: e.target.value })}
            className="text-xs px-2 py-1 border border-gray-200 rounded focus:outline-none focus:border-blue-300"
          >
            <option value="">ALL</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
          </select>
        </div>
      </div>

      {/* API List */}
      <div className="flex-1 overflow-y-auto">
        {capturedApis.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-300 text-sm gap-1">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>{isCapturing ? '요청 대기 중...' : 'Start를 눌러 캡처 시작'}</span>
          </div>
        )}

        {capturedApis.map((api) => (
          <button
            key={api.id}
            onClick={() => setSelectedApi(api)}
            className="w-full text-left px-3 py-2 border-b border-gray-100 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${METHOD_COLORS[api.method] || 'bg-gray-100 text-gray-600'}`}>
                {api.method}
              </span>
              <span className={`text-[11px] font-mono ${api.responseStatus >= 400 ? 'text-red-500' : 'text-gray-400'}`}>
                {api.responseStatus}
              </span>
              <span className="text-[11px] text-gray-500 truncate flex-1">
                {shortenUrl(api.url)}
              </span>
              <span className="text-[10px] text-gray-300">
                {api.duration}ms
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
