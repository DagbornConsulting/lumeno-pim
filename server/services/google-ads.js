// Google Ads: läsning av kostnad/klick/konverteringar + varningar för kortet
// på Översikten, och en rå GAQL-fråga för analys.
//
// Auth är OAuth (Ads-API:t stödjer inte service-konton utan Workspace-
// delegering): en engångs "Koppla Google Ads" i kortet ger en refresh-token
// som sparas i store.settings.google_ads. App-nycklarna delas med Todas-
// plattformens Ads-uppsättning och läses från env:
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID (bara om kontot nås via MCC:t)
//
// Ingenting här skriver till Google Ads — enbart läsning.

import { supabase } from '../db.js';

const API = 'https://googleads.googleapis.com/v23';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/adwords';

export function isConfigured() {
  return !!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_CLIENT_ID && process.env.GOOGLE_ADS_CLIENT_SECRET);
}

export function getConnection(store) {
  const g = store?.settings?.google_ads || {};
  return {
    connected: !!(g.refresh_token && g.customer_id),
    customerId: g.customer_id || null,
    candidates: g.candidates || null,
    hasRefreshToken: !!g.refresh_token,
    connectedAt: g.connected_at || null,
  };
}

// --- OAuth ------------------------------------------------------------------

export function oauthStartUrl({ redirectUri, state }) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // garanterar att en refresh_token kommer med
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode({ code, redirectUri }) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_ADS_CLIENT_ID, client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`OAuth-utbyte misslyckades: ${d.error_description || d.error || r.status}`);
  return d; // { access_token, refresh_token, ... }
}

const _tokCache = new Map(); // refresh_token -> { token, exp }
async function accessToken(refreshToken) {
  const hit = _tokCache.get(refreshToken);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken, client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET, grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Google Ads-token misslyckades: ${d.error_description || d.error || r.status}. Koppla om Google Ads i Översikten.`);
  _tokCache.set(refreshToken, { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 });
  return d.access_token;
}

// --- API-anrop --------------------------------------------------------------

async function adsFetch(path, { token, loginCustomerId, body, method = 'POST' } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId).replace(/-/g, '');
  const r = await fetch(`${API}/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = d?.error?.details?.[0]?.errors?.[0]?.message || d?.error?.message || `HTTP ${r.status}`;
    const err = new Error(`Google Ads: ${msg}`);
    err.status = r.status;
    throw err;
  }
  return d;
}

// GAQL-sökning med paginering. Returnerar råa result-rader.
export async function search(store, gaql, { customerId } = {}) {
  const g = store?.settings?.google_ads || {};
  const cid = String(customerId || g.customer_id || '').replace(/-/g, '');
  if (!isConfigured()) throw new Error('Google Ads-nycklar saknas på servern (GOOGLE_ADS_DEVELOPER_TOKEN m.fl.).');
  if (!g.refresh_token) throw new Error('Google Ads är inte kopplat. Klicka "Koppla Google Ads" i Översikten.');
  if (!cid) throw new Error('Inget Ads-konto valt.');
  const token = await accessToken(g.refresh_token);
  const loginCustomerId = g.login_customer_id || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || null;
  const out = [];
  let pageToken;
  do {
    const d = await adsFetch(`customers/${cid}/googleAds:search`, {
      token, loginCustomerId,
      body: { query: gaql, pageSize: 1000, ...(pageToken ? { pageToken } : {}) },
    });
    out.push(...(d.results || []));
    pageToken = d.nextPageToken;
  } while (pageToken && out.length < 10000);
  return out;
}

// Konton som den inloggade Google-användaren kommer åt (för kontoväljaren).
export async function listAccessibleCustomers(refreshToken) {
  const token = await accessToken(refreshToken);
  const d = await adsFetch('customers:listAccessibleCustomers', { token, method: 'GET' });
  const ids = (d.resourceNames || []).map(rn => rn.split('/')[1]);
  const out = [];
  for (const id of ids) {
    let name = null, manager = false, currency = null;
    for (const login of [null, process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || null]) {
      try {
        const r = await adsFetch(`customers/${id}/googleAds:search`, {
          token, loginCustomerId: login,
          body: { query: 'SELECT customer.descriptive_name, customer.manager, customer.currency_code FROM customer LIMIT 1' },
        });
        const c = r.results?.[0]?.customer || {};
        name = c.descriptiveName || null; manager = !!c.manager; currency = c.currencyCode || null;
        break;
      } catch (_) { /* prova nästa login-variant */ }
    }
    out.push({ id, name, manager, currency });
  }
  return out;
}

// Testa åtkomst till ett konto; returnerar vilken login-customer-id som
// fungerade (null = direktåtkomst) eller kastar om ingen väg fungerar.
export async function probeAccess(refreshToken, customerId) {
  const token = await accessToken(refreshToken);
  const tries = [null, process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || null];
  let lastErr;
  for (const login of tries) {
    try {
      await adsFetch(`customers/${String(customerId).replace(/-/g, '')}/googleAds:search`, {
        token, loginCustomerId: login,
        body: { query: 'SELECT customer.id FROM customer LIMIT 1' },
      });
      return { loginCustomerId: login };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Ingen åtkomst till kontot');
}

// --- Rapporten till Översikten ----------------------------------------------

const ymdDaysAgo = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const money = micros => Math.round((Number(micros) || 0) / 1e6 * 100) / 100;

export async function adsReport(store) {
  const dailyGaql = (from, to) => `
    SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions,
           metrics.conversions, metrics.conversions_value
    FROM customer WHERE segments.date BETWEEN '${from}' AND '${to}'`;

  const [curRows, prevRows, campMeta, campMetrics, badAds] = await Promise.all([
    search(store, dailyGaql(ymdDaysAgo(28), ymdDaysAgo(1))),
    search(store, dailyGaql(ymdDaysAgo(56), ymdDaysAgo(29))),
    search(store, `SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status,
                          campaign.primary_status_reasons, campaign.advertising_channel_type,
                          campaign_budget.amount_micros
                   FROM campaign WHERE campaign.status IN ('ENABLED','PAUSED')`),
    search(store, `SELECT campaign.id, metrics.cost_micros, metrics.clicks, metrics.conversions,
                          metrics.conversions_value
                   FROM campaign WHERE campaign.status IN ('ENABLED','PAUSED')
                     AND segments.date BETWEEN '${ymdDaysAgo(28)}' AND '${ymdDaysAgo(1)}'`),
    search(store, `SELECT campaign.name, ad_group.name, ad_group_ad.ad.id,
                          ad_group_ad.policy_summary.approval_status,
                          ad_group_ad.policy_summary.policy_topic_entries
                   FROM ad_group_ad
                   WHERE ad_group_ad.status != 'REMOVED'
                     AND campaign.status = 'ENABLED'
                     AND ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED','AREA_OF_INTEREST_ONLY')`)
      .catch(() => []),
  ]);

  const sumDay = rows => {
    const byDate = new Map();
    let cost = 0, clicks = 0, impressions = 0, conversions = 0, value = 0;
    for (const r of rows) {
      const m = r.metrics || {};
      const day = { date: r.segments?.date, cost: money(m.costMicros), clicks: Number(m.clicks) || 0 };
      byDate.set(day.date, day);
      cost += day.cost; clicks += day.clicks;
      impressions += Number(m.impressions) || 0;
      conversions += Number(m.conversions) || 0;
      value += Number(m.conversionsValue) || 0;
    }
    return { cost: Math.round(cost), clicks, impressions, conversions: Math.round(conversions * 10) / 10, value: Math.round(value), byDate };
  };
  const cur = sumDay(curRows), prev = sumDay(prevRows);

  // Jämn tidsaxel för sparkline (dagar utan spend saknas i svaret).
  const series = [];
  for (let i = 28; i >= 1; i--) {
    const date = ymdDaysAgo(i);
    const d = cur.byDate.get(date) || { cost: 0, clicks: 0 };
    series.push({ date, cost: d.cost, clicks: d.clicks });
  }

  const metricsById = new Map(campMetrics.map(r => [r.campaign?.id, r.metrics || {}]));
  const campaigns = campMeta.map(r => {
    const c = r.campaign || {}, m = metricsById.get(c.id) || {};
    return {
      id: c.id, name: c.name, status: c.status,
      primaryStatus: c.primaryStatus || null,
      primaryStatusReasons: c.primaryStatusReasons || [],
      channel: c.advertisingChannelType || null,
      dailyBudget: money(r.campaignBudget?.amountMicros),
      cost: money(m.costMicros), clicks: Number(m.clicks) || 0,
      conversions: Math.round((Number(m.conversions) || 0) * 10) / 10,
      value: Math.round(Number(m.conversionsValue) || 0),
    };
  }).sort((a, b) => b.cost - a.cost);

  // Varningar: kampanjer som inte serverar fullt ut + underkända annonser.
  const warnings = [];
  for (const c of campaigns) {
    if (c.status !== 'ENABLED') continue;
    if (c.primaryStatus && !['ELIGIBLE', 'LEARNING'].includes(c.primaryStatus)) {
      warnings.push({ level: ['NOT_ELIGIBLE', 'MISCONFIGURED', 'REMOVED'].includes(c.primaryStatus) ? 'red' : 'amber',
        text: `Kampanj "${c.name}": ${c.primaryStatus}${c.primaryStatusReasons.length ? ` (${c.primaryStatusReasons.join(', ')})` : ''}` });
    }
  }
  for (const r of badAds) {
    const topics = (r.adGroupAd?.policySummary?.policyTopicEntries || []).map(t => t.topic).filter(Boolean);
    warnings.push({ level: 'red', text: `Underkänd annons i "${r.campaign?.name}"${topics.length ? `: ${topics.join(', ')}` : ''} (annons-id ${r.adGroupAd?.ad?.id})` });
  }

  return {
    fetchedAt: new Date().toISOString(),
    customerId: store?.settings?.google_ads?.customer_id || null,
    cost: cur.cost, clicks: cur.clicks, impressions: cur.impressions,
    conversions: cur.conversions, value: cur.value,
    roas: cur.cost > 0 ? Math.round(cur.value / cur.cost * 100) / 100 : null,
    prev: { cost: prev.cost, clicks: prev.clicks, impressions: prev.impressions, conversions: prev.conversions, value: prev.value },
    series, campaigns, warnings,
  };
}

// Spara/uppdatera kopplingen i store.settings.google_ads.
export async function saveConnection(storeId, currentSettings, patch) {
  const next = { ...(currentSettings || {}) };
  next.google_ads = { ...(next.google_ads || {}), ...patch };
  const { error } = await supabase.from('stores').update({ settings: next }).eq('id', storeId);
  if (error) throw new Error(`Kunde inte spara Google Ads-koppling: ${error.message}`);
  return next.google_ads;
}
