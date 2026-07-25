import { useRef, useState } from 'react';
import type { SessionResult } from '../hooks/useCaptureSession';
import { importHarArchive } from '../lib/har-import';

const MAX_HAR_FILE_BYTES = 10 * 1024 * 1024;

interface Props {
  targetTabId?: number | null;
  disabled?: boolean;
  onOpenApiRequested: () => void;
  onGraphQLRequested: () => void;
  onManualRequested: () => void;
  onPostmanRequested: () => void;
  onImported: (result: SessionResult) => void;
  onError: (message: string) => void;
}

export function SourceImportButton({
  targetTabId,
  disabled = false,
  onOpenApiRequested,
  onGraphQLRequested,
  onManualRequested,
  onPostmanRequested,
  onImported,
  onError,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setPending(true);
    try {
      if (file.size > MAX_HAR_FILE_BYTES) {
        throw new Error('HAR 파일은 10MB 이하여야 합니다.');
      }
      const source = JSON.parse(await file.text()) as unknown;
      const imported = importHarArchive(source, targetTabId ?? 0);
      const first = Math.min(...imported.apis.map((api) => api.timestamp));
      const last = Math.max(...imported.apis.map((api) => api.timestamp + api.duration));
      onImported({
        apis: imported.apis,
        tabId: targetTabId ?? 0,
        durationMs: Math.max(0, last - first),
        source: 'har',
        sourceName: file.name,
        importSummary: imported.summary,
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        disabled={pending || disabled}
        className={`p-1 rounded transition-colors ${
          pending || disabled
            ? 'text-gray-300 cursor-wait'
            : 'text-gray-400 hover:text-gray-600'
        }`}
        title={pending ? 'HAR 읽는 중' : disabled ? '캡처 중에는 가져올 수 없습니다' : '소스 가져오기'}
        aria-label="소스 가져오기"
      >
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </button>
      {menuOpen && !disabled && (
        <div className="absolute left-0 top-full z-40 mt-1 w-44 rounded border border-gray-200 bg-white p-1 shadow-lg">
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
            onClick={() => {
              setMenuOpen(false);
              inputRef.current?.click();
            }}
          >
            HAR 파일
            <span className="mt-0.5 block text-[9px] text-gray-400">
              관찰된 HTTP 요청 가져오기
            </span>
          </button>
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
            onClick={() => {
              setMenuOpen(false);
              onOpenApiRequested();
            }}
          >
            OpenAPI
            <span className="mt-0.5 block text-[9px] text-gray-400">
              URL 또는 JSON/YAML 파일
            </span>
          </button>
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
            onClick={() => {
              setMenuOpen(false);
              onGraphQLRequested();
            }}
          >
            GraphQL Introspection
            <span className="mt-0.5 block text-[9px] text-gray-400">
              schema JSON과 실행 endpoint
            </span>
          </button>
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
            onClick={() => {
              setMenuOpen(false);
              onManualRequested();
            }}
          >
            수동 Tool Contract
            <span className="mt-0.5 block text-[9px] text-gray-400">
              endpoint와 request/response schema 작성
            </span>
          </button>
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
            onClick={() => {
              setMenuOpen(false);
              onPostmanRequested();
            }}
          >
            Postman Collection
            <span className="mt-0.5 block text-[9px] text-gray-400">
              v2.0/v2.1 JSON을 schema-only로 변환
            </span>
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        data-testid="har-import-input"
        type="file"
        accept=".har,application/json"
        className="hidden"
        onChange={(event) => {
          void handleFile(event.target.files?.[0]);
        }}
      />
    </div>
  );
}
