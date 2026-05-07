import type { ProductDraft } from './types';

const STORAGE_KEY = 'xgen.products.v1';

export async function listProducts(): Promise<ProductDraft[]> {
  const result = await chrome.storage.session.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as ProductDraft[] | undefined) ?? [];
}

export async function addProduct(draft: ProductDraft): Promise<void> {
  const current = await listProducts();
  const next = [draft, ...current.filter((p) => p.id !== draft.id)];
  await chrome.storage.session.set({ [STORAGE_KEY]: next });
}

export async function updateProduct(
  id: string,
  patch: Partial<ProductDraft>,
): Promise<void> {
  const current = await listProducts();
  const next = current.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p));
  await chrome.storage.session.set({ [STORAGE_KEY]: next });
}

export async function removeProduct(id: string): Promise<void> {
  const current = await listProducts();
  const next = current.filter((p) => p.id !== id);
  await chrome.storage.session.set({ [STORAGE_KEY]: next });
}

export async function clearProducts(): Promise<void> {
  await chrome.storage.session.remove(STORAGE_KEY);
}

export type ProductsListener = (products: ProductDraft[]) => void;

export function subscribeProducts(listener: ProductsListener): () => void {
  const handler = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ) => {
    if (areaName !== 'session') return;
    if (!(STORAGE_KEY in changes)) return;
    const next = (changes[STORAGE_KEY].newValue as ProductDraft[] | undefined) ?? [];
    listener(next);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
