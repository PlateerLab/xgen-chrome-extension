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

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.]/g, '');
    if (!cleaned) return undefined;
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
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

// 마지막 수단 — DOM 휴리스틱
function fromDomFallback(): RawCandidate {
  const title = document.querySelector('h1')?.textContent?.trim() || document.title;
  // 가격: 숫자 + ₩/원/KRW 패턴
  const priceText = Array.from(document.querySelectorAll<HTMLElement>('[class*="price" i], [id*="price" i]'))
    .map((el) => el.textContent || '')
    .find((t) => /[₩원]|\d{3,}/.test(t));
  // 첫 큰 이미지
  const img = Array.from(document.querySelectorAll<HTMLImageElement>('img'))
    .filter((i) => (i.naturalWidth || 0) >= 200 || (i.width >= 200))
    .sort((a, b) => (b.naturalWidth || b.width) - (a.naturalWidth || a.width))[0];

  return {
    title: title?.slice(0, 200),
    price: toNumber(priceText),
    currency: priceText && /원|₩|KRW/i.test(priceText) ? 'KRW' : undefined,
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

  return {
    id: crypto.randomUUID(),
    sourceUrl,
    sourceHost,
    title: merged.title?.slice(0, 200) || document.title || '(제목 없음)',
    price: merged.price,
    currency: merged.currency,
    thumbnailUrl: merged.thumbnailUrl,
    imageUrls: merged.imageUrls,
    description: merged.description,
    brand: merged.brand,
    modelName: merged.modelName,
    manufacturer: merged.manufacturer,
    origin: merged.origin,
    capturedAt: Date.now(),
    status: 'partial',
  };
}
