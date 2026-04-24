import crypto from 'crypto';
import { db, supabase } from './db.js';

// ============================================
// SHOPIFY APP CONFIGURATION
// ============================================

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_SCOPES = [
  'read_products',
  'write_products',
  'read_inventory',
  'write_inventory',
  'read_metaobjects',
  'write_metaobjects',
  'read_metaobject_definitions',
  'write_metaobject_definitions',
  'read_customers',
  'write_customers',
  'read_price_rules',
  'write_price_rules',
  'read_discounts',
  'write_discounts',
  'read_markets',
  'write_markets',
  'read_fulfillments',
  'write_fulfillments',
  'read_marketing_events',
  'write_marketing_events',
].join(',');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// ============================================
// OAUTH HELPERS
// ============================================

// Generate a random nonce for OAuth
function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

// Verify Shopify HMAC signature
function verifyHmac(query) {
  const { hmac, ...params } = query;
  
  if (!hmac || !SHOPIFY_API_SECRET) return false;
  
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  
  const calculatedHmac = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(sortedParams)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(hmac),
    Buffer.from(calculatedHmac)
  );
}

// Verify webhook signature
function verifyWebhook(data, hmacHeader) {
  if (!SHOPIFY_API_SECRET) return false;
  
  const calculatedHmac = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(data, 'utf8')
    .digest('base64');
  
  return crypto.timingSafeEqual(
    Buffer.from(hmacHeader),
    Buffer.from(calculatedHmac)
  );
}

// ============================================
// SHOPIFY APP SERVICE
// ============================================

export const shopifyApp = {
  
  // Check if app is configured
  isConfigured() {
    return !!(SHOPIFY_API_KEY && SHOPIFY_API_SECRET);
  },

  // Get install URL for a shop
  getInstallUrl(shop) {
    if (!this.isConfigured()) {
      throw new Error('Shopify App not configured. Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET');
    }
    
    const nonce = generateNonce();
    const redirectUri = `${APP_URL}/api/shopify/callback`;
    
    // Store nonce temporarily (in production, use Redis or DB)
    if (!global.shopifyNonces) global.shopifyNonces = {};
    global.shopifyNonces[shop] = nonce;
    
    // Clean old nonces after 10 minutes
    setTimeout(() => {
      delete global.shopifyNonces[shop];
    }, 10 * 60 * 1000);
    
    const installUrl = `https://${shop}/admin/oauth/authorize?` +
      `client_id=${SHOPIFY_API_KEY}&` +
      `scope=${SHOPIFY_SCOPES}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `state=${nonce}`;
    
    return { installUrl, nonce };
  },

  // Handle OAuth callback
  async handleCallback(query) {
    const { shop, code, state, hmac } = query;
    
    // Verify HMAC
    if (!verifyHmac(query)) {
      throw new Error('Invalid HMAC signature');
    }
    
    // Verify nonce/state
    if (!global.shopifyNonces?.[shop] || global.shopifyNonces[shop] !== state) {
      throw new Error('Invalid state parameter');
    }
    
    // Clean up nonce
    delete global.shopifyNonces[shop];
    
    // Exchange code for access token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code
      })
    });
    
    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      throw new Error(`Failed to get access token: ${error}`);
    }
    
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    
    // Get shop info
    const shopResponse = await fetch(`https://${shop}/admin/api/2025-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });
    
    const shopData = await shopResponse.json();
    const shopInfo = shopData.shop;
    
    // Save or update store in database
    const store = await this.saveStore({
      domain: shop,
      accessToken,
      shopInfo
    });
    
    return store;
  },

  // Save store to database
  async saveStore({ domain, accessToken, shopInfo }) {
    if (!supabase) {
      throw new Error('Database not configured');
    }
    
    // Check if store already exists
    const { data: existingStore } = await supabase
      .from('stores')
      .select('id')
      .eq('domain', domain)
      .single();
    
    const storeData = {
      name: shopInfo.name,
      domain: domain,
      custom_domain: shopInfo.domain,
      access_token: accessToken,
      country_code: shopInfo.country_code,
      currency: shopInfo.currency,
      status: 'connected',
      settings: {
        email: shopInfo.email,
        phone: shopInfo.phone,
        timezone: shopInfo.timezone,
        plan_name: shopInfo.plan_name
      },
      last_sync_at: new Date().toISOString()
    };
    
    let result;
    
    if (existingStore) {
      // Update existing store
      const { data, error } = await supabase
        .from('stores')
        .update(storeData)
        .eq('id', existingStore.id)
        .select()
        .single();
      
      if (error) throw error;
      result = data;
    } else {
      // Insert new store
      const { data, error } = await supabase
        .from('stores')
        .insert(storeData)
        .select()
        .single();
      
      if (error) throw error;
      result = data;
    }
    
    // Register webhooks
    await this.registerWebhooks(domain, accessToken);
    
    return result;
  },

  // Register webhooks for the store
  async registerWebhooks(shop, accessToken) {
    const webhooks = [
      { topic: 'app/uninstalled', address: `${APP_URL}/api/shopify/webhooks/uninstalled` },
      { topic: 'products/update', address: `${APP_URL}/api/shopify/webhooks/products-update` },
    ];
    
    for (const webhook of webhooks) {
      try {
        await fetch(`https://${shop}/admin/api/2025-01/webhooks.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken
          },
          body: JSON.stringify({ webhook })
        });
      } catch (error) {
        console.error(`Failed to register webhook ${webhook.topic}:`, error);
      }
    }
  },

  // Handle app uninstall webhook
  async handleUninstall(shop) {
    if (!supabase) return;
    
    // Mark store as disconnected (don't delete, keep history)
    await supabase
      .from('stores')
      .update({ 
        status: 'disconnected',
        access_token: null 
      })
      .eq('domain', shop);
    
    console.log(`Store ${shop} uninstalled app`);
  },

  // Verify webhook and get shop
  verifyWebhook(body, hmacHeader) {
    return verifyWebhook(body, hmacHeader);
  },

  // Delete a store completely
  async deleteStore(storeId) {
    if (!supabase) {
      throw new Error('Database not configured');
    }
    
    // Delete store (cascades to store_products etc)
    const { error } = await supabase
      .from('stores')
      .delete()
      .eq('id', storeId);
    
    if (error) throw error;
    return true;
  },

  // Get all stores
  async getStores() {
    if (!supabase) return [];
    
    const { data, error } = await supabase
      .from('stores')
      .select('*')
      .order('name');
    
    if (error) throw error;
    return data || [];
  },

  // Test store connection
  async testConnection(store) {
    try {
      const response = await fetch(`https://${store.domain}/admin/api/2025-01/shop.json`, {
        headers: { 'X-Shopify-Access-Token': store.access_token }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      // Update last_sync_at
      if (supabase) {
        await supabase
          .from('stores')
          .update({ 
            status: 'connected',
            last_sync_at: new Date().toISOString()
          })
          .eq('id', store.id);
      }
      
      return {
        success: true,
        shop: data.shop
      };
    } catch (error) {
      // Mark as error
      if (supabase) {
        await supabase
          .from('stores')
          .update({ status: 'error' })
          .eq('id', store.id);
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }
};

export default shopifyApp;
