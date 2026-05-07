import type { ProductDraft } from '../../shared/product/types';

interface RawCandidate {
  title?: string;
  price?: number;
  currency?: string;
  thumbnailUrl?: string;
  imageUrls?: string[];
  description?: string;
  brand?: string;
  modelName?: string;
  manufacturer?: string;
  origin?: string;
}

function pickFirst<T>(...values: (T | undefined | null | '')[]): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v as T;
  }
  return undefined;
}

/** 문자열에서 첫 번째 합리적인 숫자 추출 — 콤마/소수점 그룹 단위 매칭.
 *  버그: 이전 구현은 "10% 23,940원 26,600" 같은 텍스트를 통째로 concat해서 ₩102억 같은 잘못된 값 산출. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const m = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)/.exec(value);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** 텍스트에서 가격 후보 모두 추출. ₩/원 마커 우선, 그 다음 콤마 그룹. */
function extractPriceCandidates(text: string): number[] {
  const out: number[] = [];
  // 1차: 콤마 그룹 (예: "23,940원", "₩23,940")
  const re1 = /(?:₩\s*)?(\d{1,3}(?:,\d{3})+)\s*원?/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(text)) !== null) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (n >= 100 && n <= 100_000_000) out.push(n);
  }
  if (out.length > 0) return out;
  // 2차: 콤마 없는 ₩ 또는 "원" 옆 숫자 (예: "₩9900")
  const re2 = /(?:₩\s*|원\s*)(\d{3,8})|\b(\d{3,8})\s*원/g;
  while ((m = re2.exec(text)) !== null) {
    const numStr = m[1] || m[2];
    const n = parseInt(numStr, 10);
    if (n >= 100 && n <= 100_000_000) out.push(n);
  }
  return out;
}

function absoluteUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, document.baseURI).toString();
  } catch {
    return undefined;
  }
}

// JSON-LD Product 스키마 — schema.org/Product
function fromJsonLd(): RawCandidate | null {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const raw = JSON.parse(script.textContent || 'null');
      const candidates = Array.isArray(raw) ? raw : [raw];
      for (const node of candidates) {
        const product = findProduct(node);
        if (product) return product;
      }
    } catch {
      // skip malformed JSON-LD blocks
    }
  }
  return null;
}

function findProduct(node: unknown): RawCandidate | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  const isProduct =
    type === 'Product' || (Array.isArray(type) && type.includes('Product'));

  if (isProduct) {
    const offers = obj.offers as Record<string, unknown> | Record<string, unknown>[] | undefined;
    const firstOffer = Array.isArray(offers) ? offers[0] : offers;
    const image = obj.image;
    const images: string[] = Array.isArray(image)
      ? (image as unknown[]).filter((s): s is string => typeof s === 'string').map((u) => absoluteUrl(u) || u)
      : typeof image === 'string'
      ? [absoluteUrl(image) || image]
      : [];

    const brand = obj.brand;
    const brandName = typeof brand === 'string'
      ? brand
      : brand && typeof brand === 'object'
      ? ((brand as Record<string, unknown>).name as string | undefined)
      : undefined;

    return {
      title: typeof obj.name === 'string' ? obj.name : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      brand: brandName,
      modelName: typeof obj.model === 'string' ? obj.model : undefined,
      manufacturer:
        obj.manufacturer && typeof obj.manufacturer === 'object'
          ? ((obj.manufacturer as Record<string, unknown>).name as string | undefined)
          : typeof obj.manufacturer === 'string'
          ? obj.manufacturer
          : undefined,
      thumbnailUrl: images[0],
      imageUrls: images.length > 1 ? images : undefined,
      price: firstOffer ? toNumber(firstOffer.price) : undefined,
      currency:
        firstOffer && typeof firstOffer.priceCurrency === 'string'
          ? firstOffer.priceCurrency
          : undefined,
    };
  }

  // @graph 또는 중첩 mainEntity 탐색
  const graph = obj['@graph'];
  if (Array.isArray(graph)) {
    for (const child of graph) {
      const r = findProduct(child);
      if (r) return r;
    }
  }
  const mainEntity = obj.mainEntity;
  if (mainEntity) {
    const r = findProduct(mainEntity);
    if (r) return r;
  }
  return null;
}

// OG/Twitter/product meta tags
function fromMetaTags(): RawCandidate {
  const get = (selector: string): string | undefined => {
    const el = document.querySelector<HTMLMetaElement>(selector);
    return el?.content || undefined;
  };

  return {
    title: pickFirst(get('meta[property="og:title"]'), get('meta[name="twitter:title"]')),
    description: pickFirst(
      get('meta[property="og:description"]'),
      get('meta[name="description"]'),
      get('meta[name="twitter:description"]'),
    ),
    thumbnailUrl: absoluteUrl(
      pickFirst(get('meta[property="og:image"]'), get('meta[name="twitter:image"]')),
    ),
    price: toNumber(pickFirst(
      get('meta[property="product:price:amount"]'),
      get('meta[property="og:price:amount"]'),
    )),
    currency: pickFirst(
      get('meta[property="product:price:currency"]'),
      get('meta[property="og:price:currency"]'),
    ),
    brand: get('meta[property="product:brand"]'),
  };
}

// 마이크로데이터 (itemtype="...Product")
function fromMicrodata(): RawCandidate | null {
  const root = document.querySelector('[itemtype$="/Product"], [itemtype="http://schema.org/Product"], [itemtype="https://schema.org/Product"]');
  if (!root) return null;
  const get = (prop: string): string | undefined => {
    const el = root.querySelector<HTMLElement>(`[itemprop="${prop}"]`);
    if (!el) return undefined;
    if (el instanceof HTMLMetaElement) return el.content || undefined;
    if (el instanceof HTMLImageElement) return absoluteUrl(el.src);
    if (el instanceof HTMLAnchorElement) return el.href || undefined;
    return el.textContent?.trim() || undefined;
  };
  return {
    title: get('name'),
    description: get('description'),
    thumbnailUrl: get('image'),
    price: toNumber(get('price')),
    currency: get('priceCurrency'),
    brand: get('brand'),
  };
}

/** 페이지의 모든 가격 element를 수집 후 점수화 — 최고점 element의 최저 가격 채택.
 *  점수 시그널: (1) 메인 컨테이너 안 (2) 큰 폰트 (3) 상단 영역 (4) sale/final/discount 클래스 (5) 보이는 영역. */
function pickMainPrice(): number | undefined {
  // 메인 상품 정보 컨테이너 후보 — 매칭되면 거기서만 찾기, 아니면 전체.
  const mainContainerSelectors = [
    '[class*="product-info" i]',
    '[class*="productInfo" i]',
    '[class*="goods-info" i]',
    '[class*="goodsInfo" i]',
    '[class*="prd-info" i]',
    '[class*="prdInfo" i]',
    '[class*="product-price" i]',
    '[class*="productPrice" i]',
    '[class*="product_price" i]',
    'main',
    '[role="main"]',
  ];
  let root: Element = document.body;
  for (const sel of mainContainerSelectors) {
    const found = document.querySelector(sel);
    if (found && found.textContent && found.textContent.length > 50) {
      root = found;
      break;
    }
  }

  const priceEls = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[class*="price" i], [id*="price" i], [class*="amount" i], [class*="cost" i], strong, em, span, h2, h3',
    ),
  );

  type Candidate = { price: number; score: number };
  const cands: Candidate[] = [];

  for (const el of priceEls) {
    const text = el.textContent || '';
    if (text.length > 200) continue; // 큰 컨테이너는 자식이 잡힘
    const prices = extractPriceCandidates(text);
    if (prices.length === 0) continue;

    const cls = (el.className?.toString?.() || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const sig = `${cls} ${id}`;

    let score = 0;

    // 클래스/ID 시그널
    if (/\b(sale|final|discount|payment|sell|current-price|currentprice)\b/.test(sig)) score += 50;
    if (/(price|amount|cost)/.test(sig)) score += 10;
    // 부정 시그널
    if (/regular|original|strike|del|cross|orgn|normal|before/.test(sig)) score -= 40;
    if (/coupon|benefit|hyetaek|membership|reward|point/.test(sig)) score -= 30;
    if (/recommend|related|other|suggest|together/.test(sig)) score -= 50;

    // 폰트 크기
    let fontSize = 0;
    try {
      fontSize = parseFloat(window.getComputedStyle(el).fontSize) || 0;
    } catch {
      /* ignore */
    }
    if (fontSize >= 24) score += 40;
    else if (fontSize >= 20) score += 25;
    else if (fontSize >= 16) score += 10;
    else if (fontSize > 0 && fontSize < 12) score -= 20;

    // 위치: 화면 상단(접지 위)에 가까울수록 가산
    let rect: DOMRect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      continue;
    }
    if (rect.width === 0 || rect.height === 0) continue;
    const top = rect.top + window.scrollY;
    if (top < 1200) score += 25;
    else if (top < 2400) score += 10;
    else if (top > 5000) score -= 20;

    // 텍스트 자체에 취소선/del 표기
    if (el.tagName === 'DEL' || el.tagName === 'S') score -= 50;

    // 한 element 안 최저값 (정상가>할인가 순 표시 케이스 대응)
    const price = Math.min(...prices);
    cands.push({ price, score });
  }

  if (cands.length === 0) return undefined;
  cands.sort((a, b) => b.score - a.score);
  return cands[0].price;
}

// 마지막 수단 — DOM 휴리스틱
function fromDomFallback(): RawCandidate {
  const title = document.querySelector('h1')?.textContent?.trim() || document.title;

  const priceCandidate = pickMainPrice();

  // 첫 큰 이미지
  const img = Array.from(document.querySelectorAll<HTMLImageElement>('img'))
    .filter((i) => (i.naturalWidth || 0) >= 200 || (i.width >= 200))
    .sort((a, b) => (b.naturalWidth || b.width) - (a.naturalWidth || a.width))[0];

  return {
    title: title?.slice(0, 200),
    price: priceCandidate,
    currency: priceCandidate !== undefined ? 'KRW' : undefined,
    thumbnailUrl: img ? absoluteUrl(img.src) : undefined,
  };
}

function mergeCandidates(...sources: (RawCandidate | null)[]): RawCandidate {
  const result: RawCandidate = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src) as [keyof RawCandidate, unknown][]) {
      if (value === undefined || value === null || value === '') continue;
      if (result[key] === undefined) {
        // @ts-expect-error — assignment by key, types match by construction
        result[key] = value;
      }
    }
  }
  return result;
}

/** 상품 상세 본문(기술서) 영역의 long 이미지들 추출.
 *  쿠팡/네이버스마트스토어/11번가 등 사이트별 흔한 컨테이너 셀렉터 시도. */
function extractDetailImageUrls(maxImages = 30): string[] {
  // 후보 컨테이너 — 사이트별 다양함. 가장 먼저 매칭되는 거 사용.
  const containerSelectors = [
    // 쿠팡
    '#productDetail',
    '.product-detail',
    '.prod-description',
    // 네이버 스마트스토어
    '#INTRODUCE',
    '.se-main-container',
    // 11번가
    '.itm_intro',
    '#tabDetailInfo',
    // 일반
    '[class*="detail-content" i]',
    '[class*="prdDetail" i]',
    '[class*="goods-detail" i]',
    '[id*="detailContent" i]',
    '[id*="productDescription" i]',
  ];

  let container: Element | null = null;
  for (const sel of containerSelectors) {
    const found = document.querySelector(sel);
    if (found) {
      container = found;
      break;
    }
  }
  if (!container) return [];

  const seen = new Set<string>();
  const collected: string[] = [];

  // <img> 태그 (lazy load 속성 포함)
  const imgs = container.querySelectorAll<HTMLImageElement>('img');
  for (const img of imgs) {
    const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy');
    if (!raw) continue;
    const url = absoluteUrl(raw);
    if (!url || seen.has(url)) continue;

    // 크기 필터: 명시 width/height 또는 자연 크기
    const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '0', 10);
    const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height') || '0', 10);
    // 작은 아이콘 제외 (50x50 등)
    if ((w > 0 && w < 200) && (h > 0 && h < 200)) continue;

    seen.add(url);
    collected.push(url);
    if (collected.length >= maxImages) break;
  }

  // background-image 인라인 스타일 (크기 큰 div)
  if (collected.length < maxImages) {
    const bgEls = container.querySelectorAll<HTMLElement>('[style*="background-image" i]');
    for (const el of bgEls) {
      const style = el.getAttribute('style') || '';
      const m = /background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(style);
      if (!m) continue;
      const url = absoluteUrl(m[1]);
      if (!url || seen.has(url)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 100) continue;
      seen.add(url);
      collected.push(url);
      if (collected.length >= maxImages) break;
    }
  }

  return collected;
}

/** AI 보강 입력용 — 페이지의 의미있는 텍스트만 추려서 cap. */
export function buildPageSnippet(maxBytes = 10_000): string {
  const head = Array.from(document.head?.querySelectorAll('meta, title') ?? [])
    .map((el) => el.outerHTML)
    .join('\n');

  const body = (document.querySelector('main, [role="main"], article, #content, #container, body') as HTMLElement | null)
    ?? document.body;

  const clone = body?.cloneNode(true) as HTMLElement | null;
  if (clone) {
    clone.querySelectorAll('script, style, svg, noscript, iframe, link').forEach((el) => el.remove());
  }
  const bodyText = clone?.innerText ?? '';

  const combined = `${head}\n\n${bodyText}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  if (new Blob([combined]).size <= maxBytes) return combined;
  // 단순 byte truncate (UTF-8 문자 잘림 가능 — JSON 응답에는 영향 없음)
  return combined.slice(0, maxBytes);
}

export function extractHeuristic(): ProductDraft {
  const merged = mergeCandidates(
    fromJsonLd(),
    fromMicrodata(),
    fromMetaTags(),
    fromDomFallback(),
  );

  const sourceUrl = window.location.href;
  let sourceHost = '';
  try {
    sourceHost = new URL(sourceUrl).hostname;
  } catch {
    sourceHost = '';
  }

  const detailImageUrls = extractDetailImageUrls();

  return {
    id: crypto.randomUUID(),
    sourceUrl,
    sourceHost,
    title: merged.title?.slice(0, 200) || document.title || '(제목 없음)',
    price: merged.price,
    currency: merged.currency,
    thumbnailUrl: merged.thumbnailUrl,
    imageUrls: merged.imageUrls,
    detailImageUrls: detailImageUrls.length > 0 ? detailImageUrls : undefined,
    description: merged.description,
    brand: merged.brand,
    modelName: merged.modelName,
    manufacturer: merged.manufacturer,
    origin: merged.origin,
    capturedAt: Date.now(),
    status: 'partial',
  };
}
