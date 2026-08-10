/**
 * Content script (isolated world)에서 실행.
 * MAIN world의 CustomEvent를 받아 service worker로 전달.
 */
export function apiHookRelayFunction() {
  if ((window as any).__xgenApiRelayActive) return;
  (window as any).__xgenApiRelayActive = true;

  const MAX_BODY_CHARS = 100 * 1024;
  const MAX_HEADERS = 80;
  const MAX_HEADER_NAME_CHARS = 128;
  const MAX_HEADER_VALUE_CHARS = 4 * 1024;
  const MAX_FIELD_PATHS = 100;
  const MAX_FIELD_PATH_CHARS = 500;
  const MAX_FILE_FIELDS = 40;
  const MAX_LIMITATIONS = 20;

  const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  );
  const reject = (reason: 'invalid_payload' | 'oversized_payload') => {
    chrome.runtime.sendMessage({ type: 'API_CAPTURE_REJECTED', reason }).catch(() => {});
  };
  const stringList = (value: unknown, maxItems: number, maxChars: number): string[] | null => {
    if (!Array.isArray(value)) return null;
    const output: string[] = [];
    for (const item of value.slice(0, maxItems)) {
      if (typeof item !== 'string' || item.length > maxChars) return null;
      output.push(item);
    }
    return output;
  };
  const headers = (value: unknown): Record<string, string> | null => {
    if (!isRecord(value)) return null;
    const output: Record<string, string> = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_HEADERS)) {
      if (
        !key
        || key.length > MAX_HEADER_NAME_CHARS
        || typeof child !== 'string'
        || child.length > MAX_HEADER_VALUE_CHARS
      ) return null;
      output[key] = child;
    }
    return output;
  };
  const requestMetadata = (value: unknown): Record<string, unknown> | null => {
    if (!isRecord(value)) return null;
    const fieldPaths = stringList(value.fieldPaths, MAX_FIELD_PATHS, MAX_FIELD_PATH_CHARS);
    if (!fieldPaths || !Array.isArray(value.fileFields)) return null;
    const fileFields: Record<string, unknown>[] = [];
    for (const raw of value.fileFields.slice(0, MAX_FILE_FIELDS)) {
      if (!isRecord(raw) || typeof raw.fieldPath !== 'string') return null;
      fileFields.push({
        fieldPath: raw.fieldPath.slice(0, MAX_FIELD_PATH_CHARS),
        ...(typeof raw.contentType === 'string'
          ? { contentType: raw.contentType.slice(0, 256) }
          : {}),
        ...(typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0
          ? { size: Math.min(Math.round(raw.size), Number.MAX_SAFE_INTEGER) }
          : {}),
      });
    }
    const limitations = value.limitations == null
      ? []
      : stringList(value.limitations, MAX_LIMITATIONS, 120);
    if (!limitations) return null;
    const graphql = isRecord(value.graphql)
      ? {
          operationType: value.graphql.operationType,
          ...(typeof value.graphql.operationName === 'string'
            ? { operationName: value.graphql.operationName.slice(0, 160) }
            : {}),
        }
      : undefined;
    return {
      bodyKind: value.bodyKind,
      fieldPaths,
      fileFields,
      ...(graphql ? { graphql } : {}),
      ...(limitations.length > 0 ? { limitations } : {}),
    };
  };
  const responseMetadata = (value: unknown): Record<string, unknown> | undefined => {
    if (!isRecord(value)) return undefined;
    const limitations = value.limitations == null
      ? []
      : stringList(value.limitations, MAX_LIMITATIONS, 120);
    if (!limitations) return undefined;
    return {
      bodyCaptured: value.bodyCaptured === true,
      bodyTruncated: value.bodyTruncated === true,
      limitations,
    };
  };
  const normalize = (
    value: unknown,
  ): { data: Record<string, unknown> } | { reason: 'invalid_payload' | 'oversized_payload' } => {
    if (!isRecord(value)) return { reason: 'invalid_payload' };
    if (
      (typeof value.requestBody === 'string' && value.requestBody.length > MAX_BODY_CHARS)
      || (typeof value.responseBody === 'string' && value.responseBody.length > MAX_BODY_CHARS)
    ) {
      return { reason: 'oversized_payload' };
    }
    if (
      !(value.requestBody == null || typeof value.requestBody === 'string')
      || !(value.responseBody == null || typeof value.responseBody === 'string')
    ) return { reason: 'invalid_payload' };
    const requestHeaders = headers(value.requestHeaders);
    const responseHeaders = headers(value.responseHeaders);
    const metadata = value.requestMetadata == null
      ? undefined
      : requestMetadata(value.requestMetadata);
    if (!requestHeaders || !responseHeaders || (value.requestMetadata != null && !metadata)) {
      return { reason: 'invalid_payload' };
    }
    const normalizedResponseMetadata = responseMetadata(value.responseMetadata);
    if (value.responseMetadata != null && !normalizedResponseMetadata) {
      return { reason: 'invalid_payload' };
    }
    return { data: {
      id: value.id,
      timestamp: value.timestamp,
      url: value.url,
      method: value.method,
      requestHeaders,
      requestBody: value.requestBody ?? null,
      ...(typeof value.requestContentType === 'string'
        ? { requestContentType: value.requestContentType.slice(0, 256) }
        : {}),
      ...(metadata ? { requestMetadata: metadata } : {}),
      responseStatus: value.responseStatus,
      responseHeaders,
      responseBody: value.responseBody ?? null,
      ...(normalizedResponseMetadata
        ? { responseMetadata: normalizedResponseMetadata }
        : {}),
      contentType: value.contentType,
      duration: value.duration,
      provenance: isRecord(value.provenance)
        ? { transport: value.provenance.transport }
        : undefined,
    } };
  };

  const relayCapturedApi = ((event: CustomEvent) => {
    const normalized = normalize(event.detail);
    if ('reason' in normalized) {
      reject(normalized.reason);
      return;
    }
    chrome.runtime.sendMessage({
      type: 'API_CAPTURED',
      data: normalized.data,
    }).catch(() => {});
  }) as EventListener;
  const stopRelay = ((event: CustomEvent) => {
    if (event.detail?.active !== false) return;
    window.removeEventListener('xgen:api-captured', relayCapturedApi);
    window.removeEventListener('xgen:api-hook-ready', announceRelayReady);
    window.removeEventListener('xgen:api-hook-control', stopRelay);
    (window as any).__xgenApiRelayActive = false;
  }) as EventListener;
  const announceRelayReady = () => {
    window.dispatchEvent(new CustomEvent('xgen:api-relay-ready'));
  };
  window.addEventListener('xgen:api-captured', relayCapturedApi);
  window.addEventListener('xgen:api-hook-ready', announceRelayReady);
  window.addEventListener('xgen:api-hook-control', stopRelay);
  announceRelayReady();

  console.log('[XGEN API Relay] 릴레이 활성화');
}
