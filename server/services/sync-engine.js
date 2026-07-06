// ============================================
// SYNC ENGINE — pure conflict/merge logic (no I/O)
//
// Given the PIM's current content, Shopify's current content, and the baseline
// (last-known Shopify state), classify each managed field:
//   in_sync          PIM == Shopify (nothing to do)
//   pim_changed      only the PIM changed since baseline  -> push to Shopify
//   shopify_changed  only Shopify changed since baseline   -> pull into PIM
//   conflict         both changed, and differ             -> ask the user
//   no_baseline      they differ but we have no baseline   -> ask the user
//
// Content shape (both pim and shop):
//   { title, body_html, product_type, tags: [...], metafields: { "ns.key": value } }
// ============================================

const normStr = (x) => (x == null ? '' : String(x)).trim();

const normTags = (x) => {
  const arr = Array.isArray(x) ? x : (x ? String(x).split(',') : []);
  return [...new Set(arr.map(t => String(t).trim()).filter(Boolean))].sort();
};

const eqStr = (a, b) => normStr(a) === normStr(b);
const eqTags = (a, b) => JSON.stringify(normTags(a)) === JSON.stringify(normTags(b));
// Metafield values may be strings or parsed JSON objects/arrays.
const eqVal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Decide a field's status from the three equality checks.
function statusOf(currentEqual, pimEqBase, shopEqBase, hasBaseline) {
  if (currentEqual) return 'in_sync';
  if (!hasBaseline) return 'no_baseline';
  const pimChanged = !pimEqBase;
  const shopChanged = !shopEqBase;
  if (pimChanged && !shopChanged) return 'pim_changed';
  if (!pimChanged && shopChanged) return 'shopify_changed';
  return 'conflict';
}

const SCALAR_FIELDS = [
  { field: 'title', label: 'Titel' },
  { field: 'body_html', label: 'Beskrivning' },
  { field: 'product_type', label: 'Produkttyp' },
];

export function computeProductDiff({ pim, shop, baseline }) {
  const hasBaseline = baseline != null && typeof baseline === 'object';
  const base = baseline || {};

  const fields = [];
  for (const f of SCALAR_FIELDS) {
    const status = statusOf(
      eqStr(pim[f.field], shop[f.field]),
      eqStr(pim[f.field], base[f.field]),
      eqStr(shop[f.field], base[f.field]),
      hasBaseline
    );
    fields.push({
      field: f.field, label: f.label,
      pim: pim[f.field] ?? '', shopify: shop[f.field] ?? '', baseline: base[f.field] ?? null,
      status,
    });
  }

  // Tags (compared as a set)
  {
    const status = statusOf(
      eqTags(pim.tags, shop.tags),
      eqTags(pim.tags, base.tags),
      eqTags(shop.tags, base.tags),
      hasBaseline
    );
    fields.push({
      field: 'tags', label: 'Taggar',
      pim: normTags(pim.tags), shopify: normTags(shop.tags), baseline: base.tags ? normTags(base.tags) : null,
      status,
    });
  }

  // Metafields — union of keys; only surface those that differ (products can
  // have many identical metafields we don't need to show).
  const metafields = [];
  const pimM = pim.metafields || {}, shopM = shop.metafields || {}, baseM = base.metafields || {};
  const keys = [...new Set([...Object.keys(pimM), ...Object.keys(shopM), ...Object.keys(baseM)])].sort();
  for (const k of keys) {
    const status = statusOf(
      eqVal(pimM[k], shopM[k]),
      eqVal(pimM[k], baseM[k]),
      eqVal(shopM[k], baseM[k]),
      hasBaseline
    );
    if (status === 'in_sync') continue;
    metafields.push({ key: k, pim: pimM[k] ?? null, shopify: shopM[k] ?? null, baseline: baseM[k] ?? null, status });
  }

  const counts = { in_sync: 0, pim_changed: 0, shopify_changed: 0, conflict: 0, no_baseline: 0 };
  for (const f of fields) counts[f.status]++;
  for (const m of metafields) counts[m.status]++;

  const changed = [...fields.filter(f => f.status !== 'in_sync'), ...metafields];
  return { hasBaseline, fields, metafields, counts, hasChanges: changed.length > 0 };
}

// Build a push/pull plan from a diff. `resolutions` maps a field/metafield key
// to 'pim' or 'shopify' for conflict/no_baseline entries the user has decided.
//   toShopify: scalar fields + tags to PUT, and metafields to set
//   toPim:     values to write back into the PIM (Shopify won)
//   unresolved: entries still needing a human decision
export function buildSyncPlan(diff, resolutions = {}) {
  const toShopify = { fields: {}, tags: null, metafields: {} };
  const toPim = { fields: {}, tags: null, metafields: {} };
  const unresolved = [];
  let hasShopifyWrite = false;

  const decide = (entry, key, isMeta) => {
    const pick = (val) => {
      if (val === 'pim') {
        if (isMeta) { toShopify.metafields[key] = entry.pim; }
        else if (key === 'tags') { toShopify.tags = entry.pim; }
        else { toShopify.fields[key] = entry.pim; }
        hasShopifyWrite = true;
      } else if (val === 'shopify') {
        if (isMeta) toPim.metafields[key] = entry.shopify;
        else if (key === 'tags') toPim.tags = entry.shopify;
        else toPim.fields[key] = entry.shopify;
      }
    };

    switch (entry.status) {
      case 'pim_changed': pick('pim'); break;
      case 'shopify_changed': pick('shopify'); break;
      case 'conflict':
      case 'no_baseline': {
        const r = resolutions[isMeta ? `metafield:${key}` : key];
        if (r === 'pim' || r === 'shopify') pick(r);
        else unresolved.push({ key: isMeta ? `metafield:${key}` : key, status: entry.status });
        break;
      }
      default: break; // in_sync
    }
  };

  for (const f of diff.fields) if (f.status !== 'in_sync') decide(f, f.field, false);
  for (const m of diff.metafields) decide(m, m.key, true);

  return { toShopify, toPim, unresolved, hasShopifyWrite };
}
