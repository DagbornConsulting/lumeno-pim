import { supabase } from './db.js';
import crypto from 'crypto';

// ============================================
// PRODUCT FEED GENERATOR
// Google Merchant Center XML / CSV / TSV
// ============================================

// Escape XML special characters
function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Strip HTML tags for feed description
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Escape CSV field (wrap in quotes if contains comma, quote, or newline)
function escapeCsv(str) {
  if (!str && str !== 0) return '';
  const s = String(str);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Get the Google Shopping value from either separate column or JSONB
function getGoogleField(product, field) {
  // First try separate column (google_gender, google_age_group, etc.)
  const columnName = `google_${field}`;
  if (product[columnName]) return product[columnName];

  // Then try google_shopping JSONB
  const gs = product.google_shopping;
  if (gs && typeof gs === 'object') {
    // Try both camelCase and snake_case
    const camelKey = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (gs[camelKey]) return gs[camelKey];
    if (gs[field]) return gs[field];
  }

  return null;
}

// Build product link from store domain and handle
function buildProductLink(store, product) {
  const domain = store.custom_domain || store.domain?.replace('.myshopify.com', '.com');
  const handle = product.handle;
  if (!domain || !handle) return '';
  const protocol = domain.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${domain}/products/${handle}`;
}

// Get primary image URL
function getPrimaryImage(product) {
  const images = product.images || [];
  if (images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (a.position || 0) - (b.position || 0));
  return sorted[0]?.url || null;
}

// Get additional image URLs
function getAdditionalImages(product) {
  const images = product.images || [];
  if (images.length <= 1) return [];
  const sorted = [...images].sort((a, b) => (a.position || 0) - (b.position || 0));
  return sorted.slice(1, 10).map(img => img.url).filter(Boolean);
}

// Format price for GMC (e.g., "299.00 SEK")
function formatPrice(price, currency = 'SEK') {
  if (!price && price !== 0) return null;
  return `${parseFloat(price).toFixed(2)} ${currency}`;
}

// Map availability based on variant inventory
function getAvailability(product) {
  const variants = product.variants || [];
  if (variants.length === 0) {
    return product.status === 'active' ? 'in_stock' : 'out_of_stock';
  }
  const totalStock = variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
  const hasContinuePolicy = variants.some(v => v.inventory_policy === 'continue');
  if (totalStock > 0 || hasContinuePolicy) return 'in_stock';
  return 'out_of_stock';
}

// Map condition values to Google's expected format
function normalizeCondition(condition) {
  if (!condition) return 'new';
  const lower = condition.toLowerCase();
  if (['new', 'ny'].includes(lower)) return 'new';
  if (['used', 'begagnad'].includes(lower)) return 'used';
  if (['refurbished', 'renoverad'].includes(lower)) return 'refurbished';
  return 'new';
}

// Map gender values to Google's expected format
function normalizeGender(gender) {
  if (!gender) return null;
  const lower = gender.toLowerCase();
  if (['male', 'herr', 'man', 'men'].includes(lower)) return 'male';
  if (['female', 'dam', 'kvinna', 'women'].includes(lower)) return 'female';
  if (['unisex'].includes(lower)) return 'unisex';
  return null;
}

// Map age_group values to Google's expected format
function normalizeAgeGroup(ageGroup) {
  if (!ageGroup) return null;
  const lower = ageGroup.toLowerCase();
  if (['adult', 'vuxen', 'adults'].includes(lower)) return 'adult';
  if (['kids', 'barn', 'children', 'kid'].includes(lower)) return 'kids';
  if (['toddler', 'småbarn'].includes(lower)) return 'toddler';
  if (['infant', 'spädbarn'].includes(lower)) return 'infant';
  if (['newborn', 'nyfödd'].includes(lower)) return 'newborn';
  return null;
}

// Build a single product's feed data
function buildProductFeedData(product, store) {
  const gs = product.google_shopping || {};
  const currency = store.currency || 'SEK';

  // Use feed_title if available, otherwise regular title
  const title = product.feed_title || product.title || '';
  // Use feed_description if available, then short_description, then stripped HTML description
  const description = product.feed_description
    || product.short_description
    || stripHtml(product.description)
    || '';

  const price = product.default_price;
  const compareAtPrice = product.default_compare_at_price;

  return {
    id: product.sku || product.id,
    title: title.substring(0, 150),
    description: description.substring(0, 5000),
    link: buildProductLink(store, product),
    image_link: getPrimaryImage(product),
    additional_image_link: getAdditionalImages(product),
    availability: getAvailability(product),
    price: formatPrice(price, currency),
    sale_price: compareAtPrice && price && price < compareAtPrice
      ? formatPrice(price, currency) : null,
    brand: product.vendor || '',
    condition: normalizeCondition(getGoogleField(product, 'condition')),
    google_product_category: getGoogleField(product, 'product_category') || '',
    product_type: product.product_type || '',
    gtin: product.barcode || null,
    mpn: getGoogleField(product, 'mpn') || null,
    gender: normalizeGender(getGoogleField(product, 'gender')),
    age_group: normalizeAgeGroup(getGoogleField(product, 'age_group')),
    color: gs.color || null,
    size: gs.size || null,
    material: gs.material || null,
    pattern: gs.pattern || null,
    item_group_id: product.item_group_id || null,
    custom_label_0: getGoogleField(product, 'custom_label_0') || gs.customLabel0 || null,
    custom_label_1: getGoogleField(product, 'custom_label_1') || gs.customLabel1 || null,
    custom_label_2: gs.customLabel2 || null,
    custom_label_3: gs.customLabel3 || null,
    custom_label_4: gs.customLabel4 || null,
    product_highlight: gs.productHighlight || null,
    ads_redirect: gs.adsRedirect || null,
    identifier_exists: (!product.barcode && !getGoogleField(product, 'mpn')) ? 'no' : null,
    shipping_weight: product.weight ? `${product.weight} ${product.weight_unit || 'g'}` : null,
  };
}

// ============================================
// XML GENERATOR (Google Shopping RSS 2.0)
// ============================================

function generateXml(products, store, feedName) {
  const storeName = escapeXml(store.name || store.domain);
  const storeLink = `https://${store.custom_domain || store.domain}`;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
<title>${storeName} — ${escapeXml(feedName)}</title>
<link>${escapeXml(storeLink)}</link>
<description>Product feed for Google Merchant Center</description>
`;

  for (const product of products) {
    const data = buildProductFeedData(product, store);
    if (!data.link || !data.title) continue;

    xml += `<item>
<g:id>${escapeXml(data.id)}</g:id>
<g:title>${escapeXml(data.title)}</g:title>
<g:description>${escapeXml(data.description)}</g:description>
<g:link>${escapeXml(data.link)}</g:link>
`;

    if (data.image_link) xml += `<g:image_link>${escapeXml(data.image_link)}</g:image_link>\n`;
    for (const img of data.additional_image_link) {
      xml += `<g:additional_image_link>${escapeXml(img)}</g:additional_image_link>\n`;
    }

    xml += `<g:availability>${data.availability}</g:availability>\n`;
    if (data.price) xml += `<g:price>${escapeXml(data.price)}</g:price>\n`;
    if (data.sale_price) xml += `<g:sale_price>${escapeXml(data.sale_price)}</g:sale_price>\n`;
    if (data.brand) xml += `<g:brand>${escapeXml(data.brand)}</g:brand>\n`;
    xml += `<g:condition>${data.condition}</g:condition>\n`;
    if (data.google_product_category) xml += `<g:google_product_category>${escapeXml(data.google_product_category)}</g:google_product_category>\n`;
    if (data.product_type) xml += `<g:product_type>${escapeXml(data.product_type)}</g:product_type>\n`;
    if (data.gtin) xml += `<g:gtin>${escapeXml(data.gtin)}</g:gtin>\n`;
    if (data.mpn) xml += `<g:mpn>${escapeXml(data.mpn)}</g:mpn>\n`;
    if (data.identifier_exists) xml += `<g:identifier_exists>${data.identifier_exists}</g:identifier_exists>\n`;
    if (data.gender) xml += `<g:gender>${data.gender}</g:gender>\n`;
    if (data.age_group) xml += `<g:age_group>${data.age_group}</g:age_group>\n`;
    if (data.color) xml += `<g:color>${escapeXml(data.color)}</g:color>\n`;
    if (data.size) xml += `<g:size>${escapeXml(data.size)}</g:size>\n`;
    if (data.material) xml += `<g:material>${escapeXml(data.material)}</g:material>\n`;
    if (data.pattern) xml += `<g:pattern>${escapeXml(data.pattern)}</g:pattern>\n`;
    if (data.item_group_id) xml += `<g:item_group_id>${escapeXml(data.item_group_id)}</g:item_group_id>\n`;
    if (data.custom_label_0) xml += `<g:custom_label_0>${escapeXml(data.custom_label_0)}</g:custom_label_0>\n`;
    if (data.custom_label_1) xml += `<g:custom_label_1>${escapeXml(data.custom_label_1)}</g:custom_label_1>\n`;
    if (data.custom_label_2) xml += `<g:custom_label_2>${escapeXml(data.custom_label_2)}</g:custom_label_2>\n`;
    if (data.custom_label_3) xml += `<g:custom_label_3>${escapeXml(data.custom_label_3)}</g:custom_label_3>\n`;
    if (data.custom_label_4) xml += `<g:custom_label_4>${escapeXml(data.custom_label_4)}</g:custom_label_4>\n`;
    if (data.product_highlight) {
      const highlights = data.product_highlight.split('\n').filter(h => h.trim());
      for (const h of highlights) {
        xml += `<g:product_highlight>${escapeXml(h.trim())}</g:product_highlight>\n`;
      }
    }
    if (data.ads_redirect) xml += `<g:ads_redirect>${escapeXml(data.ads_redirect)}</g:ads_redirect>\n`;
    if (data.shipping_weight) xml += `<g:shipping_weight>${escapeXml(data.shipping_weight)}</g:shipping_weight>\n`;

    xml += `</item>\n`;
  }

  xml += `</channel>\n</rss>`;
  return xml;
}

// ============================================
// CSV / TSV GENERATOR
// ============================================

const FEED_COLUMNS = [
  'id', 'title', 'description', 'link', 'image_link', 'additional_image_link',
  'availability', 'price', 'sale_price', 'brand', 'condition',
  'google_product_category', 'product_type', 'gtin', 'mpn', 'identifier_exists',
  'gender', 'age_group', 'color', 'size', 'material', 'pattern',
  'item_group_id', 'custom_label_0', 'custom_label_1', 'custom_label_2',
  'custom_label_3', 'custom_label_4', 'product_highlight',
  'ads_redirect', 'shipping_weight'
];

function generateCsvTsv(products, store, separator = ',') {
  const escape = separator === ',' ? escapeCsv : (str) => String(str || '').replace(/\t/g, ' ');
  const lines = [];

  // Header
  lines.push(FEED_COLUMNS.join(separator));

  for (const product of products) {
    const data = buildProductFeedData(product, store);
    if (!data.link || !data.title) continue;

    const row = FEED_COLUMNS.map(col => {
      let val = data[col];
      if (col === 'additional_image_link' && Array.isArray(val)) {
        val = val.join(',');
      }
      return escape(val);
    });
    lines.push(row.join(separator));
  }

  return lines.join('\n');
}

// ============================================
// FEED CRUD & GENERATION
// ============================================

export const feedService = {
  // Generate a secure random token for feed URL
  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  },

  // Create a new feed
  async createFeed(storeId, { name, format = 'xml', filters = {}, settings = {} }) {
    const authToken = this.generateToken();

    const { data, error } = await supabase
      .from('product_feeds')
      .insert({
        store_id: storeId,
        name,
        format,
        filters,
        settings,
        auth_token: authToken,
        status: 'active'
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Get all feeds for a store
  async getFeeds(storeId) {
    const { data, error } = await supabase
      .from('product_feeds')
      .select('*')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // Get feed by ID
  async getFeed(feedId) {
    const { data, error } = await supabase
      .from('product_feeds')
      .select('*')
      .eq('id', feedId)
      .single();

    if (error) throw error;
    return data;
  },

  // Get feed by auth token (for public access)
  async getFeedByToken(token) {
    const { data, error } = await supabase
      .from('product_feeds')
      .select('*')
      .eq('auth_token', token)
      .single();

    if (error) throw error;
    return data;
  },

  // Update a feed
  async updateFeed(feedId, updates) {
    const { data, error } = await supabase
      .from('product_feeds')
      .update(updates)
      .eq('id', feedId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // Delete a feed
  async deleteFeed(feedId) {
    const { error } = await supabase
      .from('product_feeds')
      .delete()
      .eq('id', feedId);

    if (error) throw error;
  },

  // Fetch products for a feed (applying filters)
  async getFeedProducts(feed) {
    let query = supabase
      .from('products')
      .select(`
        *,
        variants (*),
        images (*)
      `)
      .eq('store_id', feed.store_id)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    const filters = feed.filters || {};

    // Apply filters
    if (filters.vendors?.length) {
      query = query.in('vendor', filters.vendors);
    }
    if (filters.productTypes?.length) {
      query = query.in('product_type', filters.productTypes);
    }
    if (filters.tags?.length) {
      query = query.overlaps('tags', filters.tags);
    }

    // Fetch all matching products (paginate past Supabase 1000 row limit)
    let allProducts = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore && allProducts.length < 50000) {
      const { data, error } = await query.range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) throw error;
      if (data && data.length > 0) {
        allProducts = [...allProducts, ...data];
        page++;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    // Apply custom_label filters (these are in google_shopping JSONB or separate columns)
    if (filters.customLabel0) {
      allProducts = allProducts.filter(p => {
        const val = getGoogleField(p, 'custom_label_0') || p.google_shopping?.customLabel0;
        return val && val.toLowerCase() === filters.customLabel0.toLowerCase();
      });
    }
    if (filters.customLabel1) {
      allProducts = allProducts.filter(p => {
        const val = getGoogleField(p, 'custom_label_1') || p.google_shopping?.customLabel1;
        return val && val.toLowerCase() === filters.customLabel1.toLowerCase();
      });
    }
    if (filters.customLabel2) {
      allProducts = allProducts.filter(p => {
        const val = p.google_shopping?.customLabel2;
        return val && val.toLowerCase() === filters.customLabel2.toLowerCase();
      });
    }
    if (filters.customLabel3) {
      allProducts = allProducts.filter(p => {
        const val = p.google_shopping?.customLabel3;
        return val && val.toLowerCase() === filters.customLabel3.toLowerCase();
      });
    }
    if (filters.customLabel4) {
      allProducts = allProducts.filter(p => {
        const val = p.google_shopping?.customLabel4;
        return val && val.toLowerCase() === filters.customLabel4.toLowerCase();
      });
    }

    // Exclude products without required fields (no title or no price)
    allProducts = allProducts.filter(p => p.title && p.default_price);

    return allProducts;
  },

  // Generate feed content
  async generateFeed(feed) {
    const products = await this.getFeedProducts(feed);

    // Get store info
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', feed.store_id)
      .single();

    if (storeError) throw storeError;

    let content;
    let contentType;

    switch (feed.format) {
      case 'csv':
        content = generateCsvTsv(products, store, ',');
        contentType = 'text/csv; charset=utf-8';
        break;
      case 'tsv':
        content = generateCsvTsv(products, store, '\t');
        contentType = 'text/tab-separated-values; charset=utf-8';
        break;
      case 'xml':
      default:
        content = generateXml(products, store, feed.name);
        contentType = 'application/xml; charset=utf-8';
        break;
    }

    // Update feed stats
    await supabase
      .from('product_feeds')
      .update({
        product_count: products.length,
        last_generated_at: new Date().toISOString()
      })
      .eq('id', feed.id);

    return { content, contentType, productCount: products.length };
  }
};

export default feedService;
