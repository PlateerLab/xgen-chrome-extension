import { useRef, useState } from 'react';
import {
  prepareGraphQLIntrospectionFile,
  type PreparedGraphQLSource,
} from '../lib/graphql-introspection';
import { OpenApiImportPanel } from './OpenApiImportPanel';

interface Props {
  targetTabId?: number | null;
  onDismiss: () => void;
}

function sourceWarnings(source: PreparedGraphQLSource): string[] {
  const summary = source.summary;
  return [
    `실행 endpoint: ${source.endpointUrl}`,
    `query ${summary.queryCount}개 · mutation ${summary.mutationCount}개`
      + ` · subscription ${summary.subscriptionCount}개 · type ${summary.typeCount}개`,
    ...(summary.omittedErrorCount
      ? [`introspection error ${summary.omittedErrorCount}개의 원문을 제거했습니다.`]
      : []),
    ...(summary.subscriptionCount
      ? ['subscription은 streaming adapter가 없어 등록 대상에서 제외됩니다.']
      : []),
  ];
}

export function GraphQLImportPanel({ targetTabId, onDismiss }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [endpointUrl, setEndpointUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [prepared, setPrepared] = useState<PreparedGraphQLSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = async (selected: File | null = file) => {
    if (!selected) {
      setError('GraphQL introspection JSON 파일을 선택해주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await prepareGraphQLIntrospectionFile(selected, endpointUrl);
      setPrepared(result);
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
        key={`${prepared.endpointUrl}-${prepared.sourceName}`}
        targetTabId={targetTabId}
        initialSource={prepared}
        heading="GraphQL Introspection 등록"
        formatHint="graphql-introspection"
        endpointUrl={prepared.endpointUrl}
        requiredCapabilities={['input_schema', 'output_schema']}
        collectionTags={['pathfinder', 'graphql']}
        collectionDescription="Pathfinder GraphQL introspection import"
        sourceKindLabel="GraphQL introspection"
        sourceWarnings={sourceWarnings(prepared)}
        onEditSource={() => {
          setPrepared(null);
          setError(null);
        }}
        onDismiss={onDismiss}
      />
    );
  }

  return (
    <div
      className="border-b border-gray-200 bg-gray-50 px-3 py-2"
      data-testid="graphql-import-panel"
      aria-busy={busy}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-gray-700">
            GraphQL Introspection
          </div>
          <div className="text-[9px] text-gray-400">
            schema JSON과 실행 endpoint를 분리해 등록합니다.
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

      <label className="mb-1 block text-[10px] font-medium text-gray-700">
        GraphQL 실행 endpoint
      </label>
      <input
        type="url"
        value={endpointUrl}
        disabled={busy}
        onChange={(event) => {
          setEndpointUrl(event.target.value);
          setPrepared(null);
        }}
        placeholder="https://api.example.com/graphql"
        className="mb-2 w-full border border-gray-200 bg-white px-2 py-1.5 text-[10px] outline-none focus:border-blue-400"
        data-testid="graphql-endpoint-input"
      />

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
          {fileName || '20MB 이하 표준 introspection 응답'}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          data-testid="graphql-file-input"
          onChange={(event) => {
            const selected = event.target.files?.[0] || null;
            if (!selected) return;
            setFile(selected);
            setFileName(selected.name);
            void analyze(selected);
            if (fileRef.current) fileRef.current.value = '';
          }}
        />
      </div>

      {error && (
        <div className="mb-2 bg-red-50 px-2 py-1.5 text-[10px] text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] leading-4 text-gray-400">
          인증값은 endpoint URL에 넣지 않습니다. 실행 시 Collection 인증 프로필을 사용합니다.
        </span>
        <button
          type="button"
          disabled={busy || !file}
          onClick={() => void analyze()}
          className="flex-none border border-gray-300 bg-white px-2 py-1.5 text-[10px] text-gray-700 hover:bg-gray-50 disabled:text-gray-300"
        >
          {busy ? '분석 중...' : '다시 분석'}
        </button>
      </div>
    </div>
  );
}
