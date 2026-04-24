const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function req(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Products
export const listProducts = (params = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([,v]) => v != null && v !== '')).toString();
  return req(`/products${qs ? '?' + qs : ''}`);
};
export const getProduct = id => req(`/products/${id}`);
export const createProduct = data => req('/products', { method: 'POST', body: data });
export const updateProduct = (id, data) => req(`/products/${id}`, { method: 'PUT', body: data });
export const deleteProduct = id => req(`/products/${id}`, { method: 'DELETE' });
export const getFacets = () => req('/products/facets');

// Shopify
export const pushProduct = id => req(`/products/${id}/push`, { method: 'POST' });
export const pullAllProducts = () => req('/shopify/pull', { method: 'POST' });
export const pushAllPending = () => req('/shopify/push-pending', { method: 'POST' });

// Store
export const getStore = () => req('/store');
export const saveStore = data => req('/store', { method: 'POST', body: data });
export const testStore = () => req('/store/test', { method: 'POST' });

// Metafield definitions
export const listMetafieldDefs = () => req('/metafield-definitions');
export const createMetafieldDef = data => req('/metafield-definitions', { method: 'POST', body: data });
export const pushMetafieldDef = id => req(`/metafield-definitions/${id}/push`, { method: 'POST' });
export const deleteMetafieldDef = id => req(`/metafield-definitions/${id}`, { method: 'DELETE' });
