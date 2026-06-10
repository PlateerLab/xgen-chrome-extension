import type { FromTraceRequest } from '../../shared/api';
import type { TraceAnalysis } from './trace-analyzer';

export function buildTraceRegistrationPayload(
  analysis: TraceAnalysis,
  selectedToolIds: Iterable<string>,
  authProfileId?: string,
): FromTraceRequest {
  if (!analysis.primaryHost) {
    throw new Error('host를 식별할 수 없어 등록할 수 없습니다.');
  }

  const selected = new Set(selectedToolIds);
  const selectedTools = analysis.tools.filter((tool) => selected.has(tool.id));
  const selectedEdges = analysis.edges.filter(
    (edge) => selected.has(edge.fromToolId) && selected.has(edge.toToolId),
  );

  return {
    host: analysis.primaryHost,
    tools: selectedTools.map((tool) => ({
      method: tool.method,
      templatedPath: tool.templatedPath,
      pathParams: tool.pathParams,
      queryParamKeys: tool.queryParamKeys,
      querySample: tool.querySample,
      requestBodySample: tool.requestBodySample,
      responseSample: tool.responseSample,
      label: tool.label,
      sampleCount: tool.sampleCount,
    })),
    edges: selectedEdges.map((edge) => ({
      fromToolId: edge.fromToolId,
      toToolId: edge.toToolId,
      confidence: edge.confidence,
      sampleSharedValue: edge.sampleSharedValue,
    })),
    ...(authProfileId ? { authProfileId } : {}),
  };
}
