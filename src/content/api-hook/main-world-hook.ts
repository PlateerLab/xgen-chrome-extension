/**
 * MAIN world에서 실행되는 fetch/XHR 후킹 스크립트.
 * chrome.scripting.executeScript({ world: 'MAIN', func }) 로 주입된다.
 */
export function mainWorldHookFunction() {
  // 이미 wrapper가 설치돼 있으면 다시 감싸지 않고 관찰만 재개한다.
  if ((window as any).__xgenApiHookInstalled) {
    (window as any).__xgenApiHookActive = true;
    return;
  }
  (window as any).__xgenApiHookInstalled = true;
  (window as any).__xgenApiHookActive = true;

  const MAX_BODY = 100 * 1024; // 100KB

  function truncate(str: string | null): string | null {
    if (!str) return str;
    return str.length > MAX_BODY ? str.slice(0, MAX_BODY) + '...[truncated]' : str;
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
    window.dispatchEvent(new CustomEvent('xgen:api-captured', { detail }));
  }

  // ── fetch 후킹 ──
  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    if (!(window as any).__xgenApiHookActive) {
      return originalFetch.call(this, input, init);
    }
    const startTime = Date.now();
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    // 상대 경로를 절대 URL로 변환
    const url = rawUrl.startsWith('/') ? `${window.location.origin}${rawUrl}` : rawUrl.startsWith('http') ? rawUrl : `${window.location.origin}/${rawUrl}`;

    if (shouldIgnore(url)) {
      return originalFetch.call(this, input, init);
    }

    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    const requestHeaders = headersToObject(init?.headers || (input instanceof Request ? input.headers : undefined));
    const requestContentType = headerValue(requestHeaders, 'content-type');
    let serializedRequest = serializeRequestBody(init?.body ?? null, requestContentType);
    if (init?.body == null && input instanceof Request && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      try {
        const requestText = await input.clone().text();
        serializedRequest = serializeRequestBody(requestText || null, requestContentType);
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

      // response를 clone해서 body 읽기
      const clone = response.clone();
      let responseBody: string | null = null;
      try {
        responseBody = await clone.text();
      } catch { responseBody = '[unreadable]'; }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });

      // HTML/이미지/폰트 등 비-API 응답은 캡처 제외
      const respContentType = response.headers.get('content-type') || '';
      if (shouldSkipResponse(respContentType)) {
        return response;
      }

      if ((window as any).__xgenApiHookActive) {
        dispatch({
          id: crypto.randomUUID(),
          timestamp: startTime,
          url,
          method: method.toUpperCase(),
          requestHeaders,
          requestBody: truncate(serializedRequest.requestBody),
          requestContentType,
          requestMetadata: serializedRequest.requestMetadata,
          responseStatus: response.status,
          responseHeaders,
          responseBody: truncate(responseBody),
          contentType: response.headers.get('content-type') || '',
          duration,
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
          requestBody: truncate(serializedRequest.requestBody),
          requestContentType,
          requestMetadata: serializedRequest.requestMetadata,
          responseStatus: 0,
          responseHeaders: {},
          responseBody: `[fetch error: ${(err as Error).message}]`,
          contentType: '',
          duration,
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
    const fullUrl = rawUrl.startsWith('/') ? `${window.location.origin}${rawUrl}` : rawUrl.startsWith('http') ? rawUrl : `${window.location.origin}/${rawUrl}`;
    (this as any).__xgen = {
      method: method.toUpperCase(),
      url: fullUrl,
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
    const serializedRequest = serializeRequestBody(body as BodyInit | null, requestContentType);

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
        dispatch({
          id: crypto.randomUUID(),
          timestamp: meta.startTime,
          url: meta.url,
          method: meta.method,
          requestHeaders: meta.requestHeaders,
          requestBody: truncate(serializedRequest.requestBody),
          requestContentType,
          requestMetadata: serializedRequest.requestMetadata,
          responseStatus: this.status,
          responseHeaders,
          responseBody: truncate(this.responseText || null),
          contentType: xhrContentType,
          duration,
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
