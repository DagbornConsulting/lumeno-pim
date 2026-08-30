// Native Google integration for SEO/AEO analysis: Search Console (GSC) +
// Google Analytics 4 (GA4). Auth uses a Google service account — no interactive
// OAuth, no refresh tokens. Sign a JWT with the service account private key and
// exchange it for a short-lived access token (cached until expiry).
//
// Setup (owner does this once in Google Cloud):
//   1. Create a project, enable "Google Search Console API" + "Google Analytics Data API".
//   2. Create a service account, download the JSON key.
//   3. Put the whole JSON into env GOOGLE_SERVICE_ACCOUNT_JSON (single line), or
//      set GOOGLE_APPLICATION_CREDENTIALS to a file path.
//   4. In Search Console → Settings → Users, add the service account email as a user.
//   5. In GA4 → Admin → Property Access, add the service account email as Viewer.
//   6. In the PIM SEO settings, set the GSC site URL + GA4 property id.

import crypto from 'crypto';
import fs from 'fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/content', // Merchant Center (Content API for Shopping)
].join(' ');

let _tokenCache = null; // { token, exp }

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Load the service account credentials from env (JSON string) or a file path.
export function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    try { return JSON.parse(raw); }
    catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON är inte giltig JSON'); }
  }
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path && fs.existsSync(path)) {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  }
  return null;
}

export function isConfigured() {
  const sa = getServiceAccount();
  return !!(sa && sa.client_email && sa.private_key);
}

// Exchange a signed JWT for a Google OAuth access token (cached ~55 min).
async function getAccessToken() {
  if (_tokenCache && _tokenCache.exp > Date.now() + 60_000) return _tokenCache.token;

  const sa = getServiceAccount();
  if (!sa?.client_email || !sa?.private_key) {
    throw new Error('Inget Google service-account konfigurerat (GOOGLE_SERVICE_ACCOUNT_JSON)');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(sa.private_key)
    .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token-fel: ${data.error_description || data.error || res.status}`);

  _tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return _tokenCache.token;
}

// Reset when creds change (rarely needed; token auto-refreshes on expiry).
export function clearTokenCache() { _tokenCache = null; }

// --- Search Console -------------------------------------------------------

// Query the Search Analytics API. Returns rows with the requested dimensions
// plus clicks, impressions, ctr, position.
// dimensions e.g. ['query'] | ['page'] | ['query','page'] | ['date']
export async function gscSearchAnalytics({ siteUrl, startDate, endDate, dimensions = ['query'], rowLimit = 250, filters }) {
  if (!siteUrl) throw new Error('GSC-webbadress (siteUrl) saknas');
  const token = await getAccessToken();
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const body = { startDate, endDate, dimensions, rowLimit };
  if (filters?.length) body.dimensionFilterGroups = [{ filters }];

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GSC-fel: ${data.error?.message || res.status}`);

  return (data.rows || []).map(r => {
    const out = { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
    dimensions.forEach((d, i) => { out[d] = r.keys?.[i]; });
    return out;
  });
}

// List the sites the service account can access (handy for finding the exact
// siteUrl string, incl. sc-domain: properties).
export async function gscListSites() {
  const token = await getAccessToken();
  const res = await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GSC-fel: ${data.error?.message || res.status}`);
  return (data.siteEntry || []).map(s => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
}

// --- GA4 ------------------------------------------------------------------

// Run a GA4 report. metrics/dimensions are arrays of API names, e.g.
// metrics: ['sessions','conversions'], dimensions: ['landingPage'].
export async function ga4RunReport({ propertyId, startDate, endDate, dimensions = [], metrics = ['sessions'], limit = 100, orderByMetric }) {
  if (!propertyId) throw new Error('GA4 property-id saknas');
  const token = await getAccessToken();
  const id = String(propertyId).replace(/[^0-9]/g, '');
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`;
  const body = {
    dateRanges: [{ startDate, endDate }],
    dimensions: dimensions.map(name => ({ name })),
    metrics: metrics.map(name => ({ name })),
    limit,
  };
  if (orderByMetric) body.orderBys = [{ metric: { metricName: orderByMetric }, desc: true }];

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GA4-fel: ${data.error?.message || res.status}`);

  const dimHeaders = (data.dimensionHeaders || []).map(h => h.name);
  const metHeaders = (data.metricHeaders || []).map(h => h.name);
  const rows = (data.rows || []).map(r => {
    const out = {};
    dimHeaders.forEach((name, i) => { out[name] = r.dimensionValues?.[i]?.value; });
    metHeaders.forEach((name, i) => { out[name] = Number(r.metricValues?.[i]?.value ?? 0); });
    return out;
  });
  return { rows, dimensionHeaders: dimHeaders, metricHeaders: metHeaders, totalRows: data.rowCount || rows.length };
}

// --- Merchant Center (Content API for Shopping v2.1) --------------------

const CONTENT_BASE = 'https://shoppingcontent.googleapis.com/content/v2.1';

// Account-level status: is the account suspended, plus account-wide issues.
export async function merchantAccountStatus({ merchantId }) {
  if (!merchantId) throw new Error('Merchant Center account-id saknas');
  const token = await getAccessToken();
  const id = String(merchantId).replace(/[^0-9]/g, '');
  const res = await fetch(`${CONTENT_BASE}/${id}/accountstatuses/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Merchant-fel: ${data.error?.message || res.status}`);
  return {
    accountId: data.accountId,
    websiteClaimed: data.websiteClaimed,
    accountLevelIssues: (data.accountLevelIssues || []).map(i => ({
      id: i.id, title: i.title, country: i.country, severity: i.severity,
      detail: i.detail, documentation: i.documentation,
    })),
    products: data.products || [],
  };
}

// Per-product status incl. itemLevelIssues (disapprovals, GTIN, image, price…).
// Paginates; returns a flat list of products with their issues.
export async function merchantProductStatuses({ merchantId, maxPages = 20 }) {
  if (!merchantId) throw new Error('Merchant Center account-id saknas');
  const token = await getAccessToken();
  const id = String(merchantId).replace(/[^0-9]/g, '');
  const out = [];
  let pageToken = null, pages = 0;
  do {
    const url = new URL(`${CONTENT_BASE}/${id}/productstatuses`);
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(`Merchant-fel: ${data.error?.message || res.status}`);
    for (const p of data.resources || []) {
      out.push({
        productId: p.productId,
        title: p.title,
        link: p.link,
        issues: (p.itemLevelIssues || []).map(i => ({
          code: i.code, servability: i.servability, resolution: i.resolution,
          attributeName: i.attributeName, description: i.description, detail: i.detail,
          documentation: i.documentation,
        })),
      });
    }
    pageToken = data.nextPageToken || null;
    pages++;
  } while (pageToken && pages < maxPages);
  return out;
}

// --- Merchant API (replaces Content API for Shopping, sunset 2026-08-18) ----
// https://developers.google.com/merchant/api/guides/reports/overview
const MERCHANT_API = 'https://merchantapi.googleapis.com';
const micros = m => (m && m.amountMicros != null ? Number(m.amountMicros) / 1e6 : null);

// Run a Merchant Center Query Language statement via accounts.reports.search,
// following nextPageToken until the report is exhausted. Tries reports/v1 and
// falls back to reports/v1beta if the GA surface is not available.
export async function merchantReportSearch({ merchantId, query, pageSize = 1000, maxPages = 200 }) {
  if (!merchantId) throw new Error('Merchant Center account-id saknas');
  const token = await getAccessToken();
  const id = String(merchantId).replace(/[^0-9]/g, '');
  const results = [];
  let pageToken = null;
  let version = 'v1';
  for (let page = 0; page < maxPages; page++) {
    const res = await fetch(`${MERCHANT_API}/reports/${version}/accounts/${id}/reports:search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, pageSize, ...(pageToken ? { pageToken } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404 && version === 'v1' && page === 0) { version = 'v1beta'; page--; continue; }
    if (!res.ok) throw new Error(`Merchant API-fel (${res.status}): ${data.error?.message || 'okänt fel'}`);
    results.push(...(data.results || []));
    pageToken = data.nextPageToken || null;
    if (!pageToken) break;
  }
  return results;
}

// Price competitiveness (Market Insights): our price vs Google's benchmark
// per offer. Amounts come in micros (1 SEK = 1 000 000) → converted to SEK.
// Returns [{ id, offerId, title, brand, country, currency, price, benchmark }].
export async function merchantPriceCompetitiveness({ merchantId }) {
  const base = 'title, brand, price, benchmark_price, report_country_code';
  let results;
  try {
    results = await merchantReportSearch({ merchantId, query: `SELECT id, offer_id, ${base} FROM price_competitiveness_product_view` });
  } catch (e) {
    if (!/offer_id/i.test(e.message)) throw e;
    results = await merchantReportSearch({ merchantId, query: `SELECT id, ${base} FROM price_competitiveness_product_view` });
  }
  return results
    .map(r => r.priceCompetitivenessProductView)
    .filter(Boolean)
    .map(v => ({
      id: v.id || null,
      // id format: channel~languageCode~feedLabel~offerId
      offerId: v.offerId || String(v.id || '').split('~').pop(),
      title: v.title || null,
      brand: v.brand || null,
      country: v.reportCountryCode || null,
      currency: v.price?.currencyCode || v.benchmarkPrice?.currencyCode || null,
      price: micros(v.price),
      benchmark: micros(v.benchmarkPrice),
    }));
}

// Merchant API requires the GCP project (the service account's project) to be
// registered with the Merchant Center account once. developerEmail must be a
// user on the Merchant Center account (they get the API_DEVELOPER role).
async function merchantAccountsCall(method, merchantId, path, body) {
  const token = await getAccessToken();
  const id = String(merchantId).replace(/[^0-9]/g, '');
  let lastErr = null;
  for (const version of ['v1', 'v1beta']) {
    const res = await fetch(`${MERCHANT_API}/accounts/${version}/accounts/${id}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    lastErr = new Error(`Merchant API-fel (${res.status}): ${data.error?.message || 'okänt fel'}`);
    if (res.status !== 404) throw lastErr; // 404 on v1 → try v1beta
  }
  throw lastErr;
}

export async function merchantRegisterGcp({ merchantId, developerEmail }) {
  if (!merchantId) throw new Error('Merchant Center account-id saknas');
  if (!developerEmail) throw new Error('E-post för utvecklare saknas');
  return merchantAccountsCall('POST', merchantId, 'developerRegistration:registerGcp', { developerEmail });
}

export async function merchantDeveloperRegistration({ merchantId }) {
  if (!merchantId) throw new Error('Merchant Center account-id saknas');
  return merchantAccountsCall('GET', merchantId, 'developerRegistration');
}
