// Supplier file (Affari) import + report.
//
// Two file types are recognised by their headers:
//   Dropship.csv        Artikelnummer; Benämning; Lagersaldo; I lager; Lev. vecka;
//                       Godkänd för dropship; EAN-kod; ...; Grundpris; Uppdaterat
//   ExcelExportGeneral  Artikelnummer | Namn | ... | EAN-kod |
//                       Förpackningsantal dropship | Pris (SEK)
// Both write a snapshot to supplier_stock. The Excel export also sets pack_qty
// on products/variants (via price-watch.importPackQty). Nothing here changes
// a PIM price or a Shopify price — cost changes are only *reported*.

import { supabase } from '../db.js';
import { importPackQty } from './price-watch.js';

const num = v => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
// House rule: sale prices always end in 9 — round UP to the nearest ...9.
export const roundUp9 = v => { const n = Math.ceil(Number(v) || 0); return n + ((9 - (n % 10) + 10) % 10); };
const yes = v => /^(ja|yes|true|1)$/i.test(String(v ?? '').trim());
const find = (headers, re) => headers.find(h => re.test(String(h).trim()));

async function fetchAll(table, select, applyFilter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(select).order('id', { ascending: true }).range(from, from + 999);
    if (applyFilter) q = applyFilter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export function detectFileType(headers) {
  const h = headers.map(x => String(x).trim());
  if (find(h, /^lagersaldo$/i) && find(h, /^grundpris$/i)) return 'dropship';
  if (find(h, /förpackningsantal/i) && find(h, /^pris \(sek\)/i)) return 'export';
  return null;
}

export async function importSupplierFile({ storeId, rows, filename = '' }) {
  if (!rows?.length) throw new Error('Filen är tom');
  const headers = Object.keys(rows[0]);
  const type = detectFileType(headers);
  if (!type) throw new Error(`Känner inte igen filen. Behöver antingen Affaris Dropship-CSV (Lagersaldo, Grundpris) eller ExcelExportGeneral (Förpackningsantal dropship, Pris (SEK)). Kolumner: ${headers.slice(0, 8).join(', ')}…`);

  const K = {
    sku: find(headers, /^artikelnummer$/i),
    name: find(headers, /^(benämning|namn)$/i),
    ean: find(headers, /^ean/i),
    price: type === 'dropship' ? find(headers, /^grundpris$/i) : find(headers, /^pris \(sek\)/i),
    pack: find(headers, /förpackningsantal/i),
    stock: find(headers, /^lagersaldo$/i),
    inStock: find(headers, /^i lager$/i),
    dropship: find(headers, /godkänd för dropship/i),
    week: find(headers, /lev\.? ?vecka/i),
    updated: find(headers, /^uppdaterat$/i),
  };
  const now = new Date().toISOString();
  const seen = new Map();
  for (const r of rows) {
    const sku = String(r[K.sku] || '').trim();
    if (!sku) continue;
    const row = { store_id: storeId, sku, source_file: filename.slice(0, 255), imported_at: now };
    if (K.name) row.name = String(r[K.name] || '').slice(0, 500) || null;
    if (K.ean) row.ean = String(r[K.ean] || '').trim().slice(0, 32) || null;
    if (K.price) row.supplier_price = num(r[K.price]);
    if (K.pack) { const p = Math.round(num(r[K.pack]) || 0); row.pack_qty = p >= 1 ? p : null; }
    if (K.stock) row.stock = Math.round(num(r[K.stock]) ?? 0);
    if (K.inStock) row.in_stock = yes(r[K.inStock]);
    if (K.dropship) row.dropship_ok = yes(r[K.dropship]);
    if (K.week) row.delivery_week = String(r[K.week] || '').slice(0, 10) || null;
    if (K.updated) { const d = new Date(String(r[K.updated] || '').replace(' +', '+')); row.supplier_updated_at = isNaN(d) ? null : d.toISOString(); }
    seen.set(sku, row); // last row wins on duplicate SKU
  }
  const upserts = [...seen.values()];
  if (!upserts.length) throw new Error('Inga rader med artikelnummer');
  let packEvents = 0;

  // Upptäck att Affari ÄNDRAT förpackningen: "N-pack" i namnet som tillkommit
  // eller bytt tal sedan förra filen. (Namn som alltid haft "50-pack" är själva
  // artikeln och larmar inte.) Loggas som händelse och visas i Affari-kortet.
  const packMarker = (name) => { const m = String(name || '').match(/(\d+)\s*-\s*pack/i); return m ? Math.max(1, parseInt(m[1], 10)) : null; };
  if (type === 'dropship') {
    try {
      const prev = await fetchAll('supplier_stock', 'sku, name, supplier_price', q => q.eq('store_id', storeId));
      const prevBySku = new Map(prev.map(r => [r.sku, r]));
      for (const row of upserts) {
        const old = prevBySku.get(row.sku);
        if (!old || !old.name || !row.name) continue;
        const oldM = packMarker(old.name), newM = packMarker(row.name);
        if (oldM === newM) continue;
        packEvents++;
        await supabase.from('activity_log').insert({
          store_id: storeId, action: 'supplier_pack_change', entity_type: 'store', entity_id: storeId,
          description: `Affari ändrade förpackning för ${row.sku}: "${old.name}" → "${row.name}"`,
          changes: { sku: row.sku, oldName: old.name, newName: row.name, oldPackMarker: oldM, newPackMarker: newM, supplierPrice: row.supplier_price ?? old.supplier_price ?? null },
        });
      }
    } catch (e) { console.warn('pack-change detection:', e.message); }
  }

  for (let i = 0; i < upserts.length; i += 400) {
    const { error } = await supabase.from('supplier_stock').upsert(upserts.slice(i, i + 400), { onConflict: 'store_id,sku' });
    if (error) throw new Error(`supplier_stock: ${error.message} (har migrationen add-dashboard.sql körts?)`);
  }

  let pack = null;
  if (type === 'export') {
    // Flagga pack-ändringar mot PIM innan importPackQty skriver över dem —
    // annars uppdateras förpackningen tyst utan att priset följer med.
    try {
      const pimProds = await fetchAll('products', 'sku, pack_qty, default_cost', q => q.eq('store_id', storeId));
      const pimBySku = new Map(pimProds.filter(x => x.sku).map(x => [String(x.sku).trim(), x]));
      for (const row of upserts) {
        if (row.pack_qty == null) continue;
        const pim = pimBySku.get(row.sku);
        if (!pim || Number(pim.pack_qty || 1) === Number(row.pack_qty)) continue;
        packEvents++;
        await supabase.from('activity_log').insert({
          store_id: storeId, action: 'supplier_pack_change', entity_type: 'store', entity_id: storeId,
          description: `Affari ändrade förpackningsantal för ${row.sku}: ${pim.pack_qty || 1} → ${row.pack_qty} (${row.name || ''})`,
          changes: { sku: row.sku, oldPackMarker: Number(pim.pack_qty || 1), newPackMarker: Number(row.pack_qty), supplierPrice: row.supplier_price ?? pim.default_cost ?? null, kalla: 'excel' },
        });
      }
    } catch (e) { console.warn('pack-diff (excel):', e.message); }
    try { pack = await importPackQty({ storeId, rows }); } catch (e) { pack = { error: e.message }; }
  }
  const report = await supplierReport(storeId);
  return { type, rows: rows.length, imported: upserts.length, pack, packEvents, report: { counts: report.counts, lastImport: report.lastImport } };
}

// What the latest supplier snapshot says about our live catalogue.
export async function supplierReport(storeId, cap = 15) {
  const empty = { counts: {}, lastImport: null, outOfStock: [], notDropship: [], priceChanged: [], notInSupplier: [], migrationMissing: false };
  let stock;
  try { stock = await fetchAll('supplier_stock', '*', q => q.eq('store_id', storeId)); }
  catch (e) { return { ...empty, migrationMissing: true, error: e.message }; }
  if (!stock.length) return { ...empty, lastImport: null };

  const products = await fetchAll('products', 'id, sku, title, status, is_staged, default_cost, default_price, pack_qty', q => q.eq('store_id', storeId));
  const productById = new Map(products.map(p => [p.id, p]));
  const variants = (await fetchAll('variants', 'id, product_id, sku, cost, price, pack_qty')).filter(v => productById.has(v.product_id));

  // Every live (active, not staged) SKU → its product + cost basis.
  const live = new Map();
  for (const p of products) {
    if (p.status !== 'active' || p.is_staged) continue;
    if (p.sku) live.set(String(p.sku).trim(), { product: p, cost: p.default_cost, pack: p.pack_qty || 1, sku: String(p.sku).trim() });
  }
  for (const v of variants) {
    const p = productById.get(v.product_id);
    if (!p || p.status !== 'active' || p.is_staged || !v.sku) continue;
    const sku = String(v.sku).trim();
    if (!live.has(sku)) live.set(sku, { product: p, cost: v.cost ?? p.default_cost, pack: v.pack_qty || p.pack_qty || 1, sku });
  }

  const bySku = new Map(stock.map(s => [s.sku, s]));
  const outOfStock = [], notDropship = [], priceChanged = [], packChanged = [], notInSupplier = [];
  let lastImport = null;
  for (const s of stock) if (s.imported_at && (!lastImport || s.imported_at > lastImport)) lastImport = s.imported_at;

  for (const [sku, l] of live) {
    const s = bySku.get(sku);
    const base = { sku, title: l.product.title, productId: l.product.id, pack: l.pack };
    if (!s) { notInSupplier.push(base); continue; }
    if (s.in_stock === false || (s.stock != null && s.stock <= 0 && s.in_stock !== true)) {
      outOfStock.push({ ...base, stock: s.stock, deliveryWeek: s.delivery_week });
    }
    if (s.dropship_ok === false) notDropship.push(base);
    if (s.supplier_price != null && l.cost != null && Math.abs(Number(s.supplier_price) - Number(l.cost)) > 0.5) {
      priceChanged.push({
        ...base, oldCost: Number(l.cost), newCost: Number(s.supplier_price),
        change: Number(s.supplier_price) - Number(l.cost),
        currentPrice: l.product.default_price,
        suggestedPrice: roundUp9(Number(s.supplier_price) * l.pack * 2.5),
      });
    }
  }
  priceChanged.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  // Pack-ändringar: loggade händelser (senaste 60 dagarna) där PIM ännu inte
  // uppdaterats till den nya förpackningen — försvinner när "Uppdatera i
  // Shopify" körts (den sätter PIM:s pack_qty).
  try {
    const since = new Date(Date.now() - 60 * 864e5).toISOString();
    const { data: events } = await supabase.from('activity_log')
      .select('id, changes, created_at')
      .eq('store_id', storeId).eq('action', 'supplier_pack_change').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(200);
    const seenSkus = new Set();
    for (const ev of events || []) {
      const c = ev.changes || {};
      if (!c.sku || seenSkus.has(c.sku)) continue;
      seenSkus.add(c.sku);
      const l = live.get(c.sku);
      if (!l) continue;
      const newPack = c.newPackMarker ?? 1;
      const unit = Number(c.supplierPrice ?? bySku.get(c.sku)?.supplier_price ?? l.cost);
      const suggested = roundUp9(unit * newPack * 2.5);
      const priceClose = l.product.default_price != null && Math.abs(Number(l.product.default_price) - suggested) <= Math.max(5, suggested * 0.02);
      if (Number(l.pack) === Number(newPack) && priceClose) continue; // åtgärdad (pack + pris)
      packChanged.push({
        sku: c.sku, title: l.product.title, productId: l.product.id, pack: l.pack,
        oldPack: Number(l.pack), newPack: Number(newPack),
        oldName: c.oldName, newName: c.newName,
        supplierPrice: unit, currentPrice: l.product.default_price,
        suggestedPrice: suggested,
        suggestedCost: Math.round(unit * newPack * 100) / 100,
        upptackt: String(ev.created_at).slice(0, 10),
      });
    }
  } catch (_) { /* activity_log saknas → inga pack-larm */ }

  return {
    lastImport,
    snapshotSkus: stock.length,
    liveSkus: live.size,
    counts: { outOfStock: outOfStock.length, notDropship: notDropship.length, priceChanged: priceChanged.length, packChanged: packChanged.length, notInSupplier: notInSupplier.length },
    outOfStock: outOfStock.slice(0, cap),
    notDropship: notDropship.slice(0, cap),
    priceChanged: priceChanged.slice(0, cap),
    packChanged: packChanged.slice(0, cap),
    notInSupplier: notInSupplier.slice(0, cap),
    migrationMissing: false,
  };
}
