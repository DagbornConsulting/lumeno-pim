import { db, supabase } from './db.js';

// ============================================
// SHOPIFY API CLIENT
// ============================================

class ShopifyClient {
  constructor(store) {
    this.store = store;
    this.baseUrl = `https://${store.domain}/admin/api/${store.api_version || '2026-01'}`;
    this.accessToken = store.access_token;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.accessToken,
        ...options.headers
      }
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Shopify API error: ${response.status} - ${JSON.stringify(error)}`);
    }

    return response.json();
  }

  // GraphQL API (recommended for complex operations)
  async graphql(query, variables = {}) {
    const response = await fetch(`https://${this.store.domain}/admin/api/${this.store.api_version || '2026-01'}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.accessToken
      },
      body: JSON.stringify({ query, variables })
    });

    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
    }

    return data.data;
  }
}

// ============================================
// SHOPIFY SYNC SERVICE
// ============================================

export const shopifySync = {
  
  // Get client for a store
  getClient(store) {
    if (!store.access_token) {
      throw new Error(`Store ${store.name} has no access token configured`);
    }
    return new ShopifyClient(store);
  },

  // ============================================
  // METAFIELD DEFINITIONS
  // ============================================

  // Sync metafield definitions to a store
  async syncMetafieldDefinitions(store) {
    const client = this.getClient(store);
    const pimDefinitions = await db.getMetafieldDefinitions();
    
    const results = [];
    
    for (const def of pimDefinitions) {
      try {
        // Create or update metafield definition in Shopify
        const mutation = `
          mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
            metafieldDefinitionCreate(definition: $definition) {
              createdDefinition {
                id
                name
                namespace
                key
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const variables = {
          definition: {
            name: def.name,
            namespace: def.namespace,
            key: def.key,
            type: this.mapFieldType(def.field_type),
            ownerType: 'PRODUCT',
            description: def.description
          }
        };

        const result = await client.graphql(mutation, variables);
        
        if (result.metafieldDefinitionCreate.userErrors.length > 0) {
          // Definition might already exist
          results.push({ 
            definition: def.name, 
            status: 'exists',
            errors: result.metafieldDefinitionCreate.userErrors 
          });
        } else {
          results.push({ 
            definition: def.name, 
            status: 'created',
            shopifyId: result.metafieldDefinitionCreate.createdDefinition?.id
          });
        }
      } catch (error) {
        results.push({ 
          definition: def.name, 
          status: 'error', 
          error: error.message 
        });
      }
    }

    return results;
  },

  // Get existing metafield definitions from Shopify
  async getShopifyMetafieldDefinitions(store) {
    const client = this.getClient(store);
    
    const query = `
      query {
        metafieldDefinitions(first: 100, ownerType: PRODUCT) {
          edges {
            node {
              id
              name
              namespace
              key
              type {
                name
              }
              description
            }
          }
        }
      }
    `;

    const result = await client.graphql(query);
    return result.metafieldDefinitions.edges.map(e => e.node);
  },

  // Map PIM field types to Shopify types
  mapFieldType(pimType) {
    const mapping = {
      'single_line_text': 'single_line_text_field',
      'multi_line_text': 'multi_line_text_field',
      'rich_text': 'rich_text_field',
      'color': 'color',
      'metaobject_reference': 'metaobject_reference',
      'number': 'number_integer',
      'boolean': 'boolean',
      'url': 'url',
      'date': 'date',
      'json': 'json'
    };
    return mapping[pimType] || 'single_line_text_field';
  },

  // ============================================
  // PRODUCT SYNC
  // ============================================

  // Find existing product in Shopify by SKU or handle to prevent duplicates
  async findExistingProduct(store, product) {
    const client = this.getClient(store);

    // Collect all SKUs and barcodes from product (main + variants)
    const skus = [];
    const barcodes = [];

    if (product.sku) skus.push(product.sku);
    if (product.barcode) barcodes.push(product.barcode);

    if (product.variants?.length) {
      for (const v of product.variants) {
        if (v.sku) skus.push(v.sku);
        if (v.barcode) barcodes.push(v.barcode);
      }
    }

    const searchQuery = `
      query findProduct($query: String!) {
        products(first: 1, query: $query) {
          edges {
            node {
              id
              legacyResourceId
              handle
              title
            }
          }
        }
      }
    `;

    // 1. Try to find by SKU first
    if (skus.length > 0) {
      const firstSku = skus[0];
      try {
        const result = await client.graphql(searchQuery, { query: `sku:${firstSku}` });
        if (result.data?.products?.edges?.length > 0) {
          const found = result.data.products.edges[0].node;
          console.log(`Found existing product by SKU "${firstSku}": ${found.legacyResourceId} (${found.title})`);
          return {
            shopifyProductId: found.legacyResourceId,
            shopifyProductGid: found.id,
            matchedBy: 'sku',
            matchedValue: firstSku
          };
        }
      } catch (err) {
        console.warn('SKU search failed:', err.message);
      }
    }

    // 2. Try to find by barcode/EAN
    if (barcodes.length > 0) {
      const firstBarcode = barcodes[0];
      try {
        const result = await client.graphql(searchQuery, { query: `barcode:${firstBarcode}` });
        if (result.data?.products?.edges?.length > 0) {
          const found = result.data.products.edges[0].node;
          console.log(`Found existing product by barcode "${firstBarcode}": ${found.legacyResourceId} (${found.title})`);
          return {
            shopifyProductId: found.legacyResourceId,
            shopifyProductGid: found.id,
            matchedBy: 'barcode',
            matchedValue: firstBarcode
          };
        }
      } catch (err) {
        console.warn('Barcode search failed:', err.message);
      }
    }

    // 3. Fallback: try to find by handle
    if (product.handle) {
      const query = `
        query findProductByHandle($handle: String!) {
          productByHandle(handle: $handle) {
            id
            legacyResourceId
            title
          }
        }
      `;

      try {
        const result = await client.graphql(query, { handle: product.handle });
        if (result.data?.productByHandle) {
          const found = result.data.productByHandle;
          console.log(`Found existing product by handle "${product.handle}": ${found.legacyResourceId} (${found.title})`);
          return {
            shopifyProductId: found.legacyResourceId,
            shopifyProductGid: found.id,
            matchedBy: 'handle',
            matchedValue: product.handle
          };
        }
      } catch (err) {
        console.warn('Handle search failed:', err.message);
      }
    }

    return null; // No existing product found
  },

  // Create product in Shopify (with duplicate check)
  async createProduct(store, product) {
    const client = this.getClient(store);

    // Ensure metafield type cache is loaded and definitions exist in Shopify
    await this.loadMetafieldTypes(store);
    await this.syncMetafieldDefinitions(store).catch(e => console.warn('Metafield def sync failed:', e.message));

    // DUPLICATE CHECK: Search for existing product by SKU or handle before creating
    console.log('=== Checking for existing product in Shopify ===');
    const existingProduct = await this.findExistingProduct(store, product);

    if (existingProduct) {
      console.log(`Found existing product (matched by ${existingProduct.matchedBy}: "${existingProduct.matchedValue}"), updating instead of creating`);

      // Update store_products with the found Shopify ID first
      await supabase
        .from('store_products')
        .update({
          shopify_product_id: existingProduct.shopifyProductId,
          shopify_product_gid: existingProduct.shopifyProductGid
        })
        .eq('store_id', store.id)
        .eq('product_id', product.id);

      // Now update the existing product instead of creating
      return await this.updateProduct(store, product, existingProduct.shopifyProductId);
    }

    const shopifyProduct = this.transformProductToShopify(product);

    // Keep metafields if they exist - they will sync to Shopify if metafield definitions exist
    // If a metafield namespace/key is not defined in Shopify, it will be ignored (not cause error)
    console.log('Metafields to sync:', shopifyProduct.metafields?.length || 0);

    console.log('=== Creating NEW product in Shopify ===');
    console.log('Store:', store.domain);
    console.log('Images from product:', product.images?.length || 0);
    console.log('Images in shopifyProduct:', shopifyProduct.images?.length || 0);
    if (shopifyProduct.images?.length) {
      console.log('First image URL:', shopifyProduct.images[0].src);
    }

    let result;
    try {
      result = await client.request('/products.json', {
        method: 'POST',
        body: JSON.stringify({ product: shopifyProduct })
      });
    } catch (err) {
      // If metafields caused the error, retry without them
      if (err.message?.includes('422') && shopifyProduct.metafields?.length) {
        console.warn(`Metafield error on ${store.domain}, retrying without metafields...`);
        const failedMetafields = shopifyProduct.metafields.map(m => `${m.namespace}.${m.key}`);
        console.warn('Skipped metafields:', failedMetafields.join(', '));
        delete shopifyProduct.metafields;
        result = await client.request('/products.json', {
          method: 'POST',
          body: JSON.stringify({ product: shopifyProduct })
        });
      } else {
        throw err;
      }
    }

    console.log('Product created with ID:', result.product.id);

    // Set cost for each variant via InventoryItem API (cost is not supported in product API)
    if (result.product.variants?.length) {
      for (let i = 0; i < result.product.variants.length; i++) {
        const shopifyVariant = result.product.variants[i];
        const pimVariant = product.variants?.[i];
        const cost = pimVariant?.cost ?? product.default_cost;
        
        if (cost && shopifyVariant.inventory_item_id) {
          try {
            console.log(`Setting cost ${cost} for variant ${shopifyVariant.id}, inventory_item ${shopifyVariant.inventory_item_id}`);
            await client.request(`/inventory_items/${shopifyVariant.inventory_item_id}.json`, {
              method: 'PUT',
              body: JSON.stringify({
                inventory_item: {
                  cost: String(cost)
                }
              })
            });
          } catch (costError) {
            console.error('Failed to set cost:', costError.message);
            // Don't fail the whole sync for cost error
          }
        }
      }
    }

    // Update store_products with Shopify ID
    await supabase
      .from('store_products')
      .update({
        shopify_product_id: result.product.id,
        shopify_product_gid: `gid://shopify/Product/${result.product.id}`,
        sync_status: 'synced',
        last_synced_at: new Date().toISOString()
      })
      .eq('store_id', store.id)
      .eq('product_id', product.id);

    // Log activity
    await db.logActivity(
      'product.synced',
      'product',
      product.id,
      `Product synced to ${store.name}`,
      { shopify_id: result.product.id }
    );

    return result.product;
  },

  // Update product in Shopify
  async updateProduct(store, product, shopifyProductId) {
    const client = this.getClient(store);

    // Ensure metafield type cache is loaded and definitions exist in Shopify
    await this.loadMetafieldTypes(store);
    await this.syncMetafieldDefinitions(store).catch(e => console.warn('Metafield def sync failed:', e.message));

    const shopifyProduct = this.transformProductToShopify(product);

    // Keep metafields - they will sync to Shopify if metafield definitions exist
    console.log('Metafields to sync:', shopifyProduct.metafields?.length || 0);

    console.log('=== Updating product in Shopify ===');
    console.log('Store:', store.domain);
    console.log('Shopify Product ID:', shopifyProductId);

    // Handle images for update:
    // - Images with shopify_image_id: reference by ID (no re-download needed)
    // - Images without shopify_image_id: send src for Shopify to download (new images)
    // - If ALL images have shopify_image_id and nothing changed: skip images entirely
    if (shopifyProduct.images?.length) {
      const allHaveShopifyId = shopifyProduct.images.every(img => img.shopify_image_id);

      if (allHaveShopifyId) {
        // All images already exist in Shopify - don't send images to avoid re-download issues
        delete shopifyProduct.images;
        console.log('Images: skipped (all already in Shopify)');
      } else {
        // Mix of existing and new images
        shopifyProduct.images = shopifyProduct.images.map(img => {
          if (img.shopify_image_id) {
            // Existing image - reference by ID
            return { id: img.shopify_image_id, alt: img.alt, position: img.position };
          }
          // New image - send src
          return { src: img.src, alt: img.alt, position: img.position };
        });
        console.log(`Images: ${shopifyProduct.images.length} (mix of existing and new)`);
      }
    }

    let result;
    try {
      result = await client.request(`/products/${shopifyProductId}.json`, {
        method: 'PUT',
        body: JSON.stringify({ product: shopifyProduct })
      });
    } catch (err) {
      // If metafields caused the error, retry without them
      if (err.message?.includes('422') && shopifyProduct.metafields?.length) {
        console.warn(`Metafield error on ${store.domain}, retrying without metafields...`);
        const failedMetafields = shopifyProduct.metafields.map(m => `${m.namespace}.${m.key}`);
        console.warn('Skipped metafields:', failedMetafields.join(', '));
        delete shopifyProduct.metafields;
        result = await client.request(`/products/${shopifyProductId}.json`, {
          method: 'PUT',
          body: JSON.stringify({ product: shopifyProduct })
        });
      } else {
        throw err;
      }
    }

    // Set cost for each variant via InventoryItem API
    if (result.product.variants?.length) {
      for (let i = 0; i < result.product.variants.length; i++) {
        const shopifyVariant = result.product.variants[i];
        const pimVariant = product.variants?.[i];
        const cost = pimVariant?.cost ?? product.default_cost;
        
        if (cost && shopifyVariant.inventory_item_id) {
          try {
            console.log(`Setting cost ${cost} for variant ${shopifyVariant.id}`);
            await client.request(`/inventory_items/${shopifyVariant.inventory_item_id}.json`, {
              method: 'PUT',
              body: JSON.stringify({
                inventory_item: {
                  cost: String(cost)
                }
              })
            });
          } catch (costError) {
            console.error('Failed to set cost:', costError.message);
          }
        }
      }
    }

    // Update sync status
    await supabase
      .from('store_products')
      .update({
        sync_status: 'synced',
        last_synced_at: new Date().toISOString(),
        last_sync_error: null
      })
      .eq('store_id', store.id)
      .eq('product_id', product.id);

    return result.product;
  },

  // Delete product from Shopify
  async deleteProduct(store, shopifyProductId) {
    const client = this.getClient(store);
    
    await client.request(`/products/${shopifyProductId}.json`, {
      method: 'DELETE'
    });

    return true;
  },

  // Transform PIM product to Shopify format
  transformProductToShopify(product) {
    console.log('=== Transforming product to Shopify ===');
    console.log('Product ID:', product.id);
    console.log('Title:', product.title);
    console.log('Default price:', product.default_price);
    console.log('Default cost:', product.default_cost);
    console.log('Variants count:', product.variants?.length || 0);
    
    const shopifyProduct = {
      title: product.title,
      body_html: product.description || '',
      vendor: product.vendor || '',
      product_type: product.product_type || '',
      tags: product.tags?.join(', ') || '',
      status: product.status === 'active' ? 'active' : 'draft',
      published: product.published_on_online_store !== false
    };

    // SEO - handled via metafields array (global.title_tag / global.description_tag)
    // Do NOT use legacy metafields_global_* properties - they conflict with the metafields array
    // and cause "must be unique within this namespace" errors

    // Variants - if product has variants, use them; otherwise create default variant
    if (product.variants?.length) {
      // Only declare an option on the product when at least one variant has a value for it.
      // Shopify rejects products that declare options with no corresponding variant values.
      const firstVariant = product.variants[0];
      const opt1Used = firstVariant.option1_name && product.variants.some(v => v.option1_value);
      const opt2Used = firstVariant.option2_name && product.variants.some(v => v.option2_value);
      const opt3Used = firstVariant.option3_name && product.variants.some(v => v.option3_value);

      shopifyProduct.variants = product.variants.map((v, idx) => {
        const price = v.price ?? product.default_price ?? 0;
        const compareAtPrice = v.compare_at_price ?? product.default_compare_at_price;

        console.log(`Variant ${idx}: SKU=${v.sku}, price=${price}, compare_at=${compareAtPrice}`);

        const variantObj = {
          sku: v.sku || '',
          barcode: v.barcode || '',
          price: String(price),
          compare_at_price: compareAtPrice ? String(compareAtPrice) : null,
          // NOTE: cost is NOT supported in product API - must use InventoryItem API
          weight: v.weight || product.weight || 0,
          weight_unit: v.weight_unit || product.weight_unit || 'kg',
          inventory_management: 'shopify',
          inventory_policy: v.inventory_policy || product.inventory_policy || 'deny',
          requires_shipping: product.requires_shipping !== false,
          taxable: product.charge_tax !== false,
          // Fall back to "Default Title" when no real option is in use, so single-variant
          // products without options still satisfy Shopify's variant-must-have-option1 rule
          option1: opt1Used ? (v.option1_value || null) : (idx === 0 ? 'Default Title' : null),
          option2: opt2Used ? (v.option2_value || null) : null,
          option3: opt3Used ? (v.option3_value || null) : null
        };
        // Include Shopify variant ID for updates - required for price changes
        if (v.shopify_variant_id) {
          variantObj.id = v.shopify_variant_id;
        }
        return variantObj;
      });

      shopifyProduct.options = [];
      if (opt1Used) shopifyProduct.options.push({ name: firstVariant.option1_name });
      if (opt2Used) shopifyProduct.options.push({ name: firstVariant.option2_name });
      if (opt3Used) shopifyProduct.options.push({ name: firstVariant.option3_name });
    } else {
      // No variants - create default variant with product-level data
      const price = product.default_price ?? 0;
      const compareAtPrice = product.default_compare_at_price;
      
      console.log(`Default variant: SKU=${product.sku}, price=${price}, compare_at=${compareAtPrice}`);
      
      shopifyProduct.variants = [{
        sku: product.sku || '',
        barcode: product.barcode || '',
        price: String(price),
        compare_at_price: compareAtPrice ? String(compareAtPrice) : null,
        weight: product.weight || 0,
        weight_unit: product.weight_unit || 'kg',
        inventory_management: 'shopify',
        inventory_policy: product.inventory_policy || 'deny',
        requires_shipping: product.requires_shipping !== false,
        taxable: product.charge_tax !== false,
        option1: 'Default Title'
      }];
    }

    // Images - include shopify_image_id when available so updates can reference by ID
    if (product.images?.length) {
      shopifyProduct.images = product.images.map((img, idx) => {
        const defaultAlt = idx === 0 ? product.title : `${product.title} - bild ${idx + 1}`;
        const imageObj = {
          src: img.url,
          alt: img.alt_text || img.alt || defaultAlt,
          position: img.position
        };
        if (img.shopify_image_id) {
          imageObj.shopify_image_id = img.shopify_image_id;
        }
        return imageObj;
      });
    }

    // Metafields - merge product-level fields into metafields
    const metafields = { ...(product.metafields || {}) };
    if (product.seo_title && !metafields['global.title_tag']) {
      metafields['global.title_tag'] = product.seo_title;
    }
    if (product.seo_description && !metafields['global.description_tag']) {
      metafields['global.description_tag'] = product.seo_description;
    }
    // AI content fields stored as top-level DB columns → push as metafields
    if (product.short_description && !metafields['custom.short_description']) {
      metafields['custom.short_description'] = product.short_description;
    }
    if (product.agent_summary && !metafields['custom.agent_summary']) {
      metafields['custom.agent_summary'] = product.agent_summary;
    }
    if (product.use_cases && !metafields['custom.use_cases']) {
      metafields['custom.use_cases'] = product.use_cases;
    }
    if (product.specifications?.length && !metafields['custom.specifications']) {
      metafields['custom.specifications'] = product.specifications;
    }
    if (product.faq?.length && !metafields['custom.faq']) {
      metafields['custom.faq'] = product.faq;
    }

    if (Object.keys(metafields).length) {
      shopifyProduct.metafields = this.transformMetafields(metafields);
    }

    console.log('Final Shopify product:', JSON.stringify(shopifyProduct, null, 2));
    return shopifyProduct;
  },

  // Cache for metafield definitions fetched from Shopify
  _metafieldTypeCache: null,
  _metafieldTypeCacheTime: 0,

  // Get metafield type, checking cache of Shopify definitions first, then static fallback
  getMetafieldType(fullKey) {
    // Check dynamic cache first
    if (this._metafieldTypeCache?.has(fullKey)) {
      return this._metafieldTypeCache.get(fullKey);
    }
    // Static fallback for known types
    return this._staticMetafieldTypes[fullKey] || null;
  },

  // Static fallback types
  _staticMetafieldTypes: {
    // AI content
    'custom.short_description': 'single_line_text_field',
    'custom.agent_summary': 'multi_line_text_field',
    'custom.use_cases': 'multi_line_text_field',
    'custom.specifications': 'json',
    'custom.faq': 'json',
    // Custom namespace
    'custom.kort_produktbeskrivning': 'multi_line_text_field',
    'custom.skaft_info': 'rich_text_field',
    'custom.varumarke': 'metaobject_reference',
    'custom.golfklader': 'single_line_text_field',
    'custom.release_date': 'date',
    'custom.finns_i_lager': 'single_line_text_field',
    'custom.par_date': 'multi_line_text_field',
    'custom.produkt_video_1': 'url',
    'custom.produkt_video_2': 'url',
    'custom.butik_saljare_av_produkt': 'single_line_text_field',
    // Filters
    'filters.kategori': 'single_line_text_field',
    'filters.sortering': 'single_line_text_field',
    'filter.skick_demoklubbor': 'single_line_text_field',
    'filter.artikeltyp': 'single_line_text_field',
    'filter.fattning': 'single_line_text_field',
    'filter.loft': 'single_line_text_field',
    'filter.antal_klubbor': 'single_line_text_field',
    'filter.skaft': 'single_line_text_field',
    // Theme
    'theme.label': 'single_line_text_field',
    'theme.label_color': 'color',
    // Global SEO
    'global.title_tag': 'single_line_text_field',
    'global.description_tag': 'multi_line_text_field',
  },

  // Load metafield definitions from Shopify and cache them
  async loadMetafieldTypes(store) {
    const now = Date.now();
    // Cache for 10 minutes
    if (this._metafieldTypeCache && (now - this._metafieldTypeCacheTime) < 600000) return;
    try {
      const defs = await this.getShopifyMetafieldDefinitions(store);
      const cache = new Map();
      for (const def of defs) {
        cache.set(`${def.namespace}.${def.key}`, def.type?.name || def.type);
      }
      this._metafieldTypeCache = cache;
      this._metafieldTypeCacheTime = now;
      console.log(`Cached ${cache.size} metafield type definitions from Shopify`);
    } catch (err) {
      console.warn('Could not load metafield definitions:', err.message);
    }
  },

  // Transform PIM metafields to Shopify format
  transformMetafields(metafields) {
    // Use Map to deduplicate by namespace+key (prevents "must be unique" error)
    const metafieldMap = new Map();

    // Metafields som är interna och inte ska synkas till Shopify
    const internalMetafields = ['custom.source_material'];

    for (const [key, value] of Object.entries(metafields)) {
      if (value === null || value === undefined || value === '') continue;

      // Hoppa över interna metafält
      if (internalMetafields.includes(key)) continue;

      // Key format: "namespace.key" -> {namespace, key}
      const [namespace, metaKey] = key.includes('.')
        ? key.split('.')
        : ['custom', key];

      // Get the correct type - check cached Shopify defs, then static, then infer
      const fullKey = `${namespace}.${metaKey}`;
      let metafieldType = this.getMetafieldType(fullKey);

      if (!metafieldType) {
        // Infer type from value for unknown metafields
        metafieldType = this.inferMetafieldType(value);
        console.log(`Unknown metafield type for '${fullKey}', defaulting to: ${metafieldType}`);
      }

      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

      // If type is single_line_text_field but value contains newlines, use multi_line
      if (metafieldType === 'single_line_text_field' && stringValue.includes('\n')) {
        metafieldType = 'multi_line_text_field';
      }

      const metafield = {
        namespace,
        key: metaKey,
        value: stringValue,
        type: metafieldType
      };

      // Deduplicate: last value wins for same namespace+key
      metafieldMap.set(fullKey, metafield);
    }

    return Array.from(metafieldMap.values());
  },

  // Infer Shopify metafield type from value
  inferMetafieldType(value) {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'number_integer' : 'number_decimal';
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return 'json';
    if (typeof value === 'string') {
      if (value.startsWith('gid://shopify/Metaobject/')) return 'metaobject_reference';
      if (value.startsWith('#') && value.length === 7) return 'color';
      if (value.startsWith('http')) return 'url';
      if (value.includes('\n')) return 'multi_line_text_field';
    }
    return 'single_line_text_field';
  },

  // ============================================
  // BULK SYNC
  // ============================================

  // Sync all pending products to a store
  async syncPendingProducts(store, limit = 10) {
    const { data: pendingProducts } = await supabase
      .from('store_products')
      .select(`
        *,
        products (
          *,
          variants (*),
          images (*)
        )
      `)
      .eq('store_id', store.id)
      .eq('sync_status', 'pending')
      .eq('is_published', true)
      .limit(limit);

    const results = [];

    for (const sp of pendingProducts || []) {
      try {
        // Mark as syncing
        await supabase
          .from('store_products')
          .update({ sync_status: 'syncing' })
          .eq('id', sp.id);

        if (sp.shopify_product_id) {
          // Update existing
          await this.updateProduct(store, sp.products, sp.shopify_product_id);
        } else {
          // Create new
          await this.createProduct(store, sp.products);
        }

        results.push({ productId: sp.product_id, status: 'success' });
      } catch (error) {
        // Mark as error
        await supabase
          .from('store_products')
          .update({
            sync_status: 'error',
            last_sync_error: error.message
          })
          .eq('id', sp.id);

        results.push({ productId: sp.product_id, status: 'error', error: error.message });
      }
    }

    return results;
  },

  // ============================================
  // STORE CONNECTION
  // ============================================

  // Test store connection
  async testConnection(store) {
    try {
      const client = this.getClient(store);
      const result = await client.request('/shop.json');
      
      return {
        success: true,
        shop: {
          name: result.shop.name,
          email: result.shop.email,
          domain: result.shop.domain,
          currency: result.shop.currency,
          country: result.shop.country_name
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  },

  // Get store info
  async getShopInfo(store) {
    const client = this.getClient(store);
    const result = await client.request('/shop.json');
    return result.shop;
  },

  // Get product count in Shopify
  async getProductCount(store) {
    const client = this.getClient(store);
    const result = await client.request('/products/count.json');
    return result.count;
  },

  // ============================================
  // INVENTORY
  // ============================================

  // Update inventory level
  async updateInventory(store, inventoryItemId, locationId, quantity) {
    const client = this.getClient(store);
    
    const result = await client.request('/inventory_levels/set.json', {
      method: 'POST',
      body: JSON.stringify({
        location_id: locationId,
        inventory_item_id: inventoryItemId,
        available: quantity
      })
    });

    return result.inventory_level;
  },

  // Get inventory locations
  async getLocations(store) {
    const client = this.getClient(store);
    const result = await client.request('/locations.json');
    return result.locations;
  },

  // Get per-location inventory levels for a product
  async getProductInventoryLevels(store, shopifyProductGid) {
    const client = this.getClient(store);

    const gid = shopifyProductGid.startsWith('gid://')
      ? shopifyProductGid
      : `gid://shopify/Product/${shopifyProductGid}`;

    const query = `
      query getInventory($id: ID!) {
        product(id: $id) {
          title
          variants(first: 100) {
            edges {
              node {
                id
                sku
                barcode
                displayName
                inventoryItem {
                  id
                  inventoryLevels(first: 20) {
                    edges {
                      node {
                        location {
                          id
                          name
                        }
                        quantities(names: "available") {
                          quantity
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await client.graphql(query, { id: gid });
    if (!data.product) return null;

    const variants = data.product.variants.edges.map(edge => {
      const v = edge.node;
      const levels = v.inventoryItem?.inventoryLevels?.edges?.map(le => ({
        locationId: le.node.location.id,
        locationName: le.node.location.name,
        available: le.node.quantities?.[0]?.quantity ?? 0
      })) || [];

      return {
        variantId: v.id,
        sku: v.sku,
        barcode: v.barcode,
        displayName: v.displayName,
        inventoryLevels: levels,
        totalAvailable: levels.reduce((sum, l) => sum + l.available, 0)
      };
    });

    // Aggregera per-location totaler
    const locationTotals = {};
    for (const variant of variants) {
      for (const level of variant.inventoryLevels) {
        if (!locationTotals[level.locationId]) {
          locationTotals[level.locationId] = { name: level.locationName, total: 0 };
        }
        locationTotals[level.locationId].total += level.available;
      }
    }

    return {
      productTitle: data.product.title,
      variants,
      locationTotals: Object.entries(locationTotals).map(([id, info]) => ({
        locationId: id,
        locationName: info.name,
        totalAvailable: info.total
      })),
      grandTotal: variants.reduce((sum, v) => sum + v.totalAvailable, 0)
    };
  },

  // Get inventory levels for a list of inventory_item_ids (REST, batched 50 at a time)
  async getInventoryLevelsByItemIds(store, inventoryItemIds) {
    const client = this.getClient(store);
    const results = {};

    // REST API allows max 50 inventory_item_ids per call
    const batchSize = 50;
    for (let i = 0; i < inventoryItemIds.length; i += batchSize) {
      const batch = inventoryItemIds.slice(i, i + batchSize);
      const data = await client.request(
        `/inventory_levels.json?inventory_item_ids=${batch.join(',')}&limit=250`
      );
      for (const level of (data.inventory_levels || [])) {
        const key = String(level.inventory_item_id);
        if (!results[key]) results[key] = [];
        results[key].push({
          locationId: level.location_id,
          available: level.available
        });
      }
    }

    return results; // { [inventory_item_id]: [{ locationId, available }] }
  },

  // Get the primary location id for a store
  async getPrimaryLocationId(store) {
    const locations = await this.getLocations(store);
    return locations?.[0]?.id ?? null;
  },

  // Get the primary location as a GraphQL GID (needed by inventorySetQuantities).
  async getPrimaryLocationGid(store) {
    const id = await this.getPrimaryLocationId(store);
    if (id == null) return null;
    const num = String(id).replace(/[^0-9]/g, '');
    return num ? `gid://shopify/Location/${num}` : null;
  },

  // Fetch a product's metafield VALUES from Shopify as a PIM JSONB map
  // ({ "namespace.key": value }). JSON/list-typed values are parsed to objects.
  async getProductMetafields(store, shopifyProductId) {
    const client = this.getClient(store);
    const numId = String(shopifyProductId).replace(/\D/g, '');
    const data = await client.request(`/products/${numId}/metafields.json?limit=250`);
    const map = {};
    for (const m of (data.metafields || [])) {
      const full = `${m.namespace}.${m.key}`;
      let value = m.value;
      if (m.type && (m.type === 'json' || m.type.startsWith('list.'))) {
        try { value = JSON.parse(m.value); } catch { /* keep raw string */ }
      }
      map[full] = value;
    }
    return map;
  },

  // Build a live SKU -> variants map straight from Shopify, independent of local
  // sync state. Returns each variant's inventoryItem GID, current qty and tracked
  // flag, plus the list of SKUs that map to more than one variant (ambiguous).
  async fetchInventoryMapFromShopify(store) {
    const client = this.getClient(store);
    const map = new Map();
    let cursor = null;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    while (true) {
      let d;
      for (let attempt = 0; ; attempt++) {
        try {
          d = await client.graphql(
            `query($c: String) {
              products(first: 100, after: $c) {
                nodes {
                  title status
                  variants(first: 100) {
                    nodes { sku inventoryQuantity inventoryItem { id tracked } }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            { c: cursor }
          );
          break;
        } catch (e) {
          // Back off and retry on Shopify GraphQL throttling.
          if (attempt < 5 && /THROTTLED|throttl/i.test(String(e.message))) {
            await sleep(2000);
            continue;
          }
          throw e;
        }
      }

      for (const p of d.products.nodes) {
        for (const v of p.variants.nodes) {
          const sku = (v.sku || '').trim();
          if (!sku) continue;
          if (!map.has(sku)) map.set(sku, []);
          map.get(sku).push({
            inventoryItemId: v.inventoryItem.id, // GID
            productTitle: p.title,
            productStatus: p.status,
            currentQty: v.inventoryQuantity ?? 0,
            tracked: v.inventoryItem.tracked,
          });
        }
      }

      if (!d.products.pageInfo.hasNextPage) break;
      cursor = d.products.pageInfo.endCursor;
    }

    const duplicateSkus = [...map.entries()].filter(([, l]) => l.length > 1).map(([s]) => s);
    return { map, duplicateSkus };
  },

  // Set exact available quantities for a batch of inventory items at one location.
  // changes: [{ inventoryItemId (GID), quantity }]. Max ~250 per call; caller batches.
  async setInventoryQuantitiesBatch(store, changes, locationGid) {
    if (!changes.length) return null;
    const client = this.getClient(store);
    const data = await client.graphql(
      `mutation($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup { createdAt }
          userErrors { field message code }
        }
      }`,
      {
        input: {
          name: 'available',
          reason: 'correction',
          ignoreCompareQuantity: true,
          quantities: changes.map(c => ({
            inventoryItemId: c.inventoryItemId,
            locationId: locationGid,
            quantity: c.quantity,
          })),
        },
      }
    );
    const errs = data.inventorySetQuantities?.userErrors || [];
    if (errs.length) throw new Error(JSON.stringify(errs));
    return data.inventorySetQuantities?.inventoryAdjustmentGroup ?? null;
  },
};

// ============================================
// SYNC WORKER (Background job processor)
// ============================================

export class SyncWorker {
  constructor() {
    this.isRunning = false;
    this.interval = null;
  }

  async start(intervalMs = 10000) {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log('🔄 Sync worker started');
    
    this.interval = setInterval(() => this.processQueue(), intervalMs);
    
    // Run immediately
    await this.processQueue();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    console.log('⏹️  Sync worker stopped');
  }

  async processQueue() {
    try {
      const jobs = await db.getPendingSyncJobs(5);
      
      for (const job of jobs) {
        await this.processJob(job);
      }
    } catch (error) {
      console.error('Sync worker error:', error);
    }
  }

  async processJob(job) {
    console.log(`Processing sync job ${job.id}: ${job.action}`);
    
    // Mark as processing
    await db.updateSyncJob(job.id, {
      status: 'processing',
      started_at: new Date().toISOString(),
      attempts: job.attempts + 1
    });

    try {
      const store = job.stores;
      const product = job.products;

      switch (job.action) {
        case 'create':
          await shopifySync.createProduct(store, product);
          break;
        case 'update':
          const storeProduct = await supabase
            .from('store_products')
            .select('shopify_product_id')
            .eq('store_id', store.id)
            .eq('product_id', product.id)
            .single();
          
          if (storeProduct.data?.shopify_product_id) {
            await shopifySync.updateProduct(store, product, storeProduct.data.shopify_product_id);
          } else {
            await shopifySync.createProduct(store, product);
          }
          break;
        case 'delete':
          // Handle delete
          break;
      }

      // Mark as completed
      await db.updateSyncJob(job.id, {
        status: 'completed',
        completed_at: new Date().toISOString()
      });

    } catch (error) {
      console.error(`Sync job ${job.id} failed:`, error);
      
      const shouldRetry = job.attempts < job.max_attempts;
      
      await db.updateSyncJob(job.id, {
        status: shouldRetry ? 'pending' : 'failed',
        error_message: error.message,
        scheduled_at: shouldRetry 
          ? new Date(Date.now() + Math.pow(2, job.attempts) * 60000).toISOString() // Exponential backoff
          : undefined
      });
    }
  }
}

export default shopifySync;
