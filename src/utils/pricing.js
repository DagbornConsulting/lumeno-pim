// Pricing engine — shared logic for margin resolution and price/profit calculation.
// Mirrored in server/services/pricing.js for the backend.

export const DEFAULT_MARGIN = 2.0;
export const DEFAULT_VAT_RATE = 0.25;

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
// cost is excl. VAT (supplier price). Sale price returned both incl. and excl. VAT.
export function computePricing({ cost, margin, supplierFeePercent = 0, vatRate = DEFAULT_VAT_RATE }) {
  const c = Number(cost) || 0;
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
    supplierFeePercent: supplier?.supplier_fee_percent ?? 0,
    vatRate: settings?.default_vat_rate ?? DEFAULT_VAT_RATE,
  });
  return { margin, pricing };
}

// Format helpers for UI.
export const fmtKr = n => `${(Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
export const fmtPct = n => `${((Number(n) || 0) * 100).toLocaleString('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
