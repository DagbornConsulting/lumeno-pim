// Pricing engine — shared logic for margin resolution and price/profit calculation.
// Mirrored in src/utils/pricing.js for the frontend.

export const DEFAULT_MARGIN = 2.0;
export const DEFAULT_VAT_RATE = 0.25;
// Affari's dropship handling fee — used when no supplier profile says otherwise.
export const DEFAULT_SUPPLIER_FEE_PERCENT = 20;

const round2 = n => Math.round(n * 100) / 100;
const round4 = n => Math.round(n * 10000) / 10000;

// Resolve margin in priority order:
// 1. Product override → 2. Category rule → 3. Supplier default → 4. Global default
export function resolveMargin({ product, categoryRules = [], supplier = null, defaultMargin = DEFAULT_MARGIN }) {
  if (product?.margin_multiplier != null && product.margin_multiplier !== '') {
    return { value: Number(product.margin_multiplier), source: 'product', sourceLabel: 'produkt' };
  }
  if (product?.product_type) {
    const rule = categoryRules.find(r => r.category === product.product_type);
    if (rule) {
      return {
        value: Number(rule.margin_multiplier),
        source: 'category',
        sourceLabel: `kategori: ${product.product_type}`,
      };
    }
  }
  const supplierMargin = supplier?.margin_rule?.default_multiplier;
  if (supplierMargin != null) {
    return {
      value: Number(supplierMargin),
      source: 'supplier',
      sourceLabel: `leverantör: ${supplier.name || ''}`,
    };
  }
  return { value: Number(defaultMargin) || DEFAULT_MARGIN, source: 'default', sourceLabel: 'global default' };
}

// Compute all derived prices/profit numbers from cost + margin + fees + VAT.
// cost is the supplier's PER-UNIT price excl. VAT; packQty is how many units
// the customer gets per sold article ("Förpackningsantal dropship"), so both
// the sale price and the cost basis scale with it.
export function computePricing({ cost, margin, packQty = 1, supplierFeePercent = 0, vatRate = DEFAULT_VAT_RATE }) {
  const pack = Math.max(1, Number(packQty) || 1);
  const c = (Number(cost) || 0) * pack;
  const m = Number(margin) || 0;
  const fee = Number(supplierFeePercent) || 0;
  const vat = Number(vatRate);
  const vatMul = 1 + (Number.isFinite(vat) ? vat : DEFAULT_VAT_RATE);

  const salePriceInclVat = c * m;
  const salePriceExVat = salePriceInclVat / vatMul;
  const trueCost = c * (1 + fee / 100);
  const profit = salePriceExVat - trueCost;
  const marginPct = salePriceExVat > 0 ? profit / salePriceExVat : 0;

  // salePriceInclVat is the value that gets stored on the product / synced to
  // Shopify, so it must be a whole krona — no öres in product prices.
  // Reporting fields (ex VAT, profit, margin) keep cent precision.
  return {
    salePriceInclVat: Math.round(salePriceInclVat),
    salePriceExVat: round2(salePriceExVat),
    trueCost: round2(trueCost),
    profit: round2(profit),
    marginPct: round4(marginPct),
  };
}

// Convenience: resolve margin and compute in one call.
export function priceProduct({ product, categoryRules, supplier, settings }) {
  const margin = resolveMargin({
    product,
    categoryRules,
    supplier,
    defaultMargin: settings?.default_margin_multiplier ?? DEFAULT_MARGIN,
  });
  const pricing = computePricing({
    cost: product?.default_cost,
    margin: margin.value,
    packQty: product?.pack_qty,
    supplierFeePercent: supplier?.supplier_fee_percent ?? DEFAULT_SUPPLIER_FEE_PERCENT,
    vatRate: settings?.default_vat_rate ?? DEFAULT_VAT_RATE,
  });
  return { margin, pricing };
}
