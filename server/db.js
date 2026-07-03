import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import dotenv from 'dotenv';
import { createPgAdapter } from './pg-adapter.js';

dotenv.config();

const { Pool } = pg;

// ============================================
// SUPABASE CLIENT (recommended)
// ============================================

const supabaseUrl = process.env.SUPABASE_URL;
// The server MUST use the service-role key: it operates on behalf of all
// tenants and, once RLS is enabled, the anon key would be denied by policy.
// Falling back to the anon key silently would either break the app (RLS on)
// or mask a misconfiguration (RLS off). Fail loudly instead.
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (supabaseUrl && !supabaseKey) {
  console.error('❌ SUPABASE_SERVICE_KEY missing — the server requires the service-role key. Refusing to fall back to the anon key.');
}

const supabaseClient = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      global: {
        fetch: (url, options = {}) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          return fetch(url, { ...options, signal: controller.signal })
            .finally(() => clearTimeout(timer));
        },
      },
    })
  : null;

// ============================================
// DIRECT POSTGRES CONNECTION (fallback/advanced)
// ============================================

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    })
  : null;

// ============================================
// SUPABASE-COMPATIBLE CLIENT
// If Supabase is configured, use real Supabase client.
// Otherwise, if DATABASE_URL is set, use the pg-adapter
// which mimics the Supabase API against local PostgreSQL.
// ============================================

export const supabase = supabaseClient
  ? supabaseClient
  : pool
    ? createPgAdapter(pool)
    : null;

// Check if database is configured
export const isDbConfigured = () => !!(supabase || pool);

// Round to whole krona — product prices in PIM and Shopify must be integers.
const roundPrice = (v) => {
  if (v == null || v === '') return v;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : v;
};

const PRODUCT_PRICE_FIELDS = ['default_price', 'default_compare_at_price'];
const VARIANT_PRICE_FIELDS = ['price', 'compare_at_price'];

// Round any present price fields on a product/variant payload, leaving other
// fields untouched. Used at the DB write boundary to guarantee whole prices.
const withRoundedPrices = (obj, fields) => {
  if (!obj) return obj;
  const out = { ...obj };
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(out, f)) out[f] = roundPrice(out[f]);
  }
  return out;
};

// ============================================
// DATABASE HELPER FUNCTIONS
// ============================================

export const db = {
  // Test connection
  async testConnection() {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('stores').select('id').limit(1);
        if (error) throw error;
        console.log(supabaseClient ? '✅ Supabase connected' : '✅ PostgreSQL connected (pg-adapter)');
        return true;
      } else if (pool) {
        const client = await pool.connect();
        await client.query('SELECT NOW()');
        client.release();
        console.log('✅ PostgreSQL connected');
        return true;
      } else {
        console.log('⚠️  No database configured');
        return false;
      }
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      return false;
    }
  },

  // Generic query (for direct SQL)
  async query(sql, params = []) {
    if (!pool) throw new Error('Direct database connection not configured');
    const result = await pool.query(sql, params);
    return result.rows;
  },

  // ============================================
  // PRODUCTS
  // ============================================

  async getProducts({
    vendor,
    type,
    status,
    tags,
    search,
    storeId,
    storeFilter, // 'published' or 'unpublished'
    syncFilter, // 'pending' - visar bara produkter som behöver synkas till Central
    imageFilter, // 'with' = bara produkter med minst en bild, 'without' = bara utan
    limit = 100,
    offset = 0
  } = {}) {
    if (!supabase) throw new Error('Supabase not configured');

    // Build base query with filters
    let baseQuery = supabase
      .from('products')
      .select(`
        *,
        variants (*),
        images (*),
        store_products (
          *,
          stores (id, name, domain)
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false });

    // Filter by store_id (required)
    if (storeId) baseQuery = baseQuery.eq('store_id', storeId);

    // Apply database-level filters
    if (vendor) baseQuery = baseQuery.eq('vendor', vendor);
    if (type) baseQuery = baseQuery.eq('product_type', type);
    if (status) baseQuery = baseQuery.eq('status', status);
    if (tags?.length) baseQuery = baseQuery.overlaps('tags', tags);
    if (search) {
      // Wrap value in double quotes so PostgREST treats reserved chars (, . : () ) as literal.
      // Escape embedded backslashes and double quotes per PostgREST grammar.
      const safe = search.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      baseQuery = baseQuery.or(`title.ilike."%${safe}%",vendor.ilike."%${safe}%"`);
    }

    // Fetch ALL matching products using pagination (Supabase has 1000 row limit per request)
    let allData = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore && allData.length < 20000) { // Safety limit of 20000 total
      const query = baseQuery.range(page * pageSize, (page + 1) * pageSize - 1);
      const { data: pageData, error } = await query;

      if (error) throw error;

      if (pageData && pageData.length > 0) {
        allData = [...allData, ...pageData];
        page++;
        hasMore = pageData.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    let filteredData = allData;

    // Apply store filter if needed (client-side since Supabase doesn't support filtering on joined tables)
    if (storeId && storeFilter) {
      if (storeFilter === 'published') {
        filteredData = filteredData.filter(p =>
          p.store_products?.some(sp => String(sp.store_id) === String(storeId) && sp.is_published)
        );
      } else if (storeFilter === 'unpublished') {
        filteredData = filteredData.filter(p =>
          !p.store_products?.some(sp => String(sp.store_id) === String(storeId))
        );
      } else if (storeFilter === 'error') {
        filteredData = filteredData.filter(p =>
          p.store_products?.some(sp => String(sp.store_id) === String(storeId) && sp.sync_status === 'error')
        );
      }
    }

    // Apply sync filter - visa bara produkter som behöver synkas till Central
    if (syncFilter === 'pending') {
      filteredData = filteredData.filter(p =>
        p.store_products?.some(sp =>
          sp.stores?.domain?.includes('pq-golf-sverige') &&
          sp.sync_status === 'pending'
        )
      );
    }

    // Apply image filter — products that have / lack images
    if (imageFilter === 'with') {
      filteredData = filteredData.filter(p => (p.images?.length || 0) > 0);
    } else if (imageFilter === 'without') {
      filteredData = filteredData.filter(p => (p.images?.length || 0) === 0);
    }

    // Apply pagination after all filtering
    const paginatedData = filteredData.slice(offset, offset + limit);

    return {
      data: paginatedData,
      count: filteredData.length,
      total: filteredData.length
    };
  },

  async getFilterMetadata(storeId) {
    if (!supabase) throw new Error('Supabase not configured');

    // Get all unique vendors (brands) - fetch ALL products (no limit)
    let allVendorData = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      let query = supabase
        .from('products')
        .select('vendor')
        .not('vendor', 'is', null);
      if (storeId) query = query.eq('store_id', storeId);
      const { data: vendorData } = await query.range(page * pageSize, (page + 1) * pageSize - 1);

      if (vendorData && vendorData.length > 0) {
        allVendorData = [...allVendorData, ...vendorData];
        page++;
        hasMore = vendorData.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    const brands = [...new Set(allVendorData.map(p => p.vendor).filter(Boolean))].sort();

    // Get all unique product types
    let allTypeData = [];
    page = 0;
    hasMore = true;

    while (hasMore) {
      let query = supabase
        .from('products')
        .select('product_type')
        .not('product_type', 'is', null);
      if (storeId) query = query.eq('store_id', storeId);
      const { data: typeData } = await query.range(page * pageSize, (page + 1) * pageSize - 1);

      if (typeData && typeData.length > 0) {
        allTypeData = [...allTypeData, ...typeData];
        page++;
        hasMore = typeData.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    const types = [...new Set(allTypeData.map(p => p.product_type).filter(Boolean))].sort();

    // Get all unique tags
    let allTagData = [];
    page = 0;
    hasMore = true;

    while (hasMore) {
      let query = supabase
        .from('products')
        .select('tags')
        .not('tags', 'is', null);
      if (storeId) query = query.eq('store_id', storeId);
      const { data: tagData } = await query.range(page * pageSize, (page + 1) * pageSize - 1);

      if (tagData && tagData.length > 0) {
        allTagData = [...allTagData, ...tagData];
        page++;
        hasMore = tagData.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    const allTags = [...new Set(allTagData.flatMap(p => p.tags || []).filter(Boolean))].sort();

    return { brands, types, tags: allTags };
  },

  async getProductById(id) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('products')
      .select(`
        *,
        variants (*),
        images (*),
        store_products (
          *,
          stores (id, name, domain, custom_domain)
        )
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  },

  async createProduct(product) {
    if (!supabase) throw new Error('Supabase not configured');

    const { variants, images, ...rawProductData } = product;
    const productData = withRoundedPrices(rawProductData, PRODUCT_PRICE_FIELDS);

    console.log('DB: Creating product with data:', JSON.stringify(productData, null, 2));

    // Insert product
    const { data: newProduct, error: productError } = await supabase
      .from('products')
      .insert(productData)
      .select()
      .single();

    if (productError) {
      console.error('DB: Product insert error:', productError);
      throw new Error(productError.message || 'Failed to insert product');
    }

    console.log('DB: Product created with ID:', newProduct.id);

    // Insert variants
    if (variants?.length) {
      const variantsWithProductId = variants.map((v, idx) => ({
        ...withRoundedPrices(v, VARIANT_PRICE_FIELDS),
        product_id: newProduct.id,
        position: idx + 1
      }));

      const { error: variantError } = await supabase
        .from('variants')
        .insert(variantsWithProductId);

      if (variantError) throw variantError;
    }

    // Insert images
    if (images?.length) {
      const imagesWithProductId = images.map((img, idx) => ({
        ...img,
        product_id: newProduct.id,
        position: idx + 1
      }));

      const { error: imageError } = await supabase
        .from('images')
        .insert(imagesWithProductId);

      if (imageError) throw imageError;
    }

    return this.getProductById(newProduct.id);
  },

  async updateProduct(id, updates) {
    if (!supabase) throw new Error('Supabase not configured');

    const { variants, images, ...rawProductData } = updates;
    const productData = withRoundedPrices(rawProductData, PRODUCT_PRICE_FIELDS);

    // Update product
    const { error: productError } = await supabase
      .from('products')
      .update(productData)
      .eq('id', id);

    if (productError) throw productError;

    // Update variants if provided
    if (variants) {
      // Delete existing variants
      await supabase.from('variants').delete().eq('product_id', id);

      // Insert new variants
      if (variants.length) {
        const variantsWithProductId = variants.map((v, idx) => {
          // Remove id field completely to avoid constraint violations
          const { id: _unusedId, ...variantWithoutId } = v;
          return {
            ...withRoundedPrices(variantWithoutId, VARIANT_PRICE_FIELDS),
            product_id: id,
            position: idx + 1
          };
        });

        const { error: variantError } = await supabase
          .from('variants')
          .insert(variantsWithProductId);

        if (variantError) throw variantError;
      }
    }

    // Update images if provided
    if (images) {
      await supabase.from('images').delete().eq('product_id', id);
      
      if (images.length) {
        const imagesWithProductId = images.map((img, idx) => ({
          url: img.url,
          alt_text: img.alt || img.alt_text,
          product_id: id,
          position: idx + 1
        }));

        const { error: imageError } = await supabase
          .from('images')
          .insert(imagesWithProductId);

        if (imageError) throw imageError;
      }
    }

    return this.getProductById(id);
  },

  async deleteProduct(id) {
    if (!supabase) throw new Error('Supabase not configured');

    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return true;
  },

  async bulkUpdateProducts(updates, storeId) {
    // updates = { [productId]: { price, compareAtPrice, ... } }
    if (!supabase) throw new Error('Supabase not configured');

    const results = [];
    for (const [id, data] of Object.entries(updates)) {
      try {
        // Verify product belongs to store before updating
        if (storeId) {
          const product = await this.getProductById(id);
          if (!product || String(product.store_id) !== String(storeId)) {
            results.push({ id, success: false, error: 'Produkten tillhör inte denna butik' });
            continue;
          }
        }
        await this.updateProduct(id, data);
        results.push({ id, success: true });
      } catch (error) {
        results.push({ id, success: false, error: error.message });
      }
    }
    return results;
  },

  // ============================================
  // STORES
  // ============================================

  async getStores() {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('stores')
      .select('*')
      .order('name');

    if (error) throw error;
    return data;
  },

  async getStoreById(id) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('stores')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  },

  async createStore(store) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('stores')
      .insert(store)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateStore(id, updates) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('stores')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // ============================================
  // STORE PRODUCTS (Publishing)
  // ============================================

  async publishProductToStores(productId, storeIds) {
    if (!supabase) throw new Error('Supabase not configured');

    const records = storeIds.map(storeId => ({
      product_id: productId,
      store_id: storeId,
      sync_status: 'pending',
      is_published: true,
      published_at: new Date().toISOString()
    }));

    const { data, error } = await supabase
      .from('store_products')
      .upsert(records, { onConflict: 'store_id,product_id' })
      .select();

    if (error) throw error;
    return data;
  },

  async unpublishProductFromStore(productId, storeId) {
    if (!supabase) throw new Error('Supabase not configured');

    const { error } = await supabase
      .from('store_products')
      .update({ is_published: false, sync_status: 'pending' })
      .eq('product_id', productId)
      .eq('store_id', storeId);

    if (error) throw error;
    return true;
  },

  async updateStoreProductSyncStatus(productId, storeId, status, errorMessage = null) {
    if (!supabase) throw new Error('Supabase not configured');

    const updates = {
      sync_status: status,
      last_sync_error: errorMessage
    };

    if (status === 'synced') {
      updates.last_synced_at = new Date().toISOString();
      updates.last_sync_error = null;
    }

    const { error } = await supabase
      .from('store_products')
      .update(updates)
      .eq('product_id', productId)
      .eq('store_id', storeId);

    if (error) throw error;
    return true;
  },

  async getSyncErrors(storeId) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('store_products')
      .select(`
        product_id,
        last_sync_error,
        sync_status,
        products (title, handle)
      `)
      .eq('store_id', storeId)
      .eq('sync_status', 'error')
      .limit(100);

    if (error) throw error;

    // Group by error message to get summary
    const errorSummary = {};
    for (const item of (data || [])) {
      const errMsg = item.last_sync_error || 'Okänt fel';
      if (!errorSummary[errMsg]) {
        errorSummary[errMsg] = { count: 0, examples: [] };
      }
      errorSummary[errMsg].count++;
      if (errorSummary[errMsg].examples.length < 3) {
        errorSummary[errMsg].examples.push({
          title: item.products?.title,
          handle: item.products?.handle
        });
      }
    }

    return {
      totalErrors: data?.length || 0,
      errors: Object.entries(errorSummary).map(([message, info]) => ({
        message,
        count: info.count,
        examples: info.examples
      }))
    };
  },

  async getProductSyncStatus(productId) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('store_products')
      .select(`
        *,
        stores (id, name, domain)
      `)
      .eq('product_id', productId);

    if (error) throw error;
    return data;
  },

  // ============================================
  // PRICE CAMPAIGNS
  // ============================================

  async getCampaigns(storeId) {
    if (!supabase) throw new Error('Supabase not configured');

    let query = supabase
      .from('price_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (storeId) query = query.eq('store_id', storeId);

    const { data, error } = await query;

    if (error) throw error;
    return data;
  },

  async createCampaign(campaign, productPrices) {
    if (!supabase) throw new Error('Supabase not configured');

    // Create campaign
    const { data: newCampaign, error: campaignError } = await supabase
      .from('price_campaigns')
      .insert({
        name: campaign.name,
        discount_percent: campaign.discountPercent,
        filters: campaign.filters,
        store_id: campaign.store_id || null,
        product_count: productPrices.length
      })
      .select()
      .single();

    if (campaignError) throw campaignError;

    // Save product prices for restore
    const priceRecords = productPrices.map(p => ({
      campaign_id: newCampaign.id,
      product_id: p.productId,
      original_price: p.originalPrice,
      original_compare_at_price: p.originalCompareAt,
      new_price: p.newPrice,
      variant_prices: p.variantPrices || []
    }));

    const { error: pricesError } = await supabase
      .from('price_campaign_products')
      .insert(priceRecords);

    if (pricesError) throw pricesError;

    return newCampaign;
  },

  async endCampaign(campaignId) {
    if (!supabase) throw new Error('Supabase not configured');

    // Get campaign products
    const { data: campaignProducts, error: fetchError } = await supabase
      .from('price_campaign_products')
      .select('*')
      .eq('campaign_id', campaignId);

    if (fetchError) throw fetchError;

    // Restore prices
    for (const cp of campaignProducts) {
      await supabase
        .from('products')
        .update({
          default_price: cp.original_price,
          default_compare_at_price: cp.original_compare_at_price
        })
        .eq('id', cp.product_id);
    }

    // Mark campaign as ended
    const { error: updateError } = await supabase
      .from('price_campaigns')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', campaignId);

    if (updateError) throw updateError;

    return true;
  },

  // ============================================
  // METAFIELD DEFINITIONS
  // ============================================

  async getMetafieldDefinitions() {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('metafield_definitions')
      .select('*')
      .order('sort_order');

    if (error) throw error;
    return data;
  },

  // ============================================
  // SYNC QUEUE
  // ============================================

  async addToSyncQueue(storeId, productId, action, payload = {}) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('sync_queue')
      .insert({
        store_id: storeId,
        product_id: productId,
        action,
        payload
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getPendingSyncJobs(limit = 10) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('sync_queue')
      .select(`
        *,
        stores (*),
        products (*)
      `)
      .eq('status', 'pending')
      .lt('attempts', 3)
      .order('priority')
      .order('scheduled_at')
      .limit(limit);

    if (error) throw error;
    return data;
  },

  async updateSyncJob(id, updates) {
    if (!supabase) throw new Error('Supabase not configured');

    const { error } = await supabase
      .from('sync_queue')
      .update(updates)
      .eq('id', id);

    if (error) throw error;
    return true;
  },

  // ============================================
  // SUPPLIER PROFILES
  // ============================================

  async getSupplierProfiles(storeId) {
    if (!supabase) throw new Error('Supabase not configured');

    let query = supabase
      .from('supplier_profiles')
      .select('*')
      .order('name');

    if (storeId) query = query.eq('store_id', storeId);

    const { data, error } = await query;

    if (error) throw error;
    return data;
  },

  async createSupplierProfile(profile) {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase
      .from('supplier_profiles')
      .insert(profile)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // ============================================
  // PRICING ENGINE
  // ============================================

  async getCategoryMarginRules(storeId) {
    if (!supabase) throw new Error('Supabase not configured');
    let query = supabase.from('category_margin_rules').select('*').order('category');
    if (storeId) query = query.eq('store_id', storeId);
    const { data, error } = await query;
    if (error) throw error;
    return data;
  },

  async upsertCategoryMarginRule({ store_id, category, margin_multiplier }) {
    if (!supabase) throw new Error('Supabase not configured');
    const { data, error } = await supabase
      .from('category_margin_rules')
      .upsert({ store_id, category, margin_multiplier }, { onConflict: 'store_id,category' })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async deleteCategoryMarginRule(id) {
    if (!supabase) throw new Error('Supabase not configured');
    const { error } = await supabase.from('category_margin_rules').delete().eq('id', id);
    if (error) throw error;
    return true;
  },

  async getPricingSettings(storeId) {
    if (!supabase) throw new Error('Supabase not configured');
    const { data, error } = await supabase
      .from('pricing_settings')
      .select('*')
      .eq('store_id', storeId)
      .maybeSingle();
    if (error) throw error;
    return data || { store_id: storeId, default_margin_multiplier: 2.0, default_vat_rate: 0.25 };
  },

  async upsertPricingSettings(settings) {
    if (!supabase) throw new Error('Supabase not configured');
    const { data, error } = await supabase
      .from('pricing_settings')
      .upsert(settings, { onConflict: 'store_id' })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  // Recompute and persist default_price for a single product based on
  // its cost, resolved margin (product/category/supplier/global), and store VAT.
  async recomputeProductPrice(productId, storeId) {
    if (!supabase) throw new Error('Supabase not configured');
    const { computePricing, resolveMargin } = await import('./services/pricing.js');

    const product = await this.getProductById(productId);
    if (!product) return null;
    const sId = storeId || product.store_id;

    const [categoryRules, settings, suppliers] = await Promise.all([
      this.getCategoryMarginRules(sId).catch(() => []),
      this.getPricingSettings(sId).catch(() => null),
      product.supplier_id ? this.getSupplierProfiles(sId).catch(() => []) : Promise.resolve([]),
    ]);
    const supplier = product.supplier_id ? suppliers.find(s => s.id === product.supplier_id) : null;

    const margin = resolveMargin({
      product,
      categoryRules,
      supplier,
      defaultMargin: settings?.default_margin_multiplier,
    });
    const pricing = computePricing({
      cost: product.default_cost,
      margin: margin.value,
      supplierFeePercent: supplier?.supplier_fee_percent ?? 0,
      vatRate: settings?.default_vat_rate,
    });

    if (pricing.salePriceInclVat > 0) {
      await supabase
        .from('products')
        .update({ default_price: pricing.salePriceInclVat })
        .eq('id', productId);
    }
    return { margin, pricing };
  },

  async recomputeProductPrices(productIds, storeId) {
    const results = [];
    for (const id of productIds) {
      try {
        const r = await this.recomputeProductPrice(id, storeId);
        results.push({ id, success: true, ...r });
      } catch (e) {
        results.push({ id, success: false, error: e.message });
      }
    }
    return results;
  },

  // Bulk-set margin_multiplier on selected products (null = clear override).
  async bulkSetProductMargin(productIds, marginMultiplier, storeId) {
    if (!supabase) throw new Error('Supabase not configured');
    if (!productIds?.length) return [];
    let query = supabase
      .from('products')
      .update({ margin_multiplier: marginMultiplier })
      .in('id', productIds);
    if (storeId) query = query.eq('store_id', storeId);
    const { data, error } = await query.select('id');
    if (error) throw error;
    return data;
  },

  // ============================================
  // ACTIVITY LOG
  // ============================================

  async logActivity(action, entityType, entityId, description, changes = null) {
    if (!supabase) return; // Silent fail for logging

    await supabase.from('activity_log').insert({
      action,
      entity_type: entityType,
      entity_id: entityId,
      description,
      changes,
      actor_type: 'system'
    });
  },

  // ============================================
  // CLEANUP / MAINTENANCE
  // ============================================

  async cleanupDuplicateProducts() {
    if (!supabase) throw new Error('Supabase not configured');

    // Hämta alla produkter med antal varianter och butikskopplingar
    const { data: allProducts, error } = await supabase
      .from('products')
      .select(`
        id,
        title,
        handle,
        created_at,
        variants (id),
        store_products (id, shopify_product_id)
      `);

    if (error) throw error;

    // Gruppera efter titel
    const groupedByTitle = {};
    for (const product of allProducts) {
      const title = product.title;
      if (!groupedByTitle[title]) {
        groupedByTitle[title] = [];
      }
      groupedByTitle[title].push({
        id: product.id,
        title: product.title,
        handle: product.handle,
        created_at: product.created_at,
        variantCount: product.variants?.length || 0,
        hasShopifyConnection: product.store_products?.some(sp => sp.shopify_product_id) || false
      });
    }

    // Hitta dubletter och bestäm vilka som ska tas bort
    const toDelete = [];
    const kept = [];

    for (const [title, products] of Object.entries(groupedByTitle)) {
      if (products.length <= 1) continue; // Ingen dubblett

      // Sortera: prioritera de med Shopify-koppling, sedan flest varianter, sedan nyast
      products.sort((a, b) => {
        if (a.hasShopifyConnection !== b.hasShopifyConnection) {
          return b.hasShopifyConnection ? 1 : -1;
        }
        if (a.variantCount !== b.variantCount) {
          return b.variantCount - a.variantCount;
        }
        return new Date(b.created_at) - new Date(a.created_at);
      });

      // Behåll den första (bästa), ta bort resten
      kept.push({ title, product: products[0] });
      for (let i = 1; i < products.length; i++) {
        toDelete.push(products[i]);
      }
    }

    // Ta bort dubletter
    const deleted = [];
    for (const product of toDelete) {
      try {
        // Ta bort varianter först
        await supabase.from('variants').delete().eq('product_id', product.id);
        // Ta bort bilder
        await supabase.from('images').delete().eq('product_id', product.id);
        // Ta bort store_products
        await supabase.from('store_products').delete().eq('product_id', product.id);
        // Ta bort produkten
        await supabase.from('products').delete().eq('id', product.id);

        deleted.push({
          id: product.id,
          title: product.title,
          variantCount: product.variantCount,
          hadShopifyConnection: product.hasShopifyConnection
        });
      } catch (err) {
        console.error(`Failed to delete product ${product.id}:`, err.message);
      }
    }

    return {
      duplicateGroupsFound: Object.keys(groupedByTitle).filter(t => groupedByTitle[t].length > 1).length,
      productsDeleted: deleted.length,
      deletedProducts: deleted,
      keptProducts: kept.map(k => ({
        title: k.title,
        id: k.product.id,
        variantCount: k.product.variantCount,
        hasShopifyConnection: k.product.hasShopifyConnection
      }))
    };
  }
};

export default db;
