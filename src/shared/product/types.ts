export type ProductStatus = 'partial' | 'enriching' | 'enriched' | 'failed';

export interface ProductOption {
  name: string;
  values: string[];
}

export interface ProductDraft {
  id: string;
  sourceUrl: string;
  sourceHost: string;
  title: string;
  price?: number;
  currency?: string;
  thumbnailUrl?: string;
  imageUrls?: string[];
  /** 상품 상세 본문(기술서)에서 추출한 long 이미지 URL들 — 갤러리 표시용. */
  detailImageUrls?: string[];
  description?: string;
  detailHtml?: string;
  brand?: string;
  modelName?: string;
  manufacturer?: string;
  origin?: string;
  options?: ProductOption[];
  seoTitle?: string;
  seoDescription?: string;
  seoKeywords?: string[];
  categoryHints?: string[];
  capturedAt: number;
  status: ProductStatus;
  aiNotes?: string;
}
