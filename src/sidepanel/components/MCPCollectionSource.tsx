import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addMCPCollectionSource,
  fetchMCPStationSessions,
  listApiCollections,
  previewMCPCollectionSource,
  type ApiCollectionSummary,
  type MCPSourcePreview,
  type MCPStationSession,
} from '../../shared/api';
import type { ExtensionMessage } from '../../shared/types';
import { CollectionBuildStatus } from './CollectionBuildStatus';

interface Props {
  onBack: () => void;
}

interface XgenConfig {
  serverUrl: string;
  authToken: string;
}

type ActionState =
  | { status: 'idle' }
  | { status: 'previewing' }
  | { status: 'registering' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

function sessionLabel(session: MCPStationSession): string {
  return session.session_name?.trim() || session.session_id;
}

export function MCPCollectionSource({ onBack }: Props) {
  const [config, setConfig] = useState<XgenConfig | null>(null);
  const [collections, setCollections] = useState<ApiCollectionSummary[]>([]);
  const [sessions, setSessions] = useState<MCPStationSession[]>([]);
  const [collectionId, setCollectionId] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState('mcp-station');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [preview, setPreview] = useState<MCPSourcePreview | null>(null);
  const [previewFingerprint, setPreviewFingerprint] = useState('');
  const [action, setAction] = useState<ActionState>({ status: 'idle' });

  const runningSessions = useMemo(
    () => sessions.filter((session) => (session.status ?? '').toLowerCase() === 'running'),
    [sessions],
  );
  const selectionFingerprint = useMemo(
    () => `${collectionId}|${label.trim()}|${[...selectedSessionIds].sort().join(',')}`,
    [collectionId, label, selectedSessionIds],
  );
  const previewCurrent = Boolean(preview && previewFingerprint === selectionFingerprint);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const chatConfig = await chrome.runtime.sendMessage({
        type: 'GET_CHAT_CONFIG',
      } satisfies ExtensionMessage);
      if (!chatConfig?.serverUrl) {
        throw new Error('XGEN 서버 URL이 설정되지 않았습니다.');
      }
      const nextConfig = {
        serverUrl: String(chatConfig.serverUrl),
        authToken: String(chatConfig.authToken ?? ''),
      };
      setConfig(nextConfig);
      const [nextCollections, nextSessions] = await Promise.all([
        listApiCollections(nextConfig.serverUrl, nextConfig.authToken),
        fetchMCPStationSessions(nextConfig.serverUrl, nextConfig.authToken),
      ]);
      setCollections(nextCollections);
      setSessions(nextSessions);
      setCollectionId((current) => (
        current && nextCollections.some((item) => item.collection_id === current)
          ? current
          : nextCollections[0]?.collection_id ?? ''
      ));
      setSelectedSessionIds((current) => new Set(
        [...current].filter((id) => nextSessions.some((session) => (
          session.session_id === id && (session.status ?? '').toLowerCase() === 'running'
        ))),
      ));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (previewFingerprint && previewFingerprint !== selectionFingerprint) {
      setAction({ status: 'idle' });
    }
  }, [previewFingerprint, selectionFingerprint]);

  const toggleSession = (sessionId: string) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const requestPayload = () => ({
    label: label.trim(),
    sessionIds: [...selectedSessionIds],
  });

  const handlePreview = async () => {
    if (!config || !collectionId || !label.trim() || selectedSessionIds.size === 0) return;
    setAction({ status: 'previewing' });
    try {
      const result = await previewMCPCollectionSource(
        config.serverUrl,
        config.authToken,
        collectionId,
        requestPayload(),
      );
      setPreview(result);
      setPreviewFingerprint(selectionFingerprint);
      setAction({ status: 'idle' });
    } catch (error) {
      setAction({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleRegister = async () => {
    if (!config || !previewCurrent) return;
    setAction({ status: 'registering' });
    try {
      await addMCPCollectionSource(
        config.serverUrl,
        config.authToken,
        collectionId,
        requestPayload(),
      );
      setAction({
        status: 'success',
        message: `${preview?.incoming_tool_count ?? 0}개 MCP 도구를 등록했습니다.`,
      });
      await load();
    } catch (error) {
      setAction({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const blockingIssues = preview?.ingest_result?.issues?.filter(
    (issue) => issue.severity === 'blocker',
  ) ?? [];
  const canPreview = Boolean(
    config && collectionId && label.trim() && selectedSessionIds.size > 0
      && action.status !== 'previewing' && action.status !== 'registering',
  );
  const canRegister = Boolean(
    previewCurrent && preview?.ingest_supported && blockingIssues.length === 0
      && action.status !== 'registering' && action.status !== 'success',
  );

  return (
    <section
      className="flex flex-col h-full bg-gray-50"
      data-testid="mcp-collection-source"
    >
      <header className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2">
        <button
          onClick={onBack}
          className="p-1 text-gray-500 hover:text-gray-800"
          aria-label="채팅으로 돌아가기"
          title="뒤로"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-gray-800">MCP 도구 연결</h1>
          <p className="text-[10px] text-gray-500">실행 중인 Station 세션을 API Collection에 추가합니다.</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto p-1 text-gray-400 hover:text-gray-700 disabled:opacity-40"
          title="목록 새로고침"
          aria-label="목록 새로고침"
        >
          <svg className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 11a8 8 0 1 0 2 5.3" />
            <path d="M20 4v7h-7" />
          </svg>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loadError && (
          <div className="border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
            {loadError}
          </div>
        )}

        <div>
          <label className="mb-1 block text-[10px] font-medium text-gray-500">대상 API Collection</label>
          <select
            value={collectionId}
            onChange={(event) => setCollectionId(event.target.value)}
            disabled={loading || collections.length === 0}
            className="w-full border border-gray-300 bg-white px-2 py-2 text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
          >
            {collections.length === 0
              ? <option value="">사용 가능한 컬렉션 없음</option>
              : collections.map((collection) => (
                <option key={collection.collection_id} value={collection.collection_id}>
                  {collection.name || collection.collection_id} · {collection.tool_count ?? 0} tools
                </option>
              ))}
          </select>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-medium text-gray-500">실행 중인 MCP 세션</span>
            <span className="text-[10px] text-gray-400">
              {selectedSessionIds.size}/{runningSessions.length} 선택
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto border border-gray-200 bg-white">
            {runningSessions.length === 0 ? (
              <div className="px-3 py-8 text-center text-[11px] text-gray-400">
                실행 중인 MCP 세션이 없습니다.
              </div>
            ) : runningSessions.map((session) => (
              <label
                key={session.session_id}
                className="flex cursor-pointer items-start gap-2 border-b border-gray-100 px-2.5 py-2 last:border-b-0 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={selectedSessionIds.has(session.session_id)}
                  onChange={() => toggleSession(session.session_id)}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-gray-800">
                    {sessionLabel(session)}
                  </span>
                  <span className="block truncate text-[10px] text-gray-500">
                    {session.server_type || 'MCP'} · {session.tool_count ?? '도구 수 미확인'}
                    {session.is_shared ? ' · 공유됨' : ''}
                  </span>
                </span>
                <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-green-500" title="실행 중" />
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[10px] font-medium text-gray-500">소스 이름</label>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={100}
            className="w-full border border-gray-300 bg-white px-2 py-2 text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
            placeholder="mcp-station"
          />
        </div>

        {previewCurrent && preview && (
          <div className="border border-gray-200 bg-white">
            <div className="grid grid-cols-3 divide-x divide-gray-200 border-b border-gray-200">
              <div className="px-2 py-2">
                <span className="block text-[9px] text-gray-400">신규 도구</span>
                <strong className="text-sm text-gray-800">{preview.incoming_tool_count}</strong>
              </div>
              <div className="px-2 py-2">
                <span className="block text-[9px] text-gray-400">이름 충돌</span>
                <strong className={preview.conflicts.length ? 'text-sm text-amber-600' : 'text-sm text-gray-800'}>
                  {preview.conflicts.length}
                </strong>
              </div>
              <div className="px-2 py-2">
                <span className="block text-[9px] text-gray-400">준비 상태</span>
                <strong className={preview.ingest_supported ? 'text-xs text-green-700' : 'text-xs text-red-700'}>
                  {preview.ingest_supported ? '사용 가능' : '차단됨'}
                </strong>
              </div>
            </div>
            {(preview.ingest_result?.issues?.length ?? 0) > 0 && (
              <div className="space-y-1 px-2.5 py-2">
                {preview.ingest_result?.issues?.slice(0, 5).map((issue, index) => (
                  <div key={`${issue.code}-${index}`} className="text-[10px] text-gray-600">
                    <span className={issue.severity === 'blocker' ? 'text-red-600' : 'text-amber-600'}>
                      {issue.code || issue.severity}
                    </span>
                    {issue.message ? ` · ${issue.message}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {action.status === 'success' && (
          <>
            <div className="border border-green-200 bg-green-50 px-2.5 py-2 text-[11px] text-green-700">
              {action.message}
            </div>
            <CollectionBuildStatus collectionId={collectionId} />
          </>
        )}
        {action.status === 'error' && (
          <div className="border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
            {action.message}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-gray-200 bg-white px-3 py-2">
        <button
          onClick={handlePreview}
          disabled={!canPreview}
          className="border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {action.status === 'previewing' ? '확인 중...' : '미리보기'}
        </button>
        <button
          onClick={handleRegister}
          disabled={!canRegister}
          className="bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {action.status === 'registering' ? '등록 중...' : '등록 / 갱신'}
        </button>
      </footer>
    </section>
  );
}
