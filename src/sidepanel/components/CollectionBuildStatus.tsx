import { useCallback, useEffect, useState } from 'react';
import {
  getApiCollection,
  type ApiCollectionDetail,
} from '../../shared/api';
import type { ExtensionMessage } from '../../shared/types';

interface Props {
  collectionId: string;
  expectedToolCount?: number;
  targetTabId?: number | null;
}

type StatusState =
  | { status: 'loading' }
  | { status: 'ready' | 'warning'; detail: ApiCollectionDetail }
  | { status: 'error'; message: string };

function tabTarget(tabId: number | null | undefined): { tabId?: number } {
  return typeof tabId === 'number' ? { tabId } : {};
}

function percent(value: number | undefined): string {
  return value == null ? '-' : `${Math.round(value * 100)}%`;
}

function buildComplete(
  detail: ApiCollectionDetail,
  expectedToolCount: number | undefined,
): boolean {
  if (
    expectedToolCount != null
    && Number(detail.tool_count || 0) < expectedToolCount
  ) {
    return false;
  }
  return Boolean(
    detail.graph_tool_call_version
    && detail.collection_graph_version != null
    && detail.readiness_summary
    && detail.semantic_summary
    && detail.edge_quality_summary,
  );
}

function compatibilityMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(404|405)\b/.test(message)) {
    return '현재 XGEN backend가 Collection build 상태 조회를 지원하지 않습니다.';
  }
  return message;
}

export function CollectionBuildStatus({
  collectionId,
  expectedToolCount,
  targetTabId,
}: Props) {
  const [state, setState] = useState<StatusState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const inspect = async (attempt: number) => {
      try {
        const config = await chrome.runtime.sendMessage({
          type: 'GET_CHAT_CONFIG',
          ...tabTarget(targetTabId),
        } satisfies ExtensionMessage);
        if (!config?.serverUrl) {
          throw new Error('XGEN 서버 URL이 설정되지 않았습니다.');
        }
        const detail = await getApiCollection(
          String(config.serverUrl),
          String(config.authToken ?? ''),
          collectionId,
        );
        if (cancelled) return;
        if (!buildComplete(detail, expectedToolCount) && attempt < 4) {
          timeoutId = setTimeout(() => {
            void inspect(attempt + 1);
          }, 750);
          return;
        }
        setState({
          status: buildComplete(detail, expectedToolCount) ? 'ready' : 'warning',
          detail,
        });
      } catch (error) {
        if (!cancelled) {
          setState({ status: 'error', message: compatibilityMessage(error) });
        }
      }
    };

    void inspect(0);
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [collectionId, expectedToolCount, refreshKey, targetTabId]);

  if (state.status === 'loading') {
    return (
      <div
        className="mt-2 border-l-2 border-blue-400 bg-blue-50 px-2 py-1.5 text-[10px] text-blue-700"
        data-testid="collection-build-status"
      >
        Collection graph 확인 중...
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        className="mt-2 border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[10px] text-red-700"
        data-testid="collection-build-status"
      >
        <div>{state.message}</div>
        <button
          type="button"
          onClick={refresh}
          className="mt-1 text-[10px] font-medium text-red-700 underline"
        >
          다시 확인
        </button>
      </div>
    );
  }

  const detail = state.detail;
  const semantic = detail.semantic_summary || {};
  const edgeQuality = detail.edge_quality_summary || {};
  const readiness = detail.readiness_summary || {};
  const incomplete = state.status === 'warning';

  return (
    <div
      className={`mt-2 border-l-2 px-2 py-1.5 text-[10px] ${
        incomplete
          ? 'border-amber-400 bg-amber-50 text-amber-800'
          : 'border-green-500 bg-green-50 text-green-800'
      }`}
      data-testid="collection-build-status"
    >
      <div className="flex items-center justify-between gap-2">
        <strong>
          {incomplete ? 'graph metadata 확인 필요' : 'graph build 완료'}
        </strong>
        <button
          type="button"
          onClick={refresh}
          className="text-[9px] underline"
        >
          새로고침
        </button>
      </div>
      <div className="mt-0.5">
        도구 {detail.tool_count ?? 0} · 엣지 {detail.edge_count ?? 0}
        {' · '}소스 {detail.source_count ?? 0}
        {readiness.readiness_score != null
          && ` · 준비도 ${readiness.readiness_score}`}
        {readiness.status && ` (${readiness.status})`}
      </div>
      <div className="mt-0.5 text-[9px] opacity-80">
        graph-tool-call {detail.graph_tool_call_version || '미확인'}
        {' · '}graph v{detail.collection_graph_version ?? '미확인'}
      </div>
      <div className="mt-0.5 break-all text-[9px] opacity-80">
        인증 {detail.auth_profile_id
          ? `연결됨 (${detail.auth_profile_id})`
          : '프로필 없음'}
      </div>
      <div className="mt-0.5 text-[9px] opacity-80">
        action {percent(semantic.canonical_action_known_rate)}
        {' · '}resource {percent(semantic.primary_resource_assigned_rate)}
        {' · '}module {percent(semantic.path_module_assigned_rate)}
        {' · '}강한 엣지 {edgeQuality.strong_deterministic_evidence ?? 0}
        /{edgeQuality.total ?? detail.edge_count ?? 0}
      </div>
    </div>
  );
}
