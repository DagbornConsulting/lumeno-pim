# Lumeno PIM — Feature Specification

Stack: React + Vite (frontend), Node.js + Express ESM (backend), Supabase (PostgreSQL), Anthropic SDK (`claude-sonnet-4-6`), multer, sharp, pdf-parse, mammoth, xlsx, react-quill, lucide-react.

---

## 1. CSV/Excel Import with Variant Structure

### Overview
Multi-step wizard: Upload → Map kolumner → Förhandsgranska → Importera.

### Column Analysis
After user selects a grouping column, run `analyzeColumns(rows, headers, groupCol)`:
```js
function analyzeColumns(rows, headers, groupCol) {
  // Group rows by groupCol value
  const groups = {};
  rows.forEach(row => {
    const key = String(row[groupCol] ?? '');
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  });

  const result = {};
  headers.forEach(col => {
    if (col === groupCol) { result[col] = { role: 'group' }; return; }
    let varying = false;
    for (const group of Object.values(groups)) {
      if (group.length < 2) continue;
      const vals = new Set(group.map(r => String(r[col] ?? '')));
      if (vals.size > 1) { varying = true; break; }
    }
    const allVals = [...new Set(rows.map(r => String(r[col] ?? '')).filter(Boolean))];
    result[col] = { role: varying ? 'variant' : 'meta', distinctValues: allVals.slice(0, 8) };
  });
  return result;
}
```

### Variant Structure UI
Three variant option slots, each with:
- Column dropdown (available headers minus groupCol and other variant cols)
- Name input (label shown in Shopify, e.g. "Storlek", "Färg")
- Value chips showing distinct values
- Warning if column is constant per product (role === 'meta')

Show live stat: "X produkter · Y varianter totalt · max Z per produkt"

### buildProducts
```js
function buildProducts(rows, mapping, groupCol, variantOptions) {
  const seen = new Map();
  const products = [];

  rows.forEach(row => {
    const get = (key) => {
      const col = Object.entries(mapping).find(([, fields]) =>
        Array.isArray(fields) && fields.includes(key)
      )?.[0];
      return col !== undefined ? row[col] : undefined;
    };

    const groupKey = (groupCol ? String(row[groupCol] ?? '') : '') || get('title') || get('sku');
    if (!groupKey) return;

    const variant = {
      sku: get('sku') || '',
      barcode: get('barcode') || '',
      price: parseNumber(get('price')),
      compareAtPrice: parseNumber(get('compareAtPrice')),
      cost: parseNumber(get('cost')),
      inventoryQuantity: parseNumber(get('inventoryQuantity')) ?? 0,
      weight: parseNumber(get('weight')),
      option1Name: variantOptions[0]?.name || null,
      option1Value: variantOptions[0]?.col ? String(row[variantOptions[0].col] ?? '') || null : null,
      option2Name: variantOptions[1]?.name || null,
      option2Value: variantOptions[1]?.col ? String(row[variantOptions[1].col] ?? '') || null : null,
      option3Name: variantOptions[2]?.name || null,
      option3Value: variantOptions[2]?.col ? String(row[variantOptions[2].col] ?? '') || null : null,
    };

    if (seen.has(groupKey)) {
      seen.get(groupKey).variants.push(variant);
    } else {
      const product = {
        title: get('title') || groupKey,
        vendor: get('vendor') || '',
        type: get('type') || '',
        description: get('description') || '',
        tags: get('tags') ? String(get('tags')).split(/[,;]/).map(t => t.trim()).filter(Boolean) : [],
        status: get('status') || 'draft',
        images: get('imageUrl') ? [{ url: get('imageUrl'), alt: get('imageAlt') || '' }] : [],
        country_of_origin: get('country_of_origin') || '',
        hs_code: get('hs_code') || '',
        metafields: {}, // populated from metafield: mappings
        variants: [variant],
      };
      seen.set(groupKey, product);
      products.push(product);
    }
  });
  return products;
}
```

### Field Mapping
Each column can map to multiple PIM fields (chip UI). PIM_FIELDS:
- title, sku, barcode, vendor, type, tags, description, status
- price, compareAtPrice, cost, inventoryQuantity, weight
- seoTitle, seoDescription, imageUrl, imageAlt
- country_of_origin, hs_code
- `metafield:namespace.key` (dynamic, from metafield_definitions table)

Auto-detect from column name using regex patterns.

### Server Endpoint: POST /api/db/products/import
```js
const { products, supplierName, mapping, groupCol, variantOptions, headers } = req.body;
const storeId = await resolveStoreId(req);

for (const p of products) {
  const firstVariant = p.variants?.[0] || {};
  const productData = {
    title: p.title,
    description: p.description || '',
    vendor: p.vendor || '',
    product_type: p.type || p.product_type || '',
    tags: Array.isArray(p.tags) ? p.tags : (p.tags ? [p.tags] : []),  // MUST be array for TEXT[]
    status: p.status || 'draft',
    store_id: storeId,
    metafields: p.metafields || {},
    images: (p.images || []).map(img => ({
      url: img.url, alt_text: img.alt || img.alt_text || p.title,
      position: img.position || 1, source: img.source || 'import',
    })),
    default_price: firstVariant.price ?? null,
    default_cost: firstVariant.cost ?? null,
    sku: firstVariant.sku || '',
    barcode: firstVariant.barcode || '',
    weight: firstVariant.weight ?? null,
    variants: (p.variants || []).map(v => ({
      sku: v.sku || '', barcode: v.barcode || '',
      price: v.price ?? null, compare_at_price: v.compareAtPrice ?? null,
      cost: v.cost ?? null, inventory_quantity: v.inventoryQuantity ?? 0,
      weight: v.weight ?? null,
      option1_name: v.option1Name || null, option1_value: v.option1Value || null,
      option2_name: v.option2Name || null, option2_value: v.option2Value || null,
      option3_name: v.option3Name || null, option3_value: v.option3Value || null,
    })),
  };

  // Duplicate check: SKU first, then barcode
  let existing = null;
  if (productData.sku) {
    const { data } = await supabase.from('products').select('id').eq('store_id', storeId).eq('sku', productData.sku).maybeSingle();
    existing = data;
  }
  if (!existing && productData.barcode) {
    const { data } = await supabase.from('products').select('id').eq('store_id', storeId).eq('barcode', productData.barcode).maybeSingle();
    existing = data;
  }

  if (existing) { await db.updateProduct(existing.id, productData); updated++; }
  else { await db.createProduct(productData); created++; }
}

// Save mapping profile if requested
if (supplierName && mapping) {
  await supabase.from('import_mappings').upsert({
    store_id: storeId, supplier_name: supplierName,
    headers: headers || [], mapping, group_col: groupCol || null,
    variant_options: variantOptions || null, updated_at: new Date().toISOString(),
  }, { onConflict: 'store_id,supplier_name' });
}

res.json({ created, updated, errors, errorDetails: errorDetails.slice(0, 10) });
```

---

## 2. Mapping Persistence (Supplier Profiles)

### Database
```sql
CREATE TABLE import_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  supplier_name VARCHAR(255) NOT NULL,
  headers TEXT[] NOT NULL DEFAULT '{}',
  mapping JSONB NOT NULL DEFAULT '{}',
  group_col VARCHAR(255),
  variant_options JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, supplier_name)
);
CREATE INDEX idx_import_mappings_store ON import_mappings(store_id);
```

### Server Endpoints
```
POST /api/db/import-mappings/match
  body: { headers: string[] }
  → find profile where overlap(saved_headers, new_headers) >= 80%
  → return best match or null

GET /api/db/import-mappings
  → list all for store

DELETE /api/db/import-mappings/:id
```

Match algorithm:
```js
const headerSet = new Set(headers);
let bestMatch = null, bestScore = 0;
for (const profile of data) {
  const saved = profile.headers || [];
  const overlap = saved.filter(h => headerSet.has(h)).length;
  const score = overlap / Math.max(saved.length, headers.length);
  if (score > bestScore && score >= 0.8) { bestScore = score; bestMatch = profile; }
}
```

### Frontend Behavior
After file parse, `useEffect` on `[headers, step]`:
```js
fetch(`${API_URL}/db/import-mappings/match`, { method: 'POST', body: JSON.stringify({ headers }) })
  .then(r => r.json())
  .then(profile => {
    if (!profile) return;
    setMatchedProfile(profile);
    setSupplierName(profile.supplier_name);
    setSaveMapping(true);
    if (profile.mapping) setMapping(profile.mapping);
    if (profile.group_col) setGroupCol(profile.group_col);
    if (profile.variant_options) setVariantOptions(profile.variant_options);
  });
```

Show green banner: "Leverantörsprofil 'X' kändes igen och tillämpades automatiskt."

In mapping step footer: checkbox "Spara mappning som leverantörsprofil" + supplier name input.

---

## 3. Shopify → PIM Pull Import (Gap Detection)

### store_products Table
```sql
CREATE TABLE store_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_product_id BIGINT,
  shopify_product_gid VARCHAR(255),
  sync_status VARCHAR(50) DEFAULT 'pending',
  is_published BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_sync_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, product_id)
);
```

### Server Endpoints
```
GET /api/shopify/stores/:storeId/product-diff
  → fetch all Shopify products via REST pagination (/products.json?limit=250)
  → get existing shopify_product_ids from store_products
  → return products in Shopify but not in PIM

POST /api/shopify/stores/:storeId/import-from-shopify
  body: { productIds: [shopifyId, ...] }
  → for each: build pimProduct, check duplicate by shopify_product_id, createProduct + insert store_products
  → variant fields: snake_case (option1_name, option1_value, compare_at_price, inventory_quantity)
  → image fields: { url: img.src, alt_text: img.alt, source: 'shopify', shopify_image_id: img.id }
  → product_type not type
```

### ShopifyImport.jsx Component
- Loads product-diff on mount
- List with thumbnails, title, variant count, checkboxes, search filter
- "Importera X till PIM" button

### Gap Banner in Products View
In App.jsx ProductsView: on mount fetch product-diff, if count > 0 show yellow banner with count and link to ShopifyImport.

---

## 4. Auth / Fetch Interceptor

### src/utils/fetchInterceptor.js
```js
const SKIP = ['/api/auth/login', '/api/auth/verify', '/api/health'];

export function installFetchInterceptor() {
  if (typeof window === 'undefined' || window.__pimFetchPatched) return;
  window.__pimFetchPatched = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (!/\/api\//.test(url) || SKIP.some(p => url.includes(p))) return originalFetch(input, init);

    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
    const token = localStorage.getItem('pim_token');
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    const storeId = localStorage.getItem('pim_active_store_id');
    if (storeId && !headers.has('x-store-id')) headers.set('x-store-id', storeId);

    return originalFetch(input, { ...init, headers }).then(res => {
      if (res.status === 401) {
        localStorage.removeItem('pim_token');
        localStorage.removeItem('pim_user');
        localStorage.removeItem('pim_active_store_id');
        window.dispatchEvent(new CustomEvent('pim:unauthorized'));
      }
      return res;
    });
  };
}
```

App.jsx listens: `window.addEventListener('pim:unauthorized', forceLogout)`.

### resolveStoreId (server helper)
```js
async function resolveStoreId(req) {
  const fromHeader = req.headers['x-store-id'];
  if (fromHeader) return fromHeader;
  const { data } = await supabase.from('stores').select('id').limit(1).single();
  return data?.id || null;
}
```

---

## 5. Delete Products

In product list rows: Trash2 icon button calls `handleDeleteProduct(id)`:
```js
async function handleDeleteProduct(id) {
  await fetch(`${API_URL}/db/products/${id}`, { method: 'DELETE' });
  setProducts(prev => prev.filter(p => p.id !== id));
}
```

---

## 6. Variants Tab in ProductDetail

Replace placeholder with working UI. Data: `product.variants` array (snake_case from DB).

### Variant fields in DB (variants table)
`option1_name, option1_value, option2_name, option2_value, option3_name, option3_value, sku, barcode, price, compare_at_price, cost, inventory_quantity, weight, position`

### UI
Detect option columns from `variants[0].option1_name` etc. Show only filled option columns.

Option name editors: inputs that update the shared name across all variants.

Table: one row per variant, columns for each active option value + sku, barcode, price, cost, inventory_quantity. All editable inline.

Per-row delete (minimum 1 enforced). "Lägg till variant" at bottom.

### addVariant
```js
const addVariant = () => {
  const first = editedProduct.variants?.[0] || {};
  setEditedProduct(prev => ({
    ...prev,
    variants: [...(prev.variants || []), {
      id: `v_${Date.now()}`,
      sku: '', barcode: '',
      price: prev.default_price ?? null,
      compare_at_price: null,
      cost: prev.default_cost ?? null,
      inventory_quantity: 0,
      weight: prev.weight ?? null,
      option1_name: first.option1_name || null, option1_value: '',
      option2_name: first.option2_name || null, option2_value: '',
      option3_name: first.option3_name || null, option3_value: '',
    }]
  }));
};
```

Variants saved via `updateProduct` (db.js) which deletes all and reinserts.

---

## 7. AI Content → Shopify Metafields

### In shopify.js buildShopifyProduct()
Add before `transformMetafields()` call:
```js
const metafields = { ...(product.metafields || {}) };
// SEO
if (product.seo_title) metafields['global.title_tag'] = product.seo_title;
if (product.seo_description) metafields['global.description_tag'] = product.seo_description;
// AI content (top-level DB columns → metafields)
if (product.short_description) metafields['custom.short_description'] = product.short_description;
if (product.agent_summary) metafields['custom.agent_summary'] = product.agent_summary;
if (product.use_cases) metafields['custom.use_cases'] = product.use_cases;
if (product.specifications?.length) metafields['custom.specifications'] = product.specifications;
if (product.faq?.length) metafields['custom.faq'] = product.faq;
```

### Static type mappings (_staticMetafieldTypes)
```js
'custom.short_description': 'single_line_text_field',
'custom.agent_summary': 'multi_line_text_field',
'custom.use_cases': 'multi_line_text_field',
'custom.specifications': 'json',   // [{"name":"...","value":"..."}]
'custom.faq': 'json',              // [{"question":"...","answer":"..."}]
'custom.kort_produktbeskrivning': 'multi_line_text_field',
```

### inferMetafieldType
```js
inferMetafieldType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'number_integer' : 'number_decimal';
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return 'json';
  if (typeof value === 'string') {
    if (value.startsWith('http')) return 'url';
    if (value.includes('\n')) return 'multi_line_text_field';
  }
  return 'single_line_text_field';
}
```

### Auto-create definitions before push
In both `createProduct()` and `updateProduct()` in shopify.js:
```js
await this.syncMetafieldDefinitions(store).catch(e => console.warn('Metafield def sync failed:', e.message));
```

---

## 8. Source Material for AI Generation

### Three input types in ProductDetail "Källmaterial" section

**a) Text** — `metafields['custom.source_material']` textarea (never synced to Shopify — add to internal skip list in transformMetafields)

**b) URL fetch**
```
POST /api/source/fetch-url
body: { url }
→ fetch URL, strip <script>, <style>, all HTML tags, decode entities
→ collapse whitespace, return up to 15,000 chars
→ returns { text, length }
```

**c) File upload** (PDF, DOCX, TXT) via multipart
```
POST /api/source/extract-document
→ pdf-parse for PDF: const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default
→ mammoth for DOCX: const mammoth = (await import('mammoth')).default; mammoth.extractRawText({buffer})
→ raw buffer.toString('utf-8') for TXT
→ cap at 15,000 chars, returns { text, filename, length }
```

### Frontend State
```js
const [sourceUrl, setSourceUrl] = useState('');
const [urlStatus, setUrlStatus] = useState('idle'); // idle|fetching|done|error
const [urlText, setUrlText] = useState('');
const [docText, setDocText] = useState('');
const [docName, setDocName] = useState('');
```

### buildCombinedSourceMaterial
```js
const buildCombinedSourceMaterial = () => {
  const parts = [];
  const textSource = editedProduct.metafields?.['custom.source_material'];
  if (textSource) parts.push(textSource);
  if (urlText) parts.push(`--- Hämtat från ${sourceUrl} ---\n${urlText}`);
  if (docText) parts.push(`--- Dokument: ${docName} ---\n${docText}`);
  return parts.join('\n\n');
};
```

Pass as `sourceMaterial` in every AI generate call.

### UI
Show status badges: "✓ Text", "✓ URL", "✓ Dokument" + total char count.

---

## 9. Image Scraper

### Server Endpoint: POST /api/source/scrape-images
```js
// body: { url, sku, title, barcode }
// 1. Fetch page HTML
// 2. Parse all <img> tags → extract src, srcset (pick largest), alt, title
// 3. Resolve relative URLs
// 4. Skip: SVG, GIF, data URIs, icon/logo/arrow/banner/sprite paths, < 5KB
// 5. Score each image:
const skuClean = sku.toLowerCase().replace(/[-_\s]/g, '');
// SKU exact match → 100, SKU normalized → 90, barcode → 80, 2+ title words → 40-60, 1 word → 20
// 6. Return { matches: scored.filter(s > 0).sort(desc), others: unscored.slice(0,20), total }
```

### Frontend UI (in ProductDetail images tab)
- URL input + "Sök bilder" button → sets `scrapeResults` state
- Matched images: 110×110 thumbnails, match reason label, "Lägg till" button
- Others: 80×80 grid, click to add
- Already-added images show ✓

---

## 10. Local Image Upload + AI Alt Text

### Server: POST /api/images/upload (multipart, field: 'image')
```js
// body fields: productId, productTitle, sku, position
// 1. Build filename: {sku-slug}-{title-slug}-{position}.jpg
// 2. Resize with sharp: max 1200×1200, fit inside, jpeg quality 85
// 3. Upload to Supabase Storage 'product-images' bucket: path = {productId}/{filename}
// 4. Return { url: publicUrl, filename }
```

Requires product to be saved (real UUID, not `new-*`).

### Server: POST /api/images/generate-alt
```js
// body: { imageUrl, productTitle, productType, vendor }
// 1. Fetch image as base64
// 2. Send to Claude with vision:
messageContent = [
  { type: 'image', source: { type: 'base64', media_type, data: base64 } },
  { type: 'text', text: `Skriv SEO-optimerad alt-text på svenska. Produkt: ${productTitle}. Max 125 tecken. Svara ENBART med alt-texten.` }
]
// 3. Falls back to text-only if image fetch fails
// Returns { altText }
```

### Frontend
- Hidden `<input type="file" accept="image/*">` ref, triggered by "Välj bild från dator" button
- Upload → POST /api/images/upload → handleImageAdd(url)
- Per-image Sparkles button → `handleGenerateAltText(imageId, imageUrl)` → fills alt text input

### Optimize endpoint filename update
`{sku-slug}-{title-slug}.jpg` instead of just `{title-slug}.jpg`
SKU from `product.sku || product.variants?.[0]?.sku`

---

## 11. Vision-Based Image Analysis in AI Generation

### In /api/claude/enrich endpoint, before API call
```js
const imageUrls = (product.images || [])
  .map(img => img.url || img.src)
  .filter(u => u?.startsWith('http'))
  .slice(0, 3);

const messageContent = [];
let imagesAnalyzed = 0;

for (const imgUrl of imageUrls) {
  try {
    const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(6000) });
    if (!imgRes.ok) continue;
    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    const mediaType = ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp' : 'image/jpeg';
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length < 5000) continue; // skip tiny placeholders
    messageContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
    imagesAnalyzed++;
  } catch (_) {}
}

const textContent = imagesAnalyzed > 0
  ? `[Bildanalys: ${imagesAnalyzed} produktbild(er) bifogas. Analysera och använd visuell info (färg, material, form, vad som ingår) som komplement. Rapportera ENBART vad du faktiskt ser — gissa aldrig.]\n\n${prompt}`
  : prompt;
messageContent.push({ type: 'text', text: textContent });

const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: maxTokens,
  system: systemPrompt,
  messages: [{ role: 'user', content: messageContent }],
});
```

### Full Product Context
The `productContext` string passed in every prompt:
```js
const productContext = `
=== BEFINTLIG PRODUKTDATA ===
Titel: ${product.title}
Varumärke: ${product.vendor}
Produkttyp: ${product.product_type || product.type}
SKU: ${product.sku} / EAN: ${product.barcode}
Pris: ${product.default_price} / Inköp: ${product.default_cost}
Befintlig beskrivning: ${stripHtml(product.description).slice(0, 800)}
Befintliga specifikationer: ${JSON.stringify(product.specifications || [])}
Befintlig FAQ: ${JSON.stringify(product.faq || [])}
Befintliga metafält: ${Object.entries(product.metafields || {}).filter(([k]) => k !== 'custom.source_material').map(([k,v]) => `${k}: ${v}`).join(', ')}
Varianter:
${(product.variants || []).slice(0,20).map(v => [v.option1_name && `${v.option1_name}: ${v.option1_value}`, v.option2_name && `${v.option2_name}: ${v.option2_value}`, v.sku && `SKU: ${v.sku}`, v.price != null && `Pris: ${v.price}`].filter(Boolean).join(', ')).join('\n')}

${combinedSource ? `=== KÄLLMATERIAL ===\n${combinedSource.slice(0, 12000)}\n=== SLUT ===` : ''}`;
```

### System Prompt (all enrich calls)
```
ABSOLUT VIKTIGASTE REGEL:
- Använd ENBART information från produktdatan och källmaterialet
- Hitta ALDRIG på fakta, mått, material, teknologi, priser
- Om fakta saknas: utelämna eller skriv "Kontakta oss för mer info"
- Du är en redaktör som strukturerar befintlig data — inte en fantasiförfattare
```

### AI Content Tab UI Badge
Show in "Generera allt"-section:
- "✓ Text" / "✓ URL" / "✓ Dokument" badges if source material exists
- "✓ Bildanalys" badge (accent color) if product has images
- Loading spinner on button while generating

---

## 12. Collections Feature

### Database
```sql
CREATE TABLE collections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  handle VARCHAR(255),
  description TEXT,
  collection_type VARCHAR(20) DEFAULT 'manual', -- manual | smart
  sort_order VARCHAR(50) DEFAULT 'best-selling',
  published BOOLEAN DEFAULT true,
  image_url TEXT,
  image_alt TEXT,
  rules JSONB DEFAULT '[]',
  disjunctive BOOLEAN DEFAULT false, -- false=AND, true=OR
  seo_title VARCHAR(70),
  seo_description VARCHAR(160),
  agent_summary TEXT,
  short_description TEXT,
  use_cases TEXT,
  faq JSONB,
  metafields JSONB DEFAULT '{}',
  shopify_collection_id BIGINT,
  shopify_collection_gid VARCHAR(255),
  sync_status VARCHAR(50) DEFAULT 'pending',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, handle)
);

CREATE TABLE collection_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  position INT,
  UNIQUE(collection_id, product_id)
);

CREATE INDEX idx_collections_store ON collections(store_id);
CREATE INDEX idx_collections_shopify ON collections(shopify_collection_id);
```

### Server Endpoints

```
GET    /api/db/collections
         → supabase.from('collections').select('*').eq('store_id', storeId).order('title')

GET    /api/db/collections/:id
         → select with: collection_products(*, products(id, title, sku, images(*)))

POST   /api/db/collections
         body: { title, collection_type, handle? }
         → insert, resolveStoreId

PUT    /api/db/collections/:id
         body: all fields
         → update

DELETE /api/db/collections/:id

GET    /api/shopify/stores/:storeId/collections
         → fetch /custom_collections.json?limit=250  (type: 'manual')
         → fetch /smart_collections.json?limit=250   (type: 'smart')
         → combine, return unified array

POST   /api/shopify/stores/:storeId/import-collections
         body: { collectionIds: [shopifyId, ...] }
         → for each ID: upsert into collections (skip if shopify_collection_id exists)
         → return { imported, skipped }

POST   /api/db/collections/:id/sync
         → get collection, get store, get ShopifyClient
         → smart: PUT/POST /smart_collections/{id}.json with rules, disjunctive
         → manual: PUT/POST /custom_collections/{id}.json
         → include metafields array (same transformMetafields as products)
         → update shopify_collection_id and sync_status in DB

POST   /api/db/collections/:id/add-product
         body: { productId }
         → insert into collection_products

DELETE /api/db/collections/:id/products/:productId
         → delete from collection_products

POST   /api/claude/collections/:id/enrich
         body: { field }
         → field: all | description | agentSummary | shortDescription | faq | useCases | seo
         → context: collection.title, handle, description, first 20 product titles from collection_products
         → model: claude-sonnet-4-6
         → same no-hallucination system prompt
```

### Smart Collection Rules Format (Shopify)
```json
{
  "rules": [
    { "column": "tag",           "relation": "equals",       "condition": "sommar" },
    { "column": "type",          "relation": "equals",       "condition": "Tallrik" },
    { "column": "vendor",        "relation": "contains",     "condition": "Affari" },
    { "column": "variant_price", "relation": "greater_than", "condition": "100" }
  ],
  "disjunctive": false
}
```

Available columns: `tag`, `type`, `vendor`, `title`, `variant_price`
Available relations: `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `greater_than`, `less_than`

### CollectionsView.jsx — Component Structure

**State:**
```js
const [collections, setCollections] = useState([]);       // from PIM DB
const [shopifyCollections, setShopifyCollections] = useState([]); // from Shopify
const [gapCollections, setGapCollections] = useState([]); // in Shopify, not in PIM
const [selectedCollection, setSelectedCollection] = useState(null);
const [showDetail, setShowDetail] = useState(false);
const [showCreateModal, setShowCreateModal] = useState(false);
const [showImportModal, setShowImportModal] = useState(false);
const [loading, setLoading] = useState(false);
const [syncing, setSyncing] = useState(new Set());
const [search, setSearch] = useState('');
const [generatingAI, setGeneratingAI] = useState(false);
const [activeTab, setActiveTab] = useState('general');
```

**On mount:** load `/api/db/collections` + `/api/shopify/stores/:storeId/collections`. Gap = shopify collections whose `id` not in PIM `shopify_collection_id` set.

**List view:**
- Search input filtering by title
- "Ny collection" button → showCreateModal
- "Importera från Shopify" button → showImportModal (if gap > 0, show banner first)
- Gap banner: "X collections i Shopify saknas i PIM — Importera"
- Table rows: image thumbnail (48×48) or first-letter fallback circle, title, type badge (Smart=accent/Manual=secondary), products count, sync status dot, Edit + Sync + Delete buttons

**Detail modal — 6 tabs:**

1. **Allmänt**
   - Title input
   - Handle input (auto-slugify from title on blur)
   - Type: readonly badge if from Shopify, else Smart/Manuell toggle
   - Published boolean toggle
   - Sort order select: `best-selling | title-asc | title-desc | price-asc | price-desc | created-desc | manual`
   - Image URL input + thumbnail preview

2. **Beskrivning**
   - ReactQuill rich text for `description`
   - Short description textarea (max 200 chars) + AI generate button
   - Character counters

3. **AI-innehåll**
   - Agent Summary textarea + generate button
   - FAQ: array of {question, answer} pairs, add/remove + generate button
   - Användningsfall textarea + generate button
   - "Generera allt" button
   - Info: "X produkter i collectionen används som kontext"

4. **SEO**
   - SEO Title input (max 60 chars, counter)
   - SEO Description textarea (max 155 chars, counter)
   - Google SERP preview (styled div: green URL, blue title, gray description)

5. **Metafält**
   - Key-value editor for metafields JSONB
   - Keys in `namespace.key` format
   - Add/remove rows

6. **Produkter (Smart)**
   - Disjunctive toggle: "Alla regler (AND)" / "Minst en regel (OR)"
   - Rule list: each row = column select + relation select + condition input + remove button
   - "Lägg till regel" button

6. **Produkter (Manual)**
   - Search input with typeahead → `GET /api/db/products?search=X&limit=10`
   - Dropdown results, click → `POST /api/db/collections/:id/add-product`
   - Current products list with remove button

**Create Modal:** Title input, Smart/Manual radio → POST /api/db/collections

**Import Modal:** Checkbox list of gap collections, select-all → POST /api/shopify/stores/:storeId/import-collections

### App.jsx additions
```jsx
import CollectionsView from './components/CollectionsView';

// In sidebar nav (Produkter section):
<div className={`nav-item ${activeView === 'collections' ? 'active' : ''}`}
  onClick={() => setActiveView('collections')}>
  <Layers size={20} />
  <span className="nav-label">Collections</span>
</div>

// In main content routing:
{activeView === 'collections' && <CollectionsView stores={stores} />}
```

---

## Cross-Cutting Concerns

### All Anthropic API calls
Model: `claude-sonnet-4-6` (never use older IDs like `claude-sonnet-4-20250514`)

### Image Storage Flow
1. External URL (scraped/entered) → URL reference stored in `images` table
2. "Optimera" button → download → sharp resize → Supabase Storage `product-images/{productId}/{sku-slug}.jpg` → update URL
3. Local upload → straight to Supabase Storage → permanent URL
4. Shopify push → Shopify fetches from URL (Supabase Storage URLs are permanent public)

### Supabase Storage setup required
Bucket name: `product-images`, public read access.

### Key npm packages needed
```
@anthropic-ai/sdk, @supabase/supabase-js, express, cors, multer, sharp,
pdf-parse, mammoth, xlsx, bcryptjs, dotenv, react-quill, lucide-react
```

### ESM note
Project uses `"type": "module"` — all imports use ESM syntax. For pdf-parse use dynamic import:
```js
const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
```

### Metafield internal skip list
These metafields are stored in PIM but never synced to Shopify:
```js
const internalMetafields = ['custom.source_material'];
```
