// Prishistorik + "lägsta pris senaste 30 dagarna" (prisinformationslagen /
// EU:s omnibusdirektiv): when a product is sold at a reduced price, the shop
// must state the lowest price it charged during (at least) the 30 days
// BEFORE the reduction.
//
// - snapshotPrices() writes one row per SKU/day with live price + compare-at
//   (runs in the nightly cron and on demand).
// - saleReport() finds everything currently on sale (compare-at > price),
//   how long the sale has run, and the legal reference price.
// - syncLowestPriceMetafields() writes the reference price to the variant
//   metafield lumeno.lagsta_pris_30d so the Shopify theme can render it.
//   This is the only Shopify write here — a metafield, never a price.

import { supabase } from '../db.js';
import shopifySync from '../shopify.js';

const ymd = d => new Date(d).toISOString().slice(0, 10);
const daysAgo = n => ymd(new Date(Date.now() - n * 864e5));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function fetchAll(table, select, applyFilter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(select).range(from, from + 999);
    if (applyFilter) q = applyFilter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// Daily snapshot of every (single-SKU) variant's live price.
export async function snapshotPrices(store, prefetchedMap = null) {
  const map = prefetchedMap || (await shopifySync.fetchInventoryMapFromShopify(store)).map;
  const day = ymd(new Date());
  const rows = [];
  for (const [sku, list] of map) {
    if (list.length !== 1) continue; // duplicate SKUs are resolved manually
    const v = list[0];
    if (v.price == null) continue;
    rows.push({ store_id: store.id, sku, day, price: v.price, compare_at_price: v.compareAtPrice ?? null });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('price_history').upsert(rows.slice(i, i + 500), { onConflict: 'store_id,sku,day' });
    if (error) throw new Error(`price_history: ${error.message} (har migrationen add-price-history.sql körts?)`);
  }
  return { day, skus: rows.length };
}

// One-time: seed history from the price-watch daily benchmark rows (they
// carry our live price per day since the module went live).
export async function backfillFromBenchmarks(storeId) {
  const bm = await fetchAll('price_benchmarks', 'offer_id, sku', q => q.eq('store_id', storeId));
  const skuByOffer = new Map(bm.filter(b => b.sku).map(b => [b.offer_id, String(b.sku).trim()]));
  const hist = await fetchAll('price_benchmark_history', 'offer_id, day, our_price', q => q.eq('store_id', storeId));
  const rows = [];
  const seen = new Set();
  for (const h of hist) {
    const sku = skuByOffer.get(h.offer_id);
    if (!sku || h.our_price == null) continue;
    const k = `${sku}|${h.day}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ store_id: storeId, sku, day: h.day, price: h.our_price });
  }
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    // ignoreDuplicates: never overwrite a real snapshot (it also has compare-at)
    const { error } = await supabase.from('price_history').upsert(rows.slice(i, i + 500), { onConflict: 'store_id,sku,day', ignoreDuplicates: true });
    if (error) throw new Error(`price_history: ${error.message}`);
    inserted += Math.min(500, rows.length - i);
  }
  return { candidateRows: rows.length, inserted };
}

// Everything currently on sale, with sale length and the legal reference
// price: lowest price in the 30 days before the sale started. Falls back to
// the lowest known pre-sale price (flagged) while history is still short.
export async function saleReport(storeId, { cap = 200 } = {}) {
  let hist;
  try {
    hist = await fetchAll('price_history', 'sku, day, price, compare_at_price', q => q.eq('store_id', storeId).gte('day', daysAgo(75)));
  } catch (e) {
    return { migrationMissing: true, error: e.message, items: [], summary: {} };
  }
  if (!hist.length) return { items: [], summary: { onSale: 0, historyDays: 0 }, historyFrom: null };

  const bySku = new Map();
  for (const h of hist) {
    if (!bySku.has(h.sku)) bySku.set(h.sku, []);
    bySku.get(h.sku).push(h);
  }
  const today = ymd(new Date());
  let historyFrom = today;
  const items = [];
  for (const [sku, days] of bySku) {
    days.sort((a, b) => (a.day < b.day ? -1 : 1));
    if (days[0].day < historyFrom) historyFrom = days[0].day;
    const latest = days[days.length - 1];
    const price = num(latest.price), compareAt = num(latest.compare_at_price);
    if (!(compareAt != null && price != null && compareAt > price)) continue; // not on sale

    // Sale streak: walk back over consecutive snapshot days that were on sale.
    let i = days.length - 1;
    while (i > 0 && num(days[i - 1].compare_at_price) != null && num(days[i - 1].price) < num(days[i - 1].compare_at_price)) i--;
    const saleStart = days[i].day;
    const saleDays = Math.round((new Date(today) - new Date(saleStart)) / 864e5) + 1;

    // Legal reference: lowest price during the 30 days BEFORE the reduction.
    const windowFrom = ymd(new Date(new Date(saleStart) - 30 * 864e5));
    const pre30 = days.filter(d => d.day < saleStart && d.day >= windowFrom).map(d => num(d.price));
    const preAll = days.filter(d => d.day < saleStart).map(d => num(d.price));
    const lowestBeforeSale = pre30.length ? Math.min(...pre30) : (preAll.length ? Math.min(...preAll) : null);
    const displayLowest = lowestBeforeSale ?? compareAt; // last resort: ordinarie pris
    items.push({
      sku, price, compareAt, saleStart, saleDays,
      discountPct: Math.round((1 - price / compareAt) * 100),
      lowestBeforeSale, displayLowest,
      lowest30: Math.min(...days.filter(d => d.day >= daysAgo(30)).map(d => num(d.price))),
      approximate: !pre30.length, // history doesn't cover the full 30-day window
      dataFrom: days[0].day,
    });
  }

  // Titles + PIM product ids for the UI.
  const skus = new Set(items.map(x => x.sku));
  const prods = await fetchAll('products', 'id, sku, title', q => q.eq('store_id', storeId));
  const prodIds = new Set(prods.map(p => p.id));
  const bySkuTitle = new Map(prods.filter(p => p.sku).map(p => [String(p.sku).trim(), { title: p.title, productId: p.id }]));
  const vars = (await fetchAll('variants', 'product_id, sku')).filter(v => prodIds.has(v.product_id) && v.sku && skus.has(String(v.sku).trim()));
  const titleById = new Map(prods.map(p => [p.id, p.title]));
  for (const v of vars) {
    const k = String(v.sku).trim();
    if (!bySkuTitle.has(k)) bySkuTitle.set(k, { title: titleById.get(v.product_id), productId: v.product_id });
  }
  for (const it of items) Object.assign(it, bySkuTitle.get(it.sku) || {});

  items.sort((a, b) => b.saleDays - a.saleDays);
  return {
    historyFrom,
    items: items.slice(0, cap),
    summary: {
      onSale: items.length,
      longestDays: items[0]?.saleDays || 0,
      over14Days: items.filter(x => x.saleDays > 14).length,
      approximate: items.filter(x => x.approximate).length,
    },
  };
}

// Write lumeno.lagsta_pris_30d on every on-sale variant so the theme can show
// "Lägsta pris senaste 30 dagarna: X kr" without any runtime API calls.
export async function syncLowestPriceMetafields(store, prefetchedMap = null) {
  const report = await saleReport(store.id, { cap: 1000 });
  if (report.migrationMissing) throw new Error('Kör database/add-price-history.sql i Supabase först');
  const map = prefetchedMap || (await shopifySync.fetchInventoryMapFromShopify(store)).map;
  const client = shopifySync.getClient(store);

  const targets = [];
  for (const it of report.items) {
    const list = map.get(it.sku);
    if (!list || list.length !== 1 || !list[0].variantId || it.displayLowest == null) continue;
    targets.push({
      ownerId: list[0].variantId,
      namespace: 'lumeno', key: 'lagsta_pris_30d', type: 'number_decimal',
      value: String(it.displayLowest),
    });
  }
  let written = 0;
  const errors = [];
  for (let i = 0; i < targets.length; i += 25) {
    const batch = targets.slice(i, i + 25);
    const m = await client.graphql(
      'mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } } }',
      { m: batch });
    const errs = m.metafieldsSet?.userErrors || [];
    if (errs.length) errors.push(...errs.map(e => e.message));
    written += (m.metafieldsSet?.metafields || []).length;
    await new Promise(r => setTimeout(r, 200));
  }
  return { onSale: report.items.length, written, errors: errors.slice(0, 10) };
}
