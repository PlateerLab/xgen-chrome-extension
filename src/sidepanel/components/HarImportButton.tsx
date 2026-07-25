import { useRef, useState } from 'react';
import type { SessionResult } from '../hooks/useCaptureSession';
import { importHarArchive } from '../lib/har-import';

const MAX_HAR_FILE_BYTES = 10 * 1024 * 1024;

interface Props {
  targetTabId?: number | null;
  disabled?: boolean;
  onImported: (result: SessionResult) => void;
  onError: (message: string) => void;
}

export function HarImportButton({
  targetTabId,
  disabled = false,
  onImported,
  onError,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);

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
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending || disabled}
        className={`p-1 rounded transition-colors ${
          pending || disabled
            ? 'text-gray-300 cursor-wait'
            : 'text-gray-400 hover:text-gray-600'
        }`}
        title={pending ? 'HAR 읽는 중' : disabled ? '캡처 중에는 가져올 수 없습니다' : 'HAR 파일 가져오기'}
        aria-label="HAR 파일 가져오기"
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
    </>
  );
}
