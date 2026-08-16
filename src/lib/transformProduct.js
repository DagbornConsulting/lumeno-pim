// Transform a raw DB product row (snake_case, with variants/images/store_products
// joined) into the camelCase shape the app + ProductDetail expect. Shared by the
// main product list (App loadProducts) and the staging list (StagingProducts) so
// the two never drift.
export function transformDbProduct(p) {
  return {
    id: p.id,
    title: p.title || '',
    handle: p.handle || '',
    description: p.description || '',
    vendor: p.vendor || '',
    type: p.product_type || '',
    productCategory: p.product_category || '',
    tags: p.tags || [],
    status: p.status || 'draft',
    publishedOnOnlineStore: p.published_on_online_store ?? true,
    price: p.default_price,
    compareAtPrice: p.default_compare_at_price,
    cost: p.default_cost,
    marginMultiplier: p.margin_multiplier,
    supplierId: p.supplier_id,
    sku: p.sku || '',
    barcode: p.barcode || '',
    seoTitle: p.seo_title || '',
    seoDescription: p.seo_description || '',
    chargeTax: p.charge_tax ?? true,
    taxCode: p.tax_code || '',
    requiresShipping: p.requires_shipping ?? true,
    inventoryPolicy: p.inventory_policy || 'deny',
    weight: p.weight,
    weightUnit: p.weight_unit || 'kg',
    variantSchema: p.variant_schema || '',
    metafields: p.metafields || {},
    // Google Shopping
    googleProductCategory: p.google_product_category || '',
    googleGender: p.google_gender || '',
    googleAgeGroup: p.google_age_group || '',
    googleMpn: p.google_mpn || '',
    googleCondition: p.google_condition || '',
    googleCustomLabel0: p.google_custom_label_0 || '',
    googleCustomLabel1: p.google_custom_label_1 || '',
    // Feed
    feedTitle: p.feed_title || '',
    feedDescription: p.feed_description || '',
    // Relations
    variants: (p.variants || []).map(v => ({
      id: v.id,
      sku: v.sku || '',
      barcode: v.barcode || '',
      option1Name: v.option1_name || '',
      option1Value: v.option1_value || '',
      option2Name: v.option2_name || '',
      option2Value: v.option2_value || '',
      option3Name: v.option3_name || '',
      option3Value: v.option3_value || '',
      price: v.price,
      compareAtPrice: v.compare_at_price,
      cost: v.cost,
      weight: v.weight,
      weightUnit: v.weight_unit || 'kg',
      inventoryQuantity: v.inventory_quantity || 0,
      inventoryPolicy: v.inventory_policy || 'deny',
      position: v.position
    })),
    images: (p.images || []).map(img => ({
      id: img.id,
      url: img.url || '',
      alt: img.alt_text || '',
      position: img.position
    })),
    storeProducts: p.store_products || [],
    createdAt: p.created_at,
    updatedAt: p.updated_at
  };
}
