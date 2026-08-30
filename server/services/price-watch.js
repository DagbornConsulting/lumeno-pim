// Prisbevakning (price watch).
//
// Compares the price of each Merchant Center offer against Google's price
// competitiveness benchmark (Market Insights) and stores a status per offer:
//   GRÅ  no benchmark → no verdict
//   RÖD  clearly above market AND room to go down (above floor price)
//   GUL  above market without room, or mildly above
//   BLÅ  clearly below market — we give away margin
//   OK   within band
//
// Hard rule: this module NEVER writes a price anywhere. It reads Merchant
// Center and PIM, writes only to the price_benchmarks* tables.
//
// Pack handling: Affari prices per unit, but the sold article can be a
// 2/4/6-pack ("Förpackningsantal dropship" → pack_qty). Google's benchmark is
// matched on GTIN, i.e. on the same sold article, so our_price and benchmark
// are compared as-is (pack level). pack_qty is used for the cost basis
// (cost × pack) and to show a unit price. It must NOT divide the benchmark.

import { db, supabase } from '../db.js';
import * as googleSeo from './google-seo.js';

export const DEFAULT_SETTINGS = {
  min_margin: 0.15,     // lowest accepted contribution on top of cost incl. VAT
  handling_fee: 0.20,   // Affari handling fee on purchase price
  vat: 0.25,
  ack_threshold: 0.08,  // relative benchmark move that re-opens an acknowledged alert
  high: 1.20,           // index above → RÖD (with room) / GUL
  warn: 1.10,           // index at/above → GUL
  low: 0.90,            // index below → BLÅ
};
export const STATUSES = ['RÖD', 'BLÅ', 'GUL', 'OK', 'GRÅ'];
const ALERT_STATUSES = ['RÖD', 'BLÅ', 'GUL'];

const round2 = n => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const round3 = n => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export function sanitizeSettings(raw = {}) {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v >= 0 && v < 10) out[k] = v;
  }
  return out;
}

export function getSettings(store) {
  return { ...DEFAULT_SETTINGS, ...sanitizeSettings(store?.settings?.price_watch || {}) };
}

// Offer ids from Shopify's Google & YouTube channel: shopify_SE_<productId>_<variantId>.
// PIM-generated feeds use the SKU (or the product uuid) as offer id.
export function parseOfferId(offerId) {
  const s = String(offerId || '').trim();
  const m = s.match(/^shopify_[A-Za-z]{2,3}_(\d+)_(\d+)$/);
  if (m) return { shopifyProductId: m[1], shopifyVariantId: m[2], sku: null };
  const m2 = s.match(/^shopify_[A-Za-z]{2,3}_(\d+)$/);
  if (m2) return { shopifyProductId: m2[1], shopifyVariantId: null, sku: null };
  return { shopifyProductId: null, shopifyVariantId: null, sku: s || null };
}

// floor = cost × (1 + handling fee) × (1 + VAT) × (1 + min margin)
export function computeFloor(costPrice, s) {
  if (costPrice == null || costPrice <= 0) return null;
  return round2(costPrice * (1 + s.handling_fee) * (1 + s.vat) * (1 + s.min_margin));
}

export function computeStatus({ ourPrice, benchmark, floor, settings: s }) {
  if (!benchmark || benchmark <= 0 || !ourPrice || ourPrice <= 0) return { index: null, status: 'GRÅ' };
  const index = ourPrice / benchmark;
  let status;
  if (index > s.high && floor != null && ourPrice > floor) status = 'RÖD';
  else if (index > s.high) status = 'GUL';      // above market but no (known) room downwards
  else if (index >= s.warn) status = 'GUL';
  else if (index < s.low) status = 'BLÅ';
  else status = 'OK';
  return { index: round3(index), status };
}

// Keep an acknowledgement while the benchmark stays within ack_threshold of
// the value it was acknowledged at; otherwise clear it (alert re-opens).
export function carryAcknowledgement(prev, benchmark, s) {
  const empty = { acknowledged_at: null, acknowledged_by: null, acknowledged_benchmark: null, acknowledged_note: null };
  if (!prev?.acknowledged_at) return { ack: empty, reopened: false };
  const ackB = num(prev.acknowledged_benchmark);
  const move = benchmark && ackB ? Math.abs(benchmark - ackB) / ackB : 0;
  if (move < s.ack_threshold) {
    return {
      ack: {
        acknowledged_at: prev.acknowledged_at,
        acknowledged_by: prev.acknowledged_by,
        acknowledged_benchmark: prev.acknowledged_benchmark,
        acknowledged_note: prev.acknowledged_note,
      },
      reopened: false,
    };
  }
  return { ack: empty, reopened: true };
}

// --- DB helpers -------------------------------------------------------------

async function fetchAll(table, select, applyFilter) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (applyFilter) q = applyFilter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// Index of PIM products/variants for matching Merchant offers.
async function buildIndex(storeId) {
  const products = await fetchAll('products', 'id, sku, title, status, default_cost, default_price, pack_qty, shopify_product_id', q => q.eq('store_id', storeId));
  const productById = new Map(products.map(p => [p.id, p]));
  const variants = (await fetchAll('variants', 'id, product_id, sku, cost, price, pack_qty, shopify_variant_id'))
    .filter(v => productById.has(v.product_id));
  const storeProducts = await fetchAll('store_products', 'product_id, shopify_product_id', q => q.eq('store_id', storeId));

  const byShopifyProductId = new Map();
  for (const p of products) if (p.shopify_product_id) byShopifyProductId.set(String(p.shopify_product_id), p);
  for (const sp of storeProducts) {
    const p = productById.get(sp.product_id);
    if (p && sp.shopify_product_id) byShopifyProductId.set(String(sp.shopify_product_id), p);
  }
  const productBySku = new Map();
  for (const p of products) if (p.sku) productBySku.set(String(p.sku).trim(), p);
  const variantBySku = new Map();
  const byShopifyVariantId = new Map();
  const variantsByProduct = new Map();
  for (const v of variants) {
    if (v.sku) variantBySku.set(String(v.sku).trim(), v);
    if (v.shopify_variant_id) byShopifyVariantId.set(String(v.shopify_variant_id), v);
    if (!variantsByProduct.has(v.product_id)) variantsByProduct.set(v.product_id, []);
    variantsByProduct.get(v.product_id).push(v);
  }
  return { products, productById, byShopifyProductId, productBySku, variantBySku, byShopifyVariantId, variantsByProduct };
}

export function matchOffer(offerId, idx) {
  const p = parseOfferId(offerId);
  let product = null, variant = null;
  if (p.shopifyVariantId) variant = idx.byShopifyVariantId.get(p.shopifyVariantId) || null;
  if (variant) product = idx.productById.get(variant.product_id) || null;
  if (!product && p.shopifyProductId) product = idx.byShopifyProductId.get(p.shopifyProductId) || null;
  if (!product && p.sku) {
    variant = idx.variantBySku.get(p.sku) || null;
    product = variant ? idx.productById.get(variant.product_id) || null : idx.productBySku.get(p.sku) || null;
  }
  if (product && !variant) {
    const vs = idx.variantsByProduct.get(product.id) || [];
    if (vs.length === 1) variant = vs[0];
  }
  return { product, variant };
}

function buildRow({ offer, product, variant, prev, settings, now }) {
  const pack = Math.max(1, Number(variant?.pack_qty ?? product?.pack_qty ?? 1) || 1);
  const unitCost = num(variant?.cost ?? product?.default_cost);
  const costPrice = unitCost != null ? round2(unitCost * pack) : null;
  const floor = computeFloor(costPrice, settings);
  const ourPrice = num(offer.price);
  const benchmark = num(offer.benchmark);
  const { index, status } = computeStatus({ ourPrice, benchmark, floor, settings });
  const { ack, reopened } = carryAcknowledgement(prev, benchmark, settings);

  return {
    row: {
      offer_id: offer.offerId,
      product_id: product?.id || null,
      variant_id: variant?.id || null,
      sku: variant?.sku || product?.sku || (parseOfferId(offer.offerId).sku) || null,
      title: (product?.title || offer.title || '').slice(0, 500) || null,
      brand: offer.brand || null,
      country_code: offer.country || null,
      currency: offer.currency || null,
      our_price: round2(ourPrice),
      benchmark_price: round2(benchmark),
      benchmark_fetched_at: now,
      reference_source: benchmark ? 'merchant' : null,
      pack_qty: pack,
      unit_price_ours: ourPrice != null ? round2(ourPrice / pack) : null,
      cost_price: costPrice,
      floor_price: floor,
      price_index: index,
      price_status: status,
      ...ack,
      reopened_count: (prev?.reopened_count || 0) + (reopened ? 1 : 0),
      first_seen_at: prev?.first_seen_at || now,
    },
    reopened,
  };
}

// --- Runs -------------------------------------------------------------------

export async function runFetch({ store, trigger = 'manual' }) {
  if (!supabase) throw new Error('Databas ej konfigurerad');
  const merchantId = store?.settings?.google?.merchant_id;
  if (!merchantId) throw new Error('Merchant Center account-id ej konfigurerat');
  const settings = getSettings(store);

  const { data: run, error: runErr } = await supabase.from('price_watch_runs')
    .insert({ store_id: store.id, trigger, status: 'running' }).select().single();
  if (runErr) throw new Error(`price_watch_runs: ${runErr.message} (har migrationen add-price-watch.sql körts?)`);

  try {
    let offers = await googleSeo.merchantPriceCompetitiveness({ merchantId });
    // Keep the store's market only when the report spans several countries.
    const country = (store.country_code || '').toUpperCase();
    if (country && offers.some(o => o.country && o.country.toUpperCase() !== country)) {
      offers = offers.filter(o => !o.country || o.country.toUpperCase() === country);
    }
    // One row per offer (the report can repeat an offer per country).
    const seen = new Map();
    for (const o of offers) if (!seen.has(o.offerId) || (o.benchmark && !seen.get(o.offerId).benchmark)) seen.set(o.offerId, o);
    offers = [...seen.values()];

    const idx = await buildIndex(store.id);
    const prevRows = await fetchAll('price_benchmarks', '*', q => q.eq('store_id', store.id));
    const prevByOffer = new Map(prevRows.map(r => [r.offer_id, r]));
    const now = new Date().toISOString();
    const day = now.slice(0, 10);

    const rows = [], history = [];
    let matched = 0, withBenchmark = 0, reopened = 0;
    for (const offer of offers) {
      const { product, variant } = matchOffer(offer.offerId, idx);
      if (product) matched++;
      if (offer.benchmark) withBenchmark++;
      const { row, reopened: r } = buildRow({ offer, product, variant, prev: prevByOffer.get(offer.offerId), settings, now });
      if (r) reopened++;
      rows.push({ store_id: store.id, ...row });
      history.push({ store_id: store.id, offer_id: row.offer_id, day, our_price: row.our_price, benchmark_price: row.benchmark_price, price_index: row.price_index, price_status: row.price_status });
    }

    // Chunked + parallel writes: keeps the run well inside serverless time limits.
    const CHUNK = 400;
    const chunks = (arr) => Array.from({ length: Math.ceil(arr.length / CHUNK) }, (_, i) => arr.slice(i * CHUNK, (i + 1) * CHUNK));
    await Promise.all([
      ...chunks(rows).map(async part => {
        const { error } = await supabase.from('price_benchmarks').upsert(part, { onConflict: 'store_id,offer_id' });
        if (error) throw new Error(`price_benchmarks: ${error.message}`);
      }),
      ...chunks(history).map(async part => {
        const { error } = await supabase.from('price_benchmark_history').upsert(part, { onConflict: 'store_id,offer_id,day' });
        if (error) throw new Error(`price_benchmark_history: ${error.message}`);
      }),
    ]);

    const summary = { offers: offers.length, withBenchmark, matched, reopened, coverage: offers.length ? round3(withBenchmark / offers.length) : 0 };
    await supabase.from('price_watch_runs').update({
      status: 'ok', finished_at: new Date().toISOString(),
      offers_total: offers.length, with_benchmark: withBenchmark, matched, reopened,
    }).eq('id', run.id);
    console.log(`💰 Prisbevakning ${store.name}: ${offers.length} offers, ${withBenchmark} med benchmark (${Math.round(summary.coverage * 100)} %), ${matched} matchade mot PIM, ${reopened} återöppnade`);
    return summary;
  } catch (e) {
    await supabase.from('price_watch_runs').update({ status: 'error', finished_at: new Date().toISOString(), error: String(e.message || e).slice(0, 2000) }).eq('id', run.id);
    throw e;
  }
}

// --- Queries ----------------------------------------------------------------

// Impact = price gap in SEK × units sold last 30 days (min 1, so products
// without sales still rank by gap). Sales come from applySales().
const impactOf = r => {
  const ours = num(r.our_price), b = num(r.benchmark_price);
  const gap = ours != null && b != null ? Math.abs(ours - b) : 0;
  return gap * Math.max(1, Number(r.units_30d) || 0);
};

// Write per-SKU sales (from Shopify orders) onto the benchmark rows.
export async function applySales(storeId, bySku) {
  if (!bySku || !Object.keys(bySku).length) return { updated: 0 };
  const rows = await fetchAll('price_benchmarks', 'id, sku', q => q.eq('store_id', storeId).not('sku', 'is', null));
  const groups = new Map(); // "units|revenue" -> [ids]
  for (const r of rows) {
    const s = bySku[String(r.sku).trim()];
    const key = s ? `${s.units}|${Math.round(s.revenue)}` : '0|0';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.id);
  }
  let updated = 0;
  for (const [key, ids] of groups) {
    const [units, revenue] = key.split('|').map(Number);
    if (units === 0 && revenue === 0 && ids.length === rows.length) continue; // nothing sold, nothing to write
    for (let i = 0; i < ids.length; i += 300) {
      const { error } = await supabase.from('price_benchmarks').update({ units_30d: units, revenue_30d: revenue }).in('id', ids.slice(i, i + 300));
      if (error) { if (/units_30d/.test(error.message)) return { updated: 0, migrationMissing: true }; throw new Error(error.message); }
      updated += Math.min(300, ids.length - i);
    }
  }
  return { updated };
}

export async function listItems({ storeId, status, open, q, sort = 'impact', limit = 2000 }) {
  let query = supabase.from('price_benchmarks').select('*').eq('store_id', storeId);
  if (status && STATUSES.includes(status)) query = query.eq('price_status', status);
  if (open) query = query.in('price_status', ALERT_STATUSES).is('acknowledged_at', null);
  if (q) {
    const s = String(q).replace(/[,()%]/g, ' ').trim();
    if (s) query = query.or(`title.ilike.%${s}%,sku.ilike.%${s}%,offer_id.ilike.%${s}%`);
  }
  const { data, error } = await query.limit(Math.min(5000, Math.max(1, Number(limit) || 2000)));
  if (error) throw new Error(error.message);
  const rows = data || [];
  const statusRank = { 'RÖD': 0, 'BLÅ': 1, 'GUL': 2, 'OK': 3, 'GRÅ': 4 };
  if (sort === 'index') rows.sort((a, b) => Math.abs((num(b.price_index) ?? 1) - 1) - Math.abs((num(a.price_index) ?? 1) - 1));
  else if (sort === 'title') rows.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'sv'));
  else rows.sort((a, b) => (statusRank[a.price_status] - statusRank[b.price_status]) || (impactOf(b) - impactOf(a)));
  return rows;
}

// Offers whose live price is below the computed floor price (we lose margin
// regardless of what the market does). Sorted by how far below.
export async function underFloor({ storeId, limit = 20 }) {
  const { data, error } = await supabase.from('price_benchmarks')
    .select('id, offer_id, sku, title, our_price, benchmark_price, floor_price, cost_price, pack_qty, price_status, product_id')
    .eq('store_id', storeId).not('floor_price', 'is', null).limit(5000);
  if (error) throw new Error(error.message);
  return (data || [])
    .filter(r => num(r.our_price) != null && num(r.our_price) < num(r.floor_price))
    .sort((a, b) => (num(b.floor_price) - num(b.our_price)) - (num(a.floor_price) - num(a.our_price)))
    .slice(0, limit);
}

export async function summary(storeId) {
  const empty = { total: 0, withBenchmark: 0, coverage: 0, byStatus: {}, open: {}, acknowledged: 0, lastRun: null, packProducts: 0 };
  if (!supabase) return empty;
  let rows = [];
  try {
    rows = await fetchAll('price_benchmarks', 'price_status, acknowledged_at, benchmark_price, benchmark_fetched_at', q => q.eq('store_id', storeId));
  } catch (e) {
    // Table missing → migration not run yet. Surface that instead of a 500.
    return { ...empty, migrationMissing: true, error: e.message };
  }
  const byStatus = {}, open = {};
  let acknowledged = 0, withBenchmark = 0, lastFetched = null;
  for (const r of rows) {
    byStatus[r.price_status] = (byStatus[r.price_status] || 0) + 1;
    if (r.benchmark_price != null) withBenchmark++;
    if (r.acknowledged_at) acknowledged++;
    else if (ALERT_STATUSES.includes(r.price_status)) open[r.price_status] = (open[r.price_status] || 0) + 1;
    if (r.benchmark_fetched_at && (!lastFetched || r.benchmark_fetched_at > lastFetched)) lastFetched = r.benchmark_fetched_at;
  }
  const { data: runs } = await supabase.from('price_watch_runs').select('*').eq('store_id', storeId).order('started_at', { ascending: false }).limit(1);
  const { count: packProducts } = await supabase.from('products').select('*', { count: 'exact', head: true }).eq('store_id', storeId).gt('pack_qty', 1);
  return {
    total: rows.length, withBenchmark, coverage: rows.length ? round3(withBenchmark / rows.length) : 0,
    byStatus, open, acknowledged, lastFetched, lastRun: runs?.[0] || null, packProducts: packProducts || 0,
  };
}

export async function listRuns(storeId, limit = 20) {
  const { data, error } = await supabase.from('price_watch_runs').select('*').eq('store_id', storeId).order('started_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

// --- Acknowledgement --------------------------------------------------------

export async function acknowledge({ storeId, id, user, note }) {
  const { data: row, error: e1 } = await supabase.from('price_benchmarks').select('*').eq('id', id).eq('store_id', storeId).single();
  if (e1 || !row) throw new Error('Raden hittades inte');
  const patch = {
    acknowledged_at: new Date().toISOString(),
    acknowledged_by: String(user || 'okänd').slice(0, 255),
    acknowledged_benchmark: row.benchmark_price,
    acknowledged_note: note ? String(note).slice(0, 2000) : null,
  };
  const { data, error } = await supabase.from('price_benchmarks').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  try { await db.logActivity('price_watch_ack', 'price_benchmark', id, `Kvitterade prisvarning ${row.price_status} för ${row.title || row.sku || row.offer_id}`, { benchmark: row.benchmark_price, our_price: row.our_price, note: patch.acknowledged_note, by: patch.acknowledged_by }); } catch (_) {}
  return data;
}

export async function unacknowledge({ storeId, id, user }) {
  const { data, error } = await supabase.from('price_benchmarks')
    .update({ acknowledged_at: null, acknowledged_by: null, acknowledged_benchmark: null, acknowledged_note: null })
    .eq('id', id).eq('store_id', storeId).select().single();
  if (error) throw new Error(error.message);
  try { await db.logActivity('price_watch_unack', 'price_benchmark', id, `Ångrade kvittering för ${data?.title || data?.sku || id}`, { by: user }); } catch (_) {}
  return data;
}

// --- Export -----------------------------------------------------------------

export async function exportCsv(storeId) {
  const rows = await listItems({ storeId, limit: 5000 });
  const H = ['status', 'kvitterad', 'sku', 'titel', 'offer_id', 'pack', 'vart_pris', 'styckpris', 'benchmark', 'index', 'inkop_per_artikel', 'golvpris', 'salda_30d', 'kalla', 'antal_kallor', 'hamtad', 'kvitterad_av', 'kvitterad_datum', 'kvitterad_benchmark', 'kvittering_notering'];
  const esc = v => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = rows.map(r => [
    r.price_status, r.acknowledged_at ? 'ja' : 'nej', r.sku, r.title, r.offer_id, r.pack_qty, r.our_price, r.unit_price_ours, r.benchmark_price,
    r.price_index, r.cost_price, r.floor_price, r.units_30d ?? 0, r.reference_source, r.source_count, r.benchmark_fetched_at,
    r.acknowledged_by, r.acknowledged_at, r.acknowledged_benchmark, r.acknowledged_note,
  ].map(esc).join(';'));
  return '﻿' + H.join(';') + '\n' + lines.join('\n');
}

// --- pack_qty import --------------------------------------------------------

// rows: parsed spreadsheet rows (header → value). Accepts Affari's export
// ("Artikelnummer" + "Förpackningsantal dropship") or a plain sku/pack_qty file.
export async function importPackQty({ storeId, rows }) {
  if (!rows?.length) throw new Error('Filen är tom');
  const headers = Object.keys(rows[0]);
  const skuKey = headers.find(h => /^(artikelnummer|artnr|sku|artikel)$/i.test(h.trim()));
  const packKey = headers.find(h => /förpackningsantal|forpackningsantal|pack_qty|^pack$|^antal$/i.test(h.trim()));
  if (!skuKey || !packKey) throw new Error(`Hittar inte kolumnerna. Behöver "Artikelnummer" och "Förpackningsantal dropship". Fanns: ${headers.join(', ')}`);

  const byPack = new Map(); // pack → [sku]
  let parsed = 0;
  for (const r of rows) {
    const sku = String(r[skuKey] || '').trim();
    const pack = Math.round(Number(String(r[packKey] ?? '').replace(',', '.')));
    if (!sku || !Number.isFinite(pack) || pack < 1) continue;
    parsed++;
    if (!byPack.has(pack)) byPack.set(pack, []);
    byPack.get(pack).push(sku);
  }
  if (!parsed) throw new Error('Inga rader med artikelnummer + förpackningsantal');

  let productsUpdated = 0, variantsUpdated = 0;
  const CHUNK = 200;
  for (const [pack, skus] of byPack) {
    for (let i = 0; i < skus.length; i += CHUNK) {
      const part = skus.slice(i, i + CHUNK);
      const { data: p, error: e1 } = await supabase.from('products').update({ pack_qty: pack }).eq('store_id', storeId).in('sku', part).select('id');
      if (e1) throw new Error(`products.pack_qty: ${e1.message} (har migrationen add-price-watch.sql körts?)`);
      productsUpdated += p?.length || 0;
      const { data: v, error: e2 } = await supabase.from('variants').update({ pack_qty: pack }).in('sku', part).select('id');
      if (e2) throw new Error(`variants.pack_qty: ${e2.message}`);
      variantsUpdated += v?.length || 0;
    }
  }
  const multi = [...byPack].filter(([p]) => p > 1).reduce((a, [, s]) => a + s.length, 0);
  return { rowsInFile: rows.length, parsed, multiPackInFile: multi, productsUpdated, variantsUpdated };
}
