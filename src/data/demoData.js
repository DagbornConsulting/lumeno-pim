// ============================================
// PIM Configuration Data
// Schemas, categories, and helper functions
// ============================================

// ============================================
// VARIANT SCHEMAS FOR DIFFERENT PRODUCT TYPES
// ============================================

export const variantSchemas = {
  clothing: {
    name: 'Kläder',
    options: [
      { key: 'option1', name: 'Färg', linkedTo: 'product.metafields.shopify.color-pattern', values: [] },
      { key: 'option2', name: 'Storlek', linkedTo: null, values: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'] },
    ],
    defaultWeight: 250,
  },
  shoes: {
    name: 'Skor',
    options: [
      { key: 'option1', name: 'Färg', linkedTo: 'product.metafields.shopify.color-pattern', values: [] },
      { key: 'option2', name: 'Storlek', linkedTo: null, values: ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46'] },
    ],
    defaultWeight: 800,
  },
  accessories: {
    name: 'Tillbehör',
    options: [
      { key: 'option1', name: 'Färg', linkedTo: 'product.metafields.shopify.color-pattern', values: [] },
      { key: 'option2', name: 'Storlek', linkedTo: null, values: ['One Size', 'S', 'M', 'L'] },
    ],
    defaultWeight: 100,
  },
  simple: {
    name: 'Enkel produkt',
    options: [],
    defaultWeight: 500,
  },
};

// ============================================
// SHOPIFY PRODUCT CATEGORIES
// ============================================

export const shopifyCategories = [
  { value: 'Apparel & Accessories > Clothing > Shirts & Tops', label: 'Toppar & Skjortor' },
  { value: 'Apparel & Accessories > Clothing > Shirts & Tops > T-Shirts', label: 'T-Shirts' },
  { value: 'Apparel & Accessories > Clothing > Shirts & Tops > Polo Shirts', label: 'Polo Shirts' },
  { value: 'Apparel & Accessories > Clothing > Outerwear > Jackets', label: 'Jackor' },
  { value: 'Apparel & Accessories > Clothing > Pants', label: 'Byxor' },
  { value: 'Apparel & Accessories > Clothing > Shorts', label: 'Shorts' },
  { value: 'Apparel & Accessories > Clothing > Sweaters', label: 'Tröjor' },
  { value: 'Apparel & Accessories > Shoes', label: 'Skor' },
  { value: 'Apparel & Accessories > Shoes > Athletic Shoes', label: 'Träningsskor' },
  { value: 'Apparel & Accessories > Clothing Accessories > Hats & Headwear > Caps', label: 'Kepsar' },
  { value: 'Apparel & Accessories > Clothing Accessories > Bags & Wallets', label: 'Väskor' },
  { value: 'Sporting Goods', label: 'Sportartiklar' },
  { value: 'Home & Garden', label: 'Hem & Trädgård' },
  { value: 'Electronics', label: 'Elektronik' },
  { value: 'Health & Beauty', label: 'Hälsa & Skönhet' },
];

// ============================================
// PIM FIELDS DEFINITION
// ============================================

export const pimFields = {
  basic: [
    { key: 'title', label: 'Titel', type: 'text', required: true },
    { key: 'handle', label: 'URL Handle', type: 'text', required: false, autoGenerate: true },
    { key: 'description', label: 'Beskrivning', type: 'html', required: false },
    { key: 'vendor', label: 'Varumärke', type: 'text', required: true },
    { key: 'productCategory', label: 'Produktkategori', type: 'select', required: false },
    { key: 'type', label: 'Produkttyp', type: 'text', required: false },
    { key: 'tags', label: 'Taggar', type: 'tags', required: false },
  ],
  publishing: [
    { key: 'publishedOnOnlineStore', label: 'Publicerad', type: 'boolean', default: true },
    { key: 'status', label: 'Status', type: 'select', options: ['active', 'draft', 'archived'] },
  ],
  pricing: [
    { key: 'price', label: 'Pris', type: 'currency', required: true },
    { key: 'compareAtPrice', label: 'Jämförpris', type: 'currency' },
    { key: 'cost', label: 'Inköpspris', type: 'currency' },
  ],
  taxShipping: [
    { key: 'chargeTax', label: 'Momspliktigt', type: 'boolean', default: true },
    { key: 'taxCode', label: 'Momskod', type: 'text' },
    { key: 'requiresShipping', label: 'Kräver frakt', type: 'boolean', default: true },
    { key: 'weight', label: 'Vikt (gram)', type: 'number' },
    { key: 'weightUnit', label: 'Viktenhet', type: 'select', options: ['g', 'kg'], default: 'g' },
  ],
  inventory: [
    { key: 'inventoryTracker', label: 'Lagerhantering', type: 'select', options: ['shopify', 'none'], default: 'shopify' },
    { key: 'inventoryPolicy', label: 'Vid slutsålt', type: 'select', options: ['deny', 'continue'], default: 'deny' },
  ],
  seo: [
    { key: 'seoTitle', label: 'SEO-titel', type: 'text', maxLength: 70 },
    { key: 'seoDescription', label: 'Meta-beskrivning', type: 'textarea', maxLength: 320 },
  ],
  metafields: [
    { key: 'kort_produktbeskrivning', label: 'Kort produktbeskrivning', namespace: 'custom', type: 'text', maxLength: 200 },
    { key: 'source_material', label: 'Källmaterial för AI', namespace: 'custom', type: 'text', internal: true },
    { key: 'material', label: 'Material', namespace: 'custom' },
    { key: 'colorPattern', label: 'Färgmönster', namespace: 'shopify' },
    { key: 'launchDate', label: 'Lanseringsdatum', namespace: 'custom', type: 'date' },
    { key: 'warranty', label: 'Garanti', namespace: 'custom' },
    { key: 'countryOfOrigin', label: 'Ursprungsland', namespace: 'custom' },
  ],
  googleShopping: [
    { key: 'productCategory', label: 'Google-kategori' },
    { key: 'gender', label: 'Kön', options: ['Unisex', 'Male', 'Female'] },
    { key: 'ageGroup', label: 'Åldersgrupp', options: ['Adult', 'Kids'] },
    { key: 'mpn', label: 'MPN' },
    { key: 'condition', label: 'Skick', options: ['New', 'Used', 'Refurbished'], default: 'New' },
    { key: 'customLabel0', label: 'Custom Label 0' },
    { key: 'customLabel1', label: 'Custom Label 1' },
  ],
};

// ============================================
// SUPPLIER PROFILES (Loaded from DB, these are defaults)
// ============================================

export const supplierProfiles = [];

// ============================================
// SHOPIFY CSV EXPORT HEADERS
// ============================================

export const shopifyExportHeaders = [
  'Title', 'URL handle', 'Description', 'Vendor', 'Product category', 'Type', 'Tags',
  'Published on online store', 'Status', 'SKU', 'Barcode',
  'Option1 name', 'Option1 value', 'Option1 Linked To',
  'Option2 name', 'Option2 value', 'Option2 Linked To',
  'Option3 name', 'Option3 value', 'Option3 Linked To',
  'Price', 'Compare-at price', 'Cost per item',
  'Charge tax', 'Tax code',
  'Inventory tracker', 'Inventory quantity', 'Continue selling when out of stock',
  'Weight value (grams)', 'Weight unit for display',
  'Requires shipping', 'Fulfillment service',
  'Product image URL', 'Image position', 'Image alt text', 'Variant image URL',
  'Gift card', 'SEO title', 'SEO description',
  'Color (product.metafields.shopify.color-pattern)',
  'Google Shopping / Google product category', 'Google Shopping / Gender',
  'Google Shopping / Age group', 'Google Shopping / Manufacturer part number (MPN)',
  'Google Shopping / Condition', 'Google Shopping / Custom label 0', 'Google Shopping / Custom label 1',
];

// ============================================
// HELPER FUNCTIONS
// ============================================

export function generateHandle(title) {
  return title.toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function exportToShopifyCSV(products) {
  const rows = [];

  products.forEach(product => {
    product.variants.forEach((variant, variantIndex) => {
      const isFirst = variantIndex === 0;
      const options = product.optionDefinitions || [];

      const row = {
        'Title': isFirst ? product.title : '',
        'URL handle': isFirst ? (product.handle || generateHandle(product.title)) : '',
        'Description': isFirst ? (product.description || '') : '',
        'Vendor': isFirst ? product.vendor : '',
        'Product category': isFirst ? (product.productCategory || '') : '',
        'Type': isFirst ? product.type : '',
        'Tags': isFirst ? (product.tags?.join(', ') || '') : '',
        'Published on online store': isFirst ? (product.publishedOnOnlineStore ? 'TRUE' : 'FALSE') : '',
        'Status': isFirst ? product.status : '',
        'SKU': variant.sku,
        'Barcode': variant.barcode || '',
        'Option1 name': variant.option1Name || options[0]?.name || '',
        'Option1 value': variant.option1Value || variant.option1 || '',
        'Option1 Linked To': options[0]?.linkedTo || '',
        'Option2 name': variant.option2Name || options[1]?.name || '',
        'Option2 value': variant.option2Value || variant.option2 || '',
        'Option2 Linked To': options[1]?.linkedTo || '',
        'Option3 name': variant.option3Name || options[2]?.name || '',
        'Option3 value': variant.option3Value || variant.option3 || '',
        'Option3 Linked To': options[2]?.linkedTo || '',
        'Price': variant.price || product.price || '',
        'Compare-at price': variant.compareAtPrice || '',
        'Cost per item': variant.cost || '',
        'Charge tax': product.chargeTax !== false ? 'TRUE' : 'FALSE',
        'Tax code': product.taxCode || '',
        'Inventory tracker': product.inventoryTracker || 'shopify',
        'Inventory quantity': variant.inventoryQuantity || 0,
        'Continue selling when out of stock': product.inventoryPolicy === 'continue' ? 'CONTINUE' : 'DENY',
        'Weight value (grams)': variant.weight || product.weight || '',
        'Weight unit for display': product.weightUnit || 'g',
        'Requires shipping': product.requiresShipping !== false ? 'TRUE' : 'FALSE',
        'Fulfillment service': product.fulfillmentService || 'manual',
        'Product image URL': isFirst && product.images?.[0] ? product.images[0].url : '',
        'Image position': isFirst && product.images?.[0] ? 1 : '',
        'Image alt text': isFirst && product.images?.[0] ? product.images[0].alt : '',
        'Variant image URL': '',
        'Gift card': 'FALSE',
        'SEO title': isFirst ? (product.seoTitle || '') : '',
        'SEO description': isFirst ? (product.seoDescription || '') : '',
        'Color (product.metafields.shopify.color-pattern)': isFirst ? (product.metafields?.colorPattern || '') : '',
        'Google Shopping / Google product category': isFirst ? (product.googleShopping?.productCategory || product.googleProductCategory || '') : '',
        'Google Shopping / Gender': isFirst ? (product.googleShopping?.gender || product.googleGender || '') : '',
        'Google Shopping / Age group': isFirst ? (product.googleShopping?.ageGroup || product.googleAgeGroup || '') : '',
        'Google Shopping / Manufacturer part number (MPN)': variant.sku,
        'Google Shopping / Condition': isFirst ? 'New' : '',
        'Google Shopping / Custom label 0': isFirst ? (product.googleShopping?.customLabel0 || product.googleCustomLabel0 || '') : '',
        'Google Shopping / Custom label 1': isFirst ? (product.googleShopping?.customLabel1 || product.googleCustomLabel1 || '') : '',
      };
      rows.push(row);
    });

    // Extra image rows
    if (product.images?.length > 1) {
      product.images.slice(1, 8).forEach((img, idx) => {
        const imageRow = {};
        shopifyExportHeaders.forEach(h => imageRow[h] = '');
        imageRow['URL handle'] = product.handle || generateHandle(product.title);
        imageRow['Product image URL'] = img.url;
        imageRow['Image position'] = idx + 2;
        imageRow['Image alt text'] = img.alt || '';
        rows.push(imageRow);
      });
    }
  });

  return rows;
}

// ============================================
// DEFAULT SHOPIFY MAPPING
// ============================================

export const defaultShopifyMapping = {
  title: { enabled: true, shopifyField: 'Title' },
  handle: { enabled: true, shopifyField: 'URL handle' },
  description: { enabled: true, shopifyField: 'Description' },
  vendor: { enabled: true, shopifyField: 'Vendor' },
  productCategory: { enabled: true, shopifyField: 'Product category' },
  type: { enabled: true, shopifyField: 'Type' },
  tags: { enabled: true, shopifyField: 'Tags' },
  sku: { enabled: true, shopifyField: 'SKU' },
  barcode: { enabled: true, shopifyField: 'Barcode' },
  price: { enabled: true, shopifyField: 'Price' },
  compareAtPrice: { enabled: true, shopifyField: 'Compare-at price' },
  cost: { enabled: true, shopifyField: 'Cost per item' },
  weight: { enabled: true, shopifyField: 'Weight value (grams)' },
  inventoryQuantity: { enabled: true, shopifyField: 'Inventory quantity' },
  seoTitle: { enabled: true, shopifyField: 'SEO title' },
  seoDescription: { enabled: true, shopifyField: 'SEO description' },
  material: { enabled: true, shopifyField: 'metafields.custom.material' },
};
