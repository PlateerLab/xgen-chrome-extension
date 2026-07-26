import { useRef, useState } from 'react';
import {
  preparePostmanFile,
  type PreparedPostmanSource,
} from '../lib/postman-import';
import { OpenApiImportPanel } from './OpenApiImportPanel';

interface Props {
  targetTabId?: number | null;
  onDismiss: () => void;
}

const fieldClass = 'border border-gray-200 bg-white px-2 py-1.5 text-[10px] outline-none focus:border-blue-400';

function sourceWarnings(source: PreparedPostmanSource): string[] {
  const summary = source.summary;
  return [
    `Postman v${summary.collectionVersion} · request ${summary.totalRequests}개`
      + ` · operation ${summary.importedOperations}개`
      + (summary.mergedVariants ? ` · variant 병합 ${summary.mergedVariants}개` : ''),
    ...summary.issues.slice(0, 5).map((issue) => `${issue.code}: ${issue.message}`),
  ];
}

export function PostmanImportPanel({ targetTabId, onDismiss }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [baseUrlOverride, setBaseUrlOverride] = useState('');
  const [prepared, setPrepared] = useState<PreparedPostmanSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = async (selected: File | null = file) => {
    if (!selected) {
      setError('Postman Collection JSON 파일을 선택해주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await preparePostmanFile(selected, {
        baseUrlOverride: baseUrlOverride.trim() || undefined,
      });
      setPrepared(result);
      setFile(null);
    } catch (analysisError) {
      setPrepared(null);
      setError(analysisError instanceof Error ? analysisError.message : String(analysisError));
    } finally {
      setBusy(false);
    }
  };

  if (prepared) {
    return (
      <OpenApiImportPanel
        key={`${prepared.name}-${prepared.summary.importedOperations}`}
        targetTabId={targetTabId}
        initialSource={prepared}
        heading="Postman Collection 등록"
        sourceWarnings={sourceWarnings(prepared)}
        onEditSource={() => {
          setPrepared(null);
          setError('다시 분석하려면 Postman 파일을 선택해주세요.');
        }}
        onDismiss={onDismiss}
      />
    );
  }

  return (
    <div
      className="border-b border-gray-200 bg-gray-50 px-3 py-2"
      data-testid="postman-import-panel"
      aria-busy={busy}
    >
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-medium text-gray-700">Postman Collection</div>
          <div className="text-[9px] text-gray-400">
            v2.0/v2.1 HTTP Collection을 schema-only OpenAPI로 변환합니다.
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="text-[10px] text-gray-400 hover:text-gray-600 disabled:text-gray-300"
        >
          닫기
        </button>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="border border-gray-300 bg-white px-2 py-1.5 text-[10px] text-gray-700 hover:bg-gray-50 disabled:text-gray-300"
        >
          JSON 파일 선택
        </button>
        <span className="min-w-0 flex-1 truncate text-[10px] text-gray-500">
          {fileName || '10MB 이하 Postman Collection'}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          data-testid="postman-file-input"
          onChange={(event) => {
            const selected = event.target.files?.[0] || null;
            if (!selected) return;
            setFile(selected);
            setFileName(selected.name);
            setPrepared(null);
            void analyze(selected);
            if (fileRef.current) fileRef.current.value = '';
          }}
        />
      </div>

      <div className="mb-2">
        <label className="mb-1 block text-[10px] font-medium text-gray-700">
          Base URL 보완
        </label>
        <div className="flex gap-1.5">
          <input
            type="url"
            value={baseUrlOverride}
            onChange={(event) => setBaseUrlOverride(event.target.value)}
            placeholder="https://api.example.com (host 변수가 해석되지 않을 때)"
            className={`${fieldClass} min-w-0 flex-1`}
            data-testid="postman-base-url-input"
          />
          <button
            type="button"
            disabled={busy || !file}
            onClick={() => void analyze()}
            className="border border-gray-300 bg-white px-2 py-1.5 text-[10px] text-gray-700 hover:bg-gray-50 disabled:text-gray-300"
          >
            {busy ? '분석 중...' : '다시 분석'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-2 bg-red-50 px-2 py-1.5 text-[10px] text-red-700">
          {error}
        </div>
      )}

      <div className="text-[9px] leading-4 text-gray-400">
        variable, header, body, saved response의 실제 값과 pre-request/test script는
        XGEN으로 전송하지 않습니다. host 변수만 해석되지 않으면 Base URL을 입력합니다.
      </div>
    </div>
  );
}
