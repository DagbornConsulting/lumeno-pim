// Shopify sales summary for the dashboard: orders, revenue and units for the
// last 7/30 days plus per-SKU totals. Read-only (needs the read_orders scope).
// Cached in memory per store for 15 minutes — on serverless that is per
// instance, which is fine: it only avoids hammering Shopify on page reloads.

import shopifySync from '../shopify.js';

const _cache = new Map(); // storeId:days -> { at, data }
const TTL = 15 * 60 * 1000;

const ymd = (d) => d.toISOString().slice(0, 10);

export async function getSales(store, { days = 30, force = false } = {}) {
  const key = `${store.id}:${days}`;
  const hit = _cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.data;

  const client = shopifySync.getClient(store);
  const since = new Date(Date.now() - days * 864e5);
  const sevenAgo = Date.now() - 7 * 864e5;
  const query = `query($c: String, $q: String) {
    orders(first: 250, after: $c, query: $q, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name createdAt cancelledAt displayFinancialStatus
        currentSubtotalPriceSet { shopMoney { amount } }
        lineItems(first: 100) { nodes { sku title quantity discountedTotalSet { shopMoney { amount } } product { id } } }
      }
    }
  }`;

  const bySku = new Map();
  const totals = { orders30: 0, revenue30: 0, units30: 0, orders7: 0, revenue7: 0, units7: 0 };
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    let d;
    try {
      d = await client.graphql(query, { c: cursor, q: `created_at:>=${ymd(since)}` });
    } catch (e) {
      if (/access denied|read_orders|ACCESS_DENIED/i.test(e.message)) throw new Error('Shopify-appen saknar behörigheten read_orders');
      throw e;
    }
    for (const o of d.orders.nodes) {
      if (o.cancelledAt) continue;
      const isWeek = new Date(o.createdAt).getTime() >= sevenAgo;
      const sub = Number(o.currentSubtotalPriceSet?.shopMoney?.amount || 0);
      totals.orders30++; totals.revenue30 += sub;
      if (isWeek) { totals.orders7++; totals.revenue7 += sub; }
      for (const li of o.lineItems.nodes) {
        const qty = Number(li.quantity || 0);
        const amt = Number(li.discountedTotalSet?.shopMoney?.amount || 0);
        totals.units30 += qty; if (isWeek) totals.units7 += qty;
        const sku = String(li.sku || '').trim() || `(utan sku) ${li.title}`;
        const cur = bySku.get(sku) || { sku, title: li.title, units: 0, revenue: 0, units7: 0, productId: li.product?.id ? li.product.id.split('/').pop() : null };
        cur.units += qty; cur.revenue += amt; if (isWeek) cur.units7 += qty;
        bySku.set(sku, cur);
      }
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    cursor = d.orders.pageInfo.endCursor;
  }

  const rows = [...bySku.values()].map(r => ({ ...r, revenue: Math.round(r.revenue) }));
  const data = {
    days, since: ymd(since), fetchedAt: new Date().toISOString(),
    ...totals,
    revenue30: Math.round(totals.revenue30), revenue7: Math.round(totals.revenue7),
    avgOrder30: totals.orders30 ? Math.round(totals.revenue30 / totals.orders30) : 0,
    top: rows.sort((a, b) => b.revenue - a.revenue).slice(0, 8),
    skusSold: rows.length,
    bySku: Object.fromEntries(rows.map(r => [r.sku, { units: r.units, revenue: r.revenue }])),
  };
  _cache.set(key, { at: Date.now(), data });
  return data;
}
