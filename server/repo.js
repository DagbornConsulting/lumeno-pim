// DB repository for products, variants, images, metafields
import { query, getClient } from './db.js';

// ============================================
// PRODUCTS
// ============================================
export async function listProducts({ search, status, sync_status, vendor, product_type, limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];
  let i = 1;
  if (search) { where.push(`(title ILIKE $${i} OR handle ILIKE $${i} OR vendor ILIKE $${i})`); params.push(`%${search}%`); i++; }
  if (status) { where.push(`status = $${i}`); params.push(status); i++; }
  if (sync_status) { where.push(`sync_status = $${i}`); params.push(sync_status); i++; }
  if (vendor) { where.push(`vendor = $${i}`); params.push(vendor); i++; }
  if (product_type) { where.push(`product_type = $${i}`); params.push(product_type); i++; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT p.*,
      (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id) AS variant_count,
      (SELECT COUNT(*) FROM images i WHERE i.product_id = p.id) AS image_count,
      (SELECT src FROM images i WHERE i.product_id = p.id ORDER BY position LIMIT 1) AS first_image
    FROM products p
    ${whereSql}
    ORDER BY p.updated_at DESC
    LIMIT $${i} OFFSET $${i + 1}
  `;
  params.push(limit, offset);
  const res = await query(sql, params);
  return res.rows;
}

export async function getProduct(id) {
  const p = await query('SELECT * FROM products WHERE id = $1', [id]);
  if (p.rows.length === 0) return null;
  const product = p.rows[0];
  const [variants, images, options, metafields] = await Promise.all([
    query('SELECT * FROM variants WHERE product_id = $1 ORDER BY position, created_at', [id]),
    query('SELECT * FROM images WHERE product_id = $1 ORDER BY position', [id]),
    query('SELECT * FROM product_options WHERE product_id = $1 ORDER BY position', [id]),
    query('SELECT * FROM metafields WHERE product_id = $1 ORDER BY namespace, key', [id]),
  ]);
  product.variants = variants.rows;
  product.images = images.rows;
  product.options = options.rows;
  product.metafields = metafields.rows;
  return product;
}

export async function createProduct(data) {
  const res = await query(
    `INSERT INTO products (title, handle, body_html, vendor, product_type, tags, status,
       seo_title, seo_description,
       google_gender, google_age_group, google_mpn, google_condition, google_category,
       google_custom_product, google_adwords_grouping, google_adwords_labels,
       sync_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, 'new')
     RETURNING *`,
    [
      data.title, data.handle || null, data.body_html || null, data.vendor || null,
      data.product_type || null, data.tags || null, data.status || 'draft',
      data.seo_title || null, data.seo_description || null,
      data.google_gender || null, data.google_age_group || null, data.google_mpn || null,
      data.google_condition || null, data.google_category || null,
      data.google_custom_product ?? null, data.google_adwords_grouping || null,
      data.google_adwords_labels || null,
    ]
  );
  return res.rows[0];
}

export async function updateProduct(id, data) {
  const fields = [
    'title','handle','body_html','vendor','product_type','tags','status','published_at',
    'seo_title','seo_description',
    'google_gender','google_age_group','google_mpn','google_condition','google_category',
    'google_custom_product','google_adwords_grouping','google_adwords_labels',
  ];
  const sets = [];
  const params = [];
  let i = 1;
  for (const f of fields) {
    if (f in data) {
      sets.push(`${f} = $${i}`);
      params.push(data[f]);
      i++;
    }
  }
  if (sets.length === 0) return getProduct(id);
  params.push(id);
  const sql = `UPDATE products SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`;
  const res = await query(sql, params);
  return res.rows[0];
}

export async function deleteProduct(id) {
  await query('DELETE FROM products WHERE id = $1', [id]);
}

export async function markProductSynced(id, shopifyId) {
  await query(
    `UPDATE products SET sync_status = 'synced', shopify_product_id = $2, last_synced_at = NOW(), sync_error = NULL WHERE id = $1`,
    [id, shopifyId]
  );
}

export async function markProductError(id, error) {
  await query(
    `UPDATE products SET sync_status = 'error', sync_error = $2 WHERE id = $1`,
    [id, error]
  );
}

// ============================================
// VARIANTS
// ============================================
export async function replaceVariants(productId, variants) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM variants WHERE product_id = $1', [productId]);
    for (const [idx, v] of variants.entries()) {
      await client.query(
        `INSERT INTO variants (product_id, shopify_variant_id, title, sku, barcode,
           price, compare_at_price, cost, weight, weight_unit,
           option1, option2, option3,
           inventory_quantity, inventory_policy, inventory_management,
           requires_shipping, taxable, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          productId, v.shopify_variant_id || null, v.title || null, v.sku || null, v.barcode || null,
          v.price ?? null, v.compare_at_price ?? null, v.cost ?? null,
          v.weight ?? null, v.weight_unit || 'kg',
          v.option1 || null, v.option2 || null, v.option3 || null,
          v.inventory_quantity ?? 0, v.inventory_policy || 'deny', v.inventory_management || 'shopify',
          v.requires_shipping ?? true, v.taxable ?? true, v.position || idx + 1,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ============================================
// IMAGES
// ============================================
export async function replaceImages(productId, images) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM images WHERE product_id = $1', [productId]);
    for (const [idx, img] of images.entries()) {
      await client.query(
        `INSERT INTO images (product_id, shopify_image_id, src, alt, position, width, height)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [productId, img.shopify_image_id || null, img.src, img.alt || null, img.position || idx + 1, img.width || null, img.height || null]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ============================================
// METAFIELDS (values per product)
// ============================================
export async function replaceMetafields(productId, metafields) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM metafields WHERE product_id = $1', [productId]);
    for (const mf of metafields) {
      await client.query(
        `INSERT INTO metafields (product_id, shopify_metafield_id, namespace, key, value, type)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [productId, mf.shopify_metafield_id || null, mf.namespace, mf.key, mf.value ?? '', mf.type]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ============================================
// METAFIELD DEFINITIONS
// ============================================
export async function listMetafieldDefinitions() {
  const res = await query('SELECT * FROM metafield_definitions ORDER BY namespace, key');
  return res.rows;
}

export async function createMetafieldDefinition(data) {
  const res = await query(
    `INSERT INTO metafield_definitions (namespace, key, name, description, owner_type, type, validations, pin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [data.namespace, data.key, data.name, data.description || null,
     data.owner_type || 'PRODUCT', data.type,
     JSON.stringify(data.validations || []), data.pin !== false]
  );
  return res.rows[0];
}

export async function updateMetafieldDefinitionSynced(id, shopifyId) {
  await query(
    `UPDATE metafield_definitions SET sync_status = 'synced', shopify_definition_id = $2, last_synced_at = NOW() WHERE id = $1`,
    [id, shopifyId]
  );
}

export async function deleteMetafieldDefinition(id) {
  await query('DELETE FROM metafield_definitions WHERE id = $1', [id]);
}

// ============================================
// STORE CONFIG
// ============================================
export async function getStoreConfig() {
  const res = await query('SELECT * FROM store_config WHERE id = 1');
  return res.rows[0] || null;
}

export async function saveStoreConfig({ domain, admin_token, api_version }) {
  const res = await query(
    `INSERT INTO store_config (id, domain, admin_token, api_version, updated_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET
       domain = EXCLUDED.domain,
       admin_token = EXCLUDED.admin_token,
       api_version = EXCLUDED.api_version,
       updated_at = NOW()
     RETURNING id, domain, api_version, updated_at`,
    [domain, admin_token, api_version || '2024-10']
  );
  return res.rows[0];
}

// ============================================
// FILTER FACETS
// ============================================
export async function getFilterFacets() {
  const [vendors, types, counts] = await Promise.all([
    query(`SELECT DISTINCT vendor FROM products WHERE vendor IS NOT NULL AND vendor <> '' ORDER BY vendor`),
    query(`SELECT DISTINCT product_type FROM products WHERE product_type IS NOT NULL AND product_type <> '' ORDER BY product_type`),
    query(`SELECT sync_status, COUNT(*) FROM products GROUP BY sync_status`),
  ]);
  return {
    vendors: vendors.rows.map(r => r.vendor),
    product_types: types.rows.map(r => r.product_type),
    sync_counts: Object.fromEntries(counts.rows.map(r => [r.sync_status, parseInt(r.count, 10)])),
  };
}
