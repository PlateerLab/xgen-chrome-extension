/**
 * MAIN world에서 실행되는 fetch/XHR 후킹 스크립트.
 * chrome.scripting.executeScript({ world: 'MAIN', func }) 로 주입된다.
 */
export function mainWorldHookFunction() {
  // 이미 wrapper가 설치돼 있으면 다시 감싸지 않고 관찰만 재개한다.
  if ((window as any).__xgenApiHookInstalled) {
    (window as any).__xgenApiHookActive = true;
    window.dispatchEvent(new CustomEvent('xgen:api-hook-ready'));
    return;
  }
  (window as any).__xgenApiHookInstalled = true;
  (window as any).__xgenApiHookActive = true;
  let relayReady = false;
  const pendingDetails: any[] = [];
  const relayReadyListener = () => {
    relayReady = true;
    for (const detail of pendingDetails.splice(0)) {
      window.dispatchEvent(new CustomEvent('xgen:api-captured', { detail }));
    }
  };
  window.addEventListener('xgen:api-relay-ready', relayReadyListener);
  window.addEventListener('xgen:api-hook-control', ((event: CustomEvent) => {
    if (event.detail?.active === false) {
      (window as any).__xgenApiHookActive = false;
      relayReady = false;
      pendingDetails.splice(0);
      window.removeEventListener('xgen:api-relay-ready', relayReadyListener);
    }
  }) as EventListener);

  const MAX_BODY = 100 * 1024; // 100KB

  function resolveHttpUrl(rawUrl: string): string | null {
    try {
      const resolved = new URL(rawUrl, document.baseURI);
      return ['http:', 'https:'].includes(resolved.protocol) ? resolved.toString() : null;
    } catch {
      return null;
    }
  }

  function boundedText(value: string | null): { text: string | null; truncated: boolean } {
    if (value == null || value.length <= MAX_BODY) return { text: value, truncated: false };
    return { text: value.slice(0, MAX_BODY), truncated: true };
  }

  function addLimitation(
    metadata: Record<string, unknown>,
    limitation: string,
  ): Record<string, unknown> {
    const limitations = Array.isArray(metadata.limitations)
      ? metadata.limitations.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      ...metadata,
      limitations: [...new Set([...limitations, limitation])],
    };
  }

  function limitSerializedRequest(serialized: {
    requestBody: string | null;
    requestMetadata: Record<string, unknown>;
  }) {
    const limited = boundedText(serialized.requestBody);
    return {
      requestBody: limited.text,
      requestMetadata: limited.truncated
        ? addLimitation(serialized.requestMetadata, 'request_body_truncated')
        : serialized.requestMetadata,
    };
  }

  function shouldIgnore(url: string): boolean {
    if (!url) return true;
    // 브라우저 내부, data URI, extension 요청 무시
    if (url.startsWith('chrome-extension://')) return true;
    if (url.startsWith('data:')) return true;
    if (url.startsWith('blob:')) return true;
    // 정적 리소스 무시
    if (url.includes('favicon.ico')) return true;
    if (/\.(css|js|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|ico|map)(\?|$)/i.test(url)) return true;
    // analytics/tracking 무시
    if (url.includes('google-analytics') || url.includes('gtag') || url.includes('fbevents')) return true;
    return false;
  }

  /** HTML/RSC/정적 자원 응답은 API가 아니라 페이지 요청이므로 캡처 제외 */
  function shouldSkipResponse(contentType: string): boolean {
    if (!contentType) return false;
    const ct = contentType.toLowerCase();
    if (ct.includes('text/html')) return true;
    if (ct.includes('text/css')) return true;
    if (ct.includes('image/')) return true;
    if (ct.includes('font/')) return true;
    // Next.js RSC (React Server Component) payload — SPA 내부 navigation 시
    // 페이지 라우트에 발사되는 fetch지만 데이터 API가 아님. 호출해도 우리 백엔드에서는
    // RSC 헤더 못 만들어 일반 HTML이 옴.
    if (ct.includes('text/x-component')) return true;
    // 일부 SSR 프레임워크가 RSC를 multipart 형식으로 반환
    if (ct.includes('multipart/x-component')) return true;
    return false;
  }

  function shouldSkipBodyCapture(contentType: string): boolean {
    const ct = contentType.toLowerCase();
    return (
      ct.includes('text/event-stream')
      || ct.includes('application/octet-stream')
      || ct.includes('application/pdf')
      || ct.includes('application/zip')
      || ct.includes('application/x-zip')
      || ct.includes('application/gzip')
      || ct.includes('application/x-gzip')
      || ct.includes('application/x-rar')
      || ct.startsWith('audio/')
      || ct.startsWith('video/')
    );
  }

  async function readLimitedBody(
    body: ReadableStream<Uint8Array> | null,
    contentType: string,
    contentLength: string | null,
    scope: 'request' | 'response',
  ): Promise<{
    text: string | null;
    bodyCaptured: boolean;
    bodyTruncated: boolean;
    limitations: string[];
  }> {
    if (!body) {
      return { text: null, bodyCaptured: false, bodyTruncated: false, limitations: [] };
    }
    if (shouldSkipBodyCapture(contentType)) {
      return {
        text: null,
        bodyCaptured: false,
        bodyTruncated: false,
        limitations: [`${scope}_binary_or_streaming_body_not_captured`],
      };
    }
    const declaredLength = Number(contentLength || '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY) {
      return {
        text: null,
        bodyCaptured: false,
        bodyTruncated: true,
        limitations: [`${scope}_content_length_exceeds_limit`],
      };
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        const remaining = MAX_BODY - total;
        if (remaining <= 0) {
          truncated = true;
          try { await reader.cancel(); } catch { /* bounded data is still usable */ }
          break;
        }
        if (value.length > remaining) {
          chunks.push(value.slice(0, remaining));
          total += remaining;
          truncated = true;
          try { await reader.cancel(); } catch { /* bounded data is still usable */ }
          break;
        }
        chunks.push(value);
        total += value.length;
      }
    } catch {
      return {
        text: null,
        bodyCaptured: false,
        bodyTruncated: false,
        limitations: [`${scope}_body_unavailable`],
      };
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      text: new TextDecoder().decode(bytes),
      bodyCaptured: true,
      bodyTruncated: truncated,
      limitations: truncated ? [`${scope}_body_truncated`] : [],
    };
  }

  function headersToObject(headers: Headers | HeadersInit | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    if (!headers) return result;
    if (headers instanceof Headers) {
      headers.forEach((value, key) => { result[key] = value; });
    } else if (Array.isArray(headers)) {
      headers.forEach(([key, value]) => { result[key] = value; });
    } else {
      Object.assign(result, headers);
    }
    return result;
  }

  function headerValue(headers: Record<string, string>, name: string): string {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) return value;
    }
    return '';
  }

  function inferStringBodyKind(contentType: string, value: string): string {
    const ct = contentType.toLowerCase();
    if (ct.includes('application/graphql')) return 'graphql';
    if (ct.includes('application/x-www-form-urlencoded')) return 'form_urlencoded';
    if (ct.includes('json') || /^[\s]*[{[]/.test(value)) return 'json';
    return 'text';
  }

  function collectFieldPaths(value: unknown, max = 100): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    const addPath = (path: string) => {
      if (!path || seen.has(path) || paths.length >= max) return;
      seen.add(path);
      paths.push(path);
    };
    const walk = (node: unknown, path: string, depth: number) => {
      if (paths.length >= max || depth > 8 || node == null) return;
      if (Array.isArray(node)) {
        for (const item of node.slice(0, 5)) walk(item, `${path}[]`, depth + 1);
        return;
      }
      if (typeof node === 'object') {
        for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
          const childPath = path ? `${path}.${key}` : key;
          if (child != null && typeof child === 'object') walk(child, childPath, depth + 1);
          else addPath(childPath);
          if (paths.length >= max) return;
        }
        return;
      }
      addPath(path);
    };
    walk(value, '', 0);
    return paths;
  }

  function parseGraphqlMetadata(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const body = value as Record<string, unknown>;
    if (typeof body.query !== 'string') return undefined;
    if (!/^\s*(?:(?:query|mutation|subscription)\b|{)/.test(body.query)) return undefined;
    const match = body.query.match(/\b(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/);
    return {
      operationType: match?.[1] || 'unknown',
      ...(typeof body.operationName === 'string' && body.operationName
        ? { operationName: body.operationName }
        : match?.[2]
          ? { operationName: match[2] }
          : {}),
    };
  }

  function appendFormValue(target: Record<string, unknown>, key: string, value: unknown): void {
    if (!(key in target)) {
      target[key] = value;
      return;
    }
    target[key] = Array.isArray(target[key])
      ? [...target[key] as unknown[], value]
      : [target[key], value];
  }

  function serializeRequestBody(
    body: BodyInit | null | undefined,
    contentType: string,
  ): {
    requestBody: string | null;
    requestMetadata: Record<string, unknown>;
  } {
    if (body == null) {
      return {
        requestBody: null,
        requestMetadata: { bodyKind: 'none', fieldPaths: [], fileFields: [] },
      };
    }

    if (body instanceof FormData) {
      const sample: Record<string, unknown> = {};
      const fileFields: Record<string, unknown>[] = [];
      for (const [key, value] of body.entries()) {
        if (value instanceof File) {
          const file = {
            $file: true,
            contentType: value.type,
            size: value.size,
          };
          appendFormValue(sample, key, file);
          fileFields.push({
            fieldPath: key,
            contentType: value.type,
            size: value.size,
          });
        } else {
          appendFormValue(sample, key, value);
        }
      }
      return {
        requestBody: JSON.stringify(sample),
        requestMetadata: {
          bodyKind: 'multipart',
          fieldPaths: collectFieldPaths(sample),
          fileFields,
        },
      };
    }

    if (body instanceof URLSearchParams) {
      const sample: Record<string, unknown> = {};
      for (const [key, value] of body.entries()) appendFormValue(sample, key, value);
      return {
        requestBody: JSON.stringify(sample),
        requestMetadata: {
          bodyKind: 'form_urlencoded',
          fieldPaths: collectFieldPaths(sample),
          fileFields: [],
        },
      };
    }

    if (body instanceof Blob) {
      return {
        requestBody: null,
        requestMetadata: {
          bodyKind: 'binary',
          fieldPaths: [],
          fileFields: [{
            fieldPath: '$body',
            contentType: body.type,
            size: body.size,
          }],
          limitations: ['binary_body_not_captured'],
        },
      };
    }

    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return {
        requestBody: null,
        requestMetadata: {
          bodyKind: 'binary',
          fieldPaths: [],
          fileFields: [],
          limitations: ['binary_body_not_captured'],
        },
      };
    }

    const text = typeof body === 'string' ? body : String(body);
    const bodyKind = inferStringBodyKind(contentType, text);
    let parsed: unknown = null;
    if (bodyKind === 'json') {
      try { parsed = JSON.parse(text); } catch { /* malformed JSON remains text */ }
    } else if (bodyKind === 'form_urlencoded') {
      parsed = Object.fromEntries(new URLSearchParams(text).entries());
    }
    const graphql = parseGraphqlMetadata(parsed);
    return {
      requestBody: text,
      requestMetadata: {
        bodyKind: graphql ? 'graphql' : bodyKind,
        fieldPaths: collectFieldPaths(parsed),
        fileFields: [],
        ...(graphql ? { graphql } : {}),
      },
    };
  }

  function dispatch(detail: any) {
    if (!relayReady) {
      // A document_start hook can observe a response before the isolated-world
      // relay is ready. Keep a bounded in-memory queue and replay it after the
      // relay handshake; nothing is persisted in page or extension storage.
      if (pendingDetails.length >= 200) pendingDetails.shift();
      pendingDetails.push(detail);
      return;
    }
    window.dispatchEvent(new CustomEvent('xgen:api-captured', { detail }));
  }

  window.dispatchEvent(new CustomEvent('xgen:api-hook-ready'));

  // ── fetch 후킹 ──
  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    if (!(window as any).__xgenApiHookActive) {
      return originalFetch.call(this, input, init);
    }
    const startTime = Date.now();
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = resolveHttpUrl(rawUrl);

    if (!url || shouldIgnore(url)) {
      return originalFetch.call(this, input, init);
    }

    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    const requestHeaders = headersToObject(init?.headers || (input instanceof Request ? input.headers : undefined));
    const requestContentType = headerValue(requestHeaders, 'content-type');
    let serializedRequest = limitSerializedRequest(
      serializeRequestBody(init?.body ?? null, requestContentType),
    );
    if (init?.body == null && input instanceof Request && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      try {
        const requestClone = input.clone();
        const observedRequest = await readLimitedBody(
          requestClone.body,
          requestContentType,
          requestClone.headers.get('content-length'),
          'request',
        );
        serializedRequest = limitSerializedRequest(
          serializeRequestBody(observedRequest.text, requestContentType),
        );
        for (const limitation of observedRequest.limitations) {
          serializedRequest.requestMetadata = addLimitation(
            serializedRequest.requestMetadata,
            limitation,
          );
        }
      } catch {
        serializedRequest.requestMetadata = {
          ...serializedRequest.requestMetadata,
          limitations: ['request_object_body_unavailable'],
        };
      }
    }

    try {
      const response = await originalFetch.call(this, input, init);
      const duration = Date.now() - startTime;

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });

      // HTML/이미지/폰트 등 비-API 응답은 캡처 제외
      const respContentType = response.headers.get('content-type') || '';
      if (shouldSkipResponse(respContentType)) {
        return response;
      }

      let observedResponse: Awaited<ReturnType<typeof readLimitedBody>> = {
        text: null,
        bodyCaptured: false,
        bodyTruncated: false,
        limitations: [],
      };
      try {
        const clone = response.clone();
        observedResponse = await readLimitedBody(
          clone.body,
          respContentType,
          response.headers.get('content-length'),
          'response',
        );
      } catch {
        observedResponse.limitations = ['response_body_unavailable'];
      }

      if ((window as any).__xgenApiHookActive) {
        dispatch({
          id: crypto.randomUUID(),
          timestamp: startTime,
          url,
          method: method.toUpperCase(),
          requestHeaders,
          requestBody: serializedRequest.requestBody,
          requestContentType,
          requestMetadata: serializedRequest.requestMetadata,
          responseStatus: response.status,
          responseHeaders,
          responseBody: observedResponse.text,
          responseMetadata: {
            bodyCaptured: observedResponse.bodyCaptured,
            bodyTruncated: observedResponse.bodyTruncated,
            limitations: observedResponse.limitations,
          },
          contentType: respContentType,
          duration,
          provenance: { transport: 'fetch' },
        });
      }

      return response;
    } catch (err) {
      const duration = Date.now() - startTime;
      if ((window as any).__xgenApiHookActive) {
        dispatch({
          id: crypto.randomUUID(),
          timestamp: startTime,
          url,
          method: method.toUpperCase(),
          requestHeaders,
          requestBody: serializedRequest.requestBody,
          requestContentType,
          requestMetadata: serializedRequest.requestMetadata,
          responseStatus: 0,
          responseHeaders: {},
          responseBody: null,
          responseMetadata: {
            bodyCaptured: false,
            bodyTruncated: false,
            limitations: ['fetch_failed'],
          },
          contentType: '',
          duration,
          provenance: { transport: 'fetch' },
        });
      }
      throw err;
    }
  };

  // ── XMLHttpRequest 후킹 ──
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    const rawUrl = typeof url === 'string' ? url : url.toString();
    const fullUrl = resolveHttpUrl(rawUrl);
    (this as any).__xgen = {
      method: method.toUpperCase(),
      url: fullUrl || '',
      requestHeaders: {} as Record<string, string>,
      startTime: 0,
    };
    return originalOpen.apply(this, [method, url, ...rest] as any);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
    if ((this as any).__xgen) {
      (this as any).__xgen.requestHeaders[name] = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = (this as any).__xgen;
    if (!(window as any).__xgenApiHookActive || !meta || shouldIgnore(meta.url)) {
      return originalSend.call(this, body);
    }

    meta.startTime = Date.now();
    const requestContentType = headerValue(meta.requestHeaders, 'content-type');
    const serializedRequest = limitSerializedRequest(
      serializeRequestBody(body as BodyInit | null, requestContentType),
    );

    this.addEventListener('loadend', function () {
      const duration = Date.now() - meta.startTime;
      const responseHeaders: Record<string, string> = {};
      const rawHeaders = this.getAllResponseHeaders();
      rawHeaders.split('\r\n').forEach((line: string) => {
        const idx = line.indexOf(':');
        if (idx > 0) {
          responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
      });

      // HTML/이미지 등 비-API 응답 제외
      const xhrContentType = this.getResponseHeader('content-type') || '';
      if ((window as any).__xgenApiHookActive && !shouldSkipResponse(xhrContentType)) {
        let responseBody: string | null = null;
        let bodyCaptured = false;
        let bodyTruncated = false;
        const limitations: string[] = [];
        const declaredLength = Number(this.getResponseHeader('content-length') || '');
        if (
          shouldSkipBodyCapture(xhrContentType)
          || ['arraybuffer', 'blob', 'document', 'json'].includes(this.responseType)
        ) {
          limitations.push('response_binary_or_streaming_body_not_captured');
        } else if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY) {
          bodyTruncated = true;
          limitations.push('response_content_length_exceeds_limit');
        } else {
          try {
            const rawResponse = this.responseText;
            const limited = boundedText(rawResponse || null);
            responseBody = limited.text;
            bodyCaptured = responseBody != null;
            bodyTruncated = limited.truncated;
            if (limited.truncated) limitations.push('response_body_truncated');
          } catch {
            limitations.push('response_body_unavailable');
          }
        }
        dispatch({
          id: crypto.randomUUID(),
          timestamp: meta.startTime,
          url: meta.url,
          method: meta.method,
          requestHeaders: meta.requestHeaders,
          requestBody: serializedRequest.requestBody,
          requestContentType,
          requestMetadata: serializedRequest.requestMetadata,
          responseStatus: this.status,
          responseHeaders,
          responseBody,
          responseMetadata: { bodyCaptured, bodyTruncated, limitations },
          contentType: xhrContentType,
          duration,
          provenance: { transport: 'xhr' },
        });
      }
    });

    return originalSend.call(this, body);
  };

  console.log('[XGEN API Hook] fetch/XHR 후킹 활성화');
}

/**
 * MAIN world에서 후킹을 해제하는 함수.
 */
export function mainWorldUnhookFunction() {
  (window as any).__xgenApiHookActive = false;
  console.log('[XGEN API Hook] 관찰 비활성화');
}
