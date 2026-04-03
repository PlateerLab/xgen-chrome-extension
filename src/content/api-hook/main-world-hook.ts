/**
 * MAIN world에서 실행되는 fetch/XHR 후킹 스크립트.
 * chrome.scripting.executeScript({ world: 'MAIN', func }) 로 주입된다.
 */
export function mainWorldHookFunction() {
  // 중복 주입 방지
  if ((window as any).__xgenApiHookActive) return;
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
    // favicon, analytics 등 무시
    if (url.includes('favicon.ico')) return true;
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

  function dispatch(detail: any) {
    window.dispatchEvent(new CustomEvent('xgen:api-captured', { detail }));
  }

  // ── fetch 후킹 ──
  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const startTime = Date.now();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (shouldIgnore(url)) {
      return originalFetch.call(this, input, init);
    }

    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    let requestBody: string | null = null;
    if (init?.body) {
      try {
        requestBody = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      } catch { requestBody = '[unserializable]'; }
    }

    const requestHeaders = headersToObject(init?.headers || (input instanceof Request ? input.headers : undefined));

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

      dispatch({
        id: crypto.randomUUID(),
        timestamp: startTime,
        url,
        method: method.toUpperCase(),
        requestHeaders,
        requestBody: truncate(requestBody),
        responseStatus: response.status,
        responseHeaders,
        responseBody: truncate(responseBody),
        contentType: response.headers.get('content-type') || '',
        duration,
      });

      return response;
    } catch (err) {
      const duration = Date.now() - startTime;
      dispatch({
        id: crypto.randomUUID(),
        timestamp: startTime,
        url,
        method: method.toUpperCase(),
        requestHeaders,
        requestBody: truncate(requestBody),
        responseStatus: 0,
        responseHeaders: {},
        responseBody: `[fetch error: ${(err as Error).message}]`,
        contentType: '',
        duration,
      });
      throw err;
    }
  };

  // ── XMLHttpRequest 후킹 ──
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__xgen = {
      method: method.toUpperCase(),
      url: typeof url === 'string' ? url : url.toString(),
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
    if (!meta || shouldIgnore(meta.url)) {
      return originalSend.call(this, body);
    }

    meta.startTime = Date.now();
    let requestBody: string | null = null;
    if (body) {
      try {
        requestBody = typeof body === 'string' ? body : JSON.stringify(body);
      } catch { requestBody = '[unserializable]'; }
    }

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

      dispatch({
        id: crypto.randomUUID(),
        timestamp: meta.startTime,
        url: meta.url,
        method: meta.method,
        requestHeaders: meta.requestHeaders,
        requestBody: truncate(requestBody),
        responseStatus: this.status,
        responseHeaders,
        responseBody: truncate(this.responseText || null),
        contentType: this.getResponseHeader('content-type') || '',
        duration,
      });
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
  // 원본 복원은 불가능 (참조를 잃음), 페이지 새로고침으로 해제
  console.log('[XGEN API Hook] 후킹 비활성화 (페이지 새로고침 시 완전 해제)');
}
