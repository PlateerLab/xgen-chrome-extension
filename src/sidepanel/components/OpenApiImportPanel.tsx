import { useEffect, useRef, useState } from 'react';
import {
  addOpenApiSource,
  createApiCollection,
  deleteApiCollection,
  listApiCollections,
  previewOpenApiSource,
  type ApiCollectionSummary,
  type OpenApiPreviewResult,
} from '../../shared/api';
import type { ExtensionMessage } from '../../shared/types';
import {
  openApiSlug,
  prepareOpenApiFile,
  prepareOpenApiUrl,
  type PreparedOpenApiSource,
} from '../lib/openapi-import';

interface Props {
  targetTabId?: number | null;
  onDismiss: () => void;
}

interface XgenConfig {
  serverUrl: string;
  authToken: string;
}

type SourceMode = 'url' | 'file';
type TargetMode = 'new' | 'existing';

function tabTarget(tabId: number | null | undefined): { tabId?: number } {
  return typeof tabId === 'number' ? { tabId } : {};
}

async function getXgenConfig(targetTabId?: number | null): Promise<XgenConfig> {
  const config = await chrome.runtime.sendMessage({
    type: 'GET_CHAT_CONFIG',
    ...tabTarget(targetTabId),
  } satisfies ExtensionMessage);
  if (!config?.serverUrl) throw new Error('XGEN 서버 URL이 설정되지 않았습니다.');
  return {
    serverUrl: config.serverUrl,
    authToken: config.authToken ?? '',
  };
}

function previewIssues(preview: OpenApiPreviewResult): Array<{
  severity?: string;
  code?: string;
  message?: string;
}> {
  return [
    ...(preview.ingest_result?.issues || []),
    ...(preview.readiness_report?.issues || []),
  ];
}

export function OpenApiImportPanel({ targetTabId, onDismiss }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>('url');
  const [targetMode, setTargetMode] = useState<TargetMode>('new');
  const [sourceUrl, setSourceUrl] = useState('');
  const [prepared, setPrepared] = useState<PreparedOpenApiSource | null>(null);
  const [sourceLabel, setSourceLabel] = useState('openapi');
  const [collectionId, setCollectionId] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [existingId, setExistingId] = useState('');
  const [collections, setCollections] = useState<ApiCollectionSummary[]>([]);
  const [preview, setPreview] = useState<OpenApiPreviewResult | null>(null);
  const [busy, setBusy] = useState<'loading' | 'preview' | 'import' | null>('loading');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    collectionId: string;
    toolCount: number;
  } | null>(null);

  useEffect(() => {
    getXgenConfig(targetTabId)
      .then((config) => listApiCollections(config.serverUrl, config.authToken))
      .then((items) => {
        setCollections(items);
        if (items[0]?.collection_id) setExistingId(items[0].collection_id);
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => setBusy(null));
  }, [targetTabId]);

  const applyIdentity = (source: PreparedOpenApiSource) => {
    const id = openApiSlug(source.host || source.name, 'openapi-collection');
    setPrepared(source);
    setCollectionId(id);
    setCollectionName(source.name || id);
    setSourceLabel(openApiSlug(source.name, 'openapi').slice(0, 100));
    setPreview(null);
    setSuccess(null);
    setError(null);
  };

  const currentTargetId = targetMode === 'existing' ? existingId : undefined;

  const prepareCurrentSource = async (): Promise<PreparedOpenApiSource> => {
    if (sourceMode === 'file') {
      if (!prepared?.spec) throw new Error('OpenAPI JSON/YAML 파일을 선택해주세요.');
      return prepared;
    }
    const source = prepareOpenApiUrl(sourceUrl);
    if (prepared?.sourceUrl !== source.sourceUrl) applyIdentity(source);
    return source;
  };

  const handlePreview = async () => {
    setBusy('preview');
    setError(null);
    setSuccess(null);
    try {
      const source = await prepareCurrentSource();
      const config = await getXgenConfig(targetTabId);
      const result = await previewOpenApiSource(
        config.serverUrl,
        config.authToken,
        source,
        {
          targetCollectionId: currentTargetId,
          label: sourceLabel || 'openapi',
        },
      );
      setPreview(result);
    } catch (previewError) {
      setPreview(null);
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    setBusy('import');
    setError(null);
    try {
      const source = await prepareCurrentSource();
      const config = await getXgenConfig(targetTabId);
      const targetId = targetMode === 'existing' ? existingId : collectionId.trim();
      if (!targetId) throw new Error('대상 Collection을 선택하거나 ID를 입력해주세요.');
      if (
        targetMode === 'new'
        && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(targetId)
      ) {
        throw new Error(
          'Collection ID는 영문 또는 숫자로 시작하고 영문, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.',
        );
      }
      if (!sourceLabel.trim()) throw new Error('source label을 입력해주세요.');

      let created = false;
      if (targetMode === 'new') {
        if (!collectionName.trim()) throw new Error('Collection 이름을 입력해주세요.');
        let authProfileId: string | undefined;
        if (source.host) {
          const lookup = await chrome.runtime.sendMessage({
            type: 'LOOKUP_AUTH_PROFILE_FOR_HOST',
            host: source.host,
            ...tabTarget(targetTabId),
          } satisfies ExtensionMessage).catch(() => null);
          if (lookup?.ok && typeof lookup.authProfileId === 'string') {
            authProfileId = lookup.authProfileId;
          }
        }
        await createApiCollection(config.serverUrl, config.authToken, {
          collectionId: targetId,
          name: collectionName.trim(),
          description: 'Pathfinder OpenAPI import',
          baseUrl: source.baseUrl,
          authProfileId,
          domainPatterns: source.host ? [source.host] : [],
        });
        created = true;
      }

      try {
        const result = await addOpenApiSource(
          config.serverUrl,
          config.authToken,
          targetId,
          {
            ...source,
            label: sourceLabel.trim(),
          },
        );
        setSuccess({
          collectionId: targetId,
          toolCount: Number(result.tool_count ?? preview?.incoming_tool_count ?? 0),
        });
        if (targetMode === 'new') {
          setCollections((items) => [
            ...items,
            {
              collection_id: targetId,
              name: collectionName.trim(),
              tool_count: Number(result.tool_count ?? 0),
            },
          ]);
        }
      } catch (sourceError) {
        if (created) {
          try {
            await deleteApiCollection(config.serverUrl, config.authToken, targetId);
          } catch (cleanupError) {
            throw new Error(
              `${sourceError instanceof Error ? sourceError.message : String(sourceError)} `
              + `(빈 Collection ${targetId} 자동 정리 실패: `
              + `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; `
              + 'XGEN에서 수동 삭제가 필요합니다.)',
            );
          }
        }
        throw sourceError;
      }
    } catch (importError) {
      setSuccess(null);
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setBusy(null);
    }
  };

  const issues = preview ? previewIssues(preview) : [];
  const readiness = preview?.readiness_report?.summary;
  const canImport = Boolean(preview?.ingest_supported && preview?.ingest_result?.ready);
  const importLocked = busy === 'import';

  return (
    <div
      className="border-b border-gray-200 bg-gray-50 px-3 py-2"
      data-testid="openapi-import-panel"
      aria-busy={Boolean(busy)}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium text-gray-700">OpenAPI 가져오기</span>
        <button
          type="button"
          disabled={importLocked}
          onClick={onDismiss}
          className="text-[10px] text-gray-400 hover:text-gray-600 disabled:text-gray-300"
        >
          닫기
        </button>
      </div>

      <div className="mb-2 flex gap-1">
        {(['url', 'file'] as SourceMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={importLocked}
            onClick={() => {
              setSourceMode(mode);
              setPreview(null);
              setError(null);
            }}
            className={`px-2 py-1 text-[10px] ${
              sourceMode === mode
                ? 'bg-gray-800 text-white'
                : 'border border-gray-200 bg-white text-gray-600'
            }`}
          >
            {mode === 'url' ? 'URL' : 'JSON/YAML 파일'}
          </button>
        ))}
      </div>

      {sourceMode === 'url' ? (
        <input
          type="url"
          disabled={importLocked}
          value={sourceUrl}
          onChange={(event) => {
            setSourceUrl(event.target.value);
            setPrepared(null);
            setPreview(null);
          }}
          placeholder="https://service.example/openapi.json 또는 Swagger UI URL"
          className="mb-2 w-full border border-gray-200 bg-white px-2 py-1.5 text-[11px] outline-none focus:border-blue-400"
          data-testid="openapi-url-input"
        />
      ) : (
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            disabled={importLocked}
            onClick={() => fileRef.current?.click()}
            className="border border-gray-300 bg-white px-2 py-1 text-[10px] text-gray-700 hover:bg-gray-50"
          >
            파일 선택
          </button>
          <span className="min-w-0 flex-1 truncate text-[10px] text-gray-500">
            {prepared?.spec ? prepared.name : '5MB 이하 OpenAPI/Swagger 문서'}
          </span>
          <input
            ref={fileRef}
            type="file"
            disabled={importLocked}
            accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
            className="hidden"
            data-testid="openapi-file-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setBusy('loading');
              prepareOpenApiFile(file)
                .then(applyIdentity)
                .catch((fileError) => {
                  setPrepared(null);
                  setPreview(null);
                  setError(fileError instanceof Error ? fileError.message : String(fileError));
                })
                .finally(() => {
                  setBusy(null);
                  if (fileRef.current) fileRef.current.value = '';
                });
            }}
          />
        </div>
      )}

      <div className="mb-2 flex gap-1">
        {(['new', 'existing'] as TargetMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={
              importLocked
              || (mode === 'existing' && collections.length === 0)
            }
            onClick={() => {
              setTargetMode(mode);
              setPreview(null);
              setSuccess(null);
            }}
            className={`px-2 py-1 text-[10px] disabled:text-gray-300 ${
              targetMode === mode
                ? 'bg-gray-800 text-white'
                : 'border border-gray-200 bg-white text-gray-600'
            }`}
          >
            {mode === 'new' ? '새 Collection' : '기존 Collection'}
          </button>
        ))}
      </div>

      {targetMode === 'new' ? (
        <div className="mb-2 grid grid-cols-2 gap-1.5">
          <input
            value={collectionId}
            disabled={importLocked}
            onChange={(event) => setCollectionId(event.target.value)}
            placeholder="collection-id"
            maxLength={100}
            className="border border-gray-200 bg-white px-2 py-1.5 text-[10px] outline-none focus:border-blue-400"
          />
          <input
            value={collectionName}
            disabled={importLocked}
            onChange={(event) => setCollectionName(event.target.value)}
            placeholder="Collection 이름"
            maxLength={200}
            className="border border-gray-200 bg-white px-2 py-1.5 text-[10px] outline-none focus:border-blue-400"
          />
        </div>
      ) : (
        <select
          value={existingId}
          disabled={importLocked}
          onChange={(event) => {
            setExistingId(event.target.value);
            setPreview(null);
          }}
          className="mb-2 w-full border border-gray-200 bg-white px-2 py-1.5 text-[10px]"
        >
          {collections.map((collection) => (
            <option key={collection.collection_id} value={collection.collection_id}>
              {collection.name} ({collection.tool_count ?? 0})
            </option>
          ))}
        </select>
      )}

      <div className="mb-2 flex items-center gap-1.5">
        <input
          value={sourceLabel}
          disabled={importLocked}
          onChange={(event) => {
            setSourceLabel(event.target.value);
            setPreview(null);
          }}
          placeholder="source label"
          maxLength={100}
          className="min-w-0 flex-1 border border-gray-200 bg-white px-2 py-1.5 text-[10px] outline-none focus:border-blue-400"
        />
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void handlePreview()}
          className="border border-gray-300 bg-white px-2 py-1.5 text-[10px] text-gray-700 hover:bg-gray-50 disabled:text-gray-300"
        >
          {busy === 'preview' ? '분석 중...' : '미리보기'}
        </button>
      </div>

      {preview && (
        <div className="mb-2 border-l-2 border-blue-400 bg-white px-2 py-1.5 text-[10px] text-gray-600">
          <div className="font-medium text-gray-700">
            도구 {preview.incoming_tool_count}개
            {' · '}엣지 +{preview.edges_added}
            {readiness?.readiness_score != null
              && ` · 준비도 ${readiness.readiness_score}`}
            {readiness?.status && ` (${readiness.status})`}
          </div>
          <div className="mt-0.5">
            adapter {preview.ingest_result?.adapter || 'unknown'}
            {preview.conflicts.length > 0 && ` · 이름 충돌 ${preview.conflicts.length}`}
            {' · '}{canImport ? '등록 가능' : '등록 차단'}
          </div>
          {issues.slice(0, 3).map((issue, index) => (
            <div
              key={`${issue.code || 'issue'}-${index}`}
              className={issue.severity === 'blocker' ? 'text-red-600' : 'text-amber-700'}
            >
              {issue.code || 'issue'}: {issue.message || '확인이 필요합니다.'}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-2 bg-red-50 px-2 py-1.5 text-[10px] text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-2 bg-green-50 px-2 py-1.5 text-[10px] text-green-700">
          Collection 등록 완료: {success.collectionId} · 도구 {success.toolCount}개
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-[9px] text-gray-400">
          미리보기와 등록은 XGEN의 동일한 OpenAPI parser를 사용합니다.
        </span>
        <button
          type="button"
          disabled={!canImport || Boolean(busy) || Boolean(success)}
          onClick={() => void handleImport()}
          className="bg-blue-600 px-2 py-1.5 text-[10px] text-white hover:bg-blue-700 disabled:bg-gray-300"
        >
          {busy === 'import' ? '등록 중...' : 'Collection에 등록'}
        </button>
      </div>
    </div>
  );
}
