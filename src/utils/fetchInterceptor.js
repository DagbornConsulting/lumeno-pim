// Global fetch interceptor: attaches the Bearer token (and optional x-store-id)
// to every request hitting our API. Login/health endpoints are skipped.
// Installs once at module import time.

const SKIP = ['/api/auth/login', '/api/auth/verify', '/api/health'];

const isOurApi = (url) => {
  if (typeof url !== 'string') return false;
  // Match both absolute (production) and relative (dev) URLs.
  return /\/api\//.test(url);
};

const shouldSkip = (url) => SKIP.some(p => url.includes(p));

export function installFetchInterceptor() {
  if (typeof window === 'undefined' || window.__pimFetchPatched) return;
  window.__pimFetchPatched = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (!isOurApi(url) || shouldSkip(url)) {
      return originalFetch(input, init);
    }

    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
    const token = localStorage.getItem('pim_token');
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const storeId = localStorage.getItem('pim_active_store_id');
    if (storeId && !headers.has('x-store-id')) {
      headers.set('x-store-id', storeId);
    }

    const next = originalFetch(input, { ...init, headers });

    // On 401, clear stored token and fire event so App can redirect to login.
    return next.then(res => {
      if (res.status === 401) {
        localStorage.removeItem('pim_token');
        localStorage.removeItem('pim_user');
        localStorage.removeItem('pim_active_store_id');
        window.dispatchEvent(new CustomEvent('pim:unauthorized'));
      }
      return res;
    });
  };
}
