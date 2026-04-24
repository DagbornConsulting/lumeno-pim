-- ============================================
-- Todas PIM — Database Schema (Multi-tenant)
-- PostgreSQL / Supabase
-- ============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE user_role AS ENUM ('admin', 'client');
CREATE TYPE product_status AS ENUM ('draft', 'active', 'archived');
CREATE TYPE sync_status AS ENUM ('pending', 'syncing', 'synced', 'error');
CREATE TYPE inventory_policy AS ENUM ('deny', 'continue');
CREATE TYPE weight_unit AS ENUM ('g', 'kg', 'lb', 'oz');

-- ============================================
-- USERS (Admin + Kundinlogg)
-- ============================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name VARCHAR(255),
    role user_role NOT NULL DEFAULT 'client',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- STORES (Shopify-butiker)
-- ============================================

CREATE TABLE stores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    domain VARCHAR(255) NOT NULL UNIQUE,
    custom_domain VARCHAR(255),
    access_token TEXT,
    api_version VARCHAR(20) DEFAULT '2025-01',
    country_code VARCHAR(2) DEFAULT 'SE',
    currency VARCHAR(3) DEFAULT 'SEK',
    status VARCHAR(20) DEFAULT 'pending',
    settings JSONB DEFAULT '{}',
    tone_of_voice TEXT,
    brand_profile JSONB,
    default_language VARCHAR(5) DEFAULT 'sv',
    last_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- USER ↔ STORE (Vilka butiker en användare har åtkomst till)
-- ============================================

CREATE TABLE user_stores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, store_id)
);

CREATE INDEX idx_user_stores_user ON user_stores(user_id);
CREATE INDEX idx_user_stores_store ON user_stores(store_id);

-- ============================================
-- SESSIONS
-- ============================================

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ============================================
-- METAFIELD DEFINITIONS
-- ============================================

CREATE TABLE metafield_definitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL,
    namespace VARCHAR(255) NOT NULL,
    description TEXT,
    field_type VARCHAR(50) NOT NULL,
    validations JSONB DEFAULT '{}',
    is_required BOOLEAN DEFAULT false,
    is_system BOOLEAN DEFAULT false,
    show_in_list BOOLEAN DEFAULT false,
    sort_order INT DEFAULT 0,
    synced_to_shopify BOOLEAN DEFAULT false,
    shopify_definition_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, namespace, key)
);

-- System metafield definitions (global, store_id = NULL)
INSERT INTO metafield_definitions (name, key, namespace, field_type, description, is_system, sort_order) VALUES
('Kort beskrivning', 'kort_beskrivning', 'custom', 'multi_line_text', 'Kort ingress för produktkort och schema.org', true, 1),
('Agent Summary', 'agent_summary', 'custom', 'multi_line_text', 'Snabbfakta för AI-agenter och LLMs', true, 2),
('FAQ', 'faq', 'custom', 'json', 'Frågor och svar [{"question":"...","answer":"..."}]', true, 3),
('Specifikationer', 'attributes_json', 'custom', 'json', 'Produktattribut [{"name":"...","value":"..."}]', true, 4),
('Användningsområden', 'use_cases', 'custom', 'multi_line_text', 'Användningskontext för AI-agenter', true, 5),
('Källmaterial', 'source_material', 'custom', 'multi_line_text', 'Rådata från leverantör för AI-generering', true, 6),
('MPN', 'mpn', 'custom', 'single_line_text', 'Manufacturer Part Number', true, 7),
('Product Label', 'label', 'theme', 'single_line_text', 'Badge-text (Nyhet, Rea, etc)', true, 8),
('Product Label Color', 'label_color', 'theme', 'color', 'Färg på badge', true, 9);

-- ============================================
-- PRODUCTS (Ägs av en butik)
-- ============================================

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,

    -- Basic info
    title VARCHAR(500) NOT NULL,
    handle VARCHAR(500),
    description TEXT,
    vendor VARCHAR(255),
    product_type VARCHAR(255),

    -- Taxonomy
    product_category VARCHAR(500),
    tags TEXT[],

    -- Status
    status product_status DEFAULT 'draft',
    published_on_online_store BOOLEAN DEFAULT true,

    -- SEO
    seo_title VARCHAR(70),
    seo_description VARCHAR(160),

    -- AI Content
    short_description TEXT,
    agent_summary TEXT,
    use_cases TEXT,
    specifications JSONB,
    faq JSONB,
    schema_json JSONB,
    search_terms TEXT,

    -- Quality
    quality_score INT,
    quality_details JSONB,

    -- Default pricing
    default_price DECIMAL(10,2),
    default_compare_at_price DECIMAL(10,2),
    default_cost DECIMAL(10,2),

    -- Default SKU/Barcode (for products without variants)
    sku VARCHAR(255),
    barcode VARCHAR(255),

    -- Tax & Shipping
    charge_tax BOOLEAN DEFAULT true,
    tax_code VARCHAR(50),
    requires_shipping BOOLEAN DEFAULT true,

    -- Weight
    weight DECIMAL(10,2),
    weight_unit weight_unit DEFAULT 'g',

    -- Google Shopping
    google_shopping JSONB DEFAULT '{}',

    -- Metafields (flexible key-value)
    metafields JSONB DEFAULT '{}',

    -- Shopify sync
    shopify_product_id BIGINT,
    shopify_product_gid VARCHAR(255),
    sync_status sync_status DEFAULT 'pending',
    last_synced_at TIMESTAMPTZ,
    last_sync_error TEXT,
    pim_version INT DEFAULT 1,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_products_store ON products(store_id);
CREATE INDEX idx_products_vendor ON products(vendor);
CREATE INDEX idx_products_type ON products(product_type);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_sync ON products(sync_status);
CREATE INDEX idx_products_tags ON products USING GIN(tags);
CREATE INDEX idx_products_metafields ON products USING GIN(metafields);
CREATE INDEX idx_products_shopify ON products(shopify_product_id);

CREATE INDEX idx_products_search ON products USING GIN(
    to_tsvector('swedish', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(vendor, ''))
);

-- ============================================
-- VARIANTS
-- ============================================

CREATE TABLE variants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,

    sku VARCHAR(255),
    barcode VARCHAR(255),

    option1_name VARCHAR(255),
    option1_value VARCHAR(255),
    option2_name VARCHAR(255),
    option2_value VARCHAR(255),
    option3_name VARCHAR(255),
    option3_value VARCHAR(255),

    price DECIMAL(10,2),
    compare_at_price DECIMAL(10,2),
    cost DECIMAL(10,2),

    weight DECIMAL(10,2),
    weight_unit weight_unit DEFAULT 'g',

    inventory_quantity INT DEFAULT 0,
    inventory_policy inventory_policy DEFAULT 'deny',

    shopify_variant_id BIGINT,
    shopify_inventory_item_id BIGINT,

    position INT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_variants_product ON variants(product_id);
CREATE INDEX idx_variants_sku ON variants(sku);
CREATE INDEX idx_variants_barcode ON variants(barcode);

-- ============================================
-- IMAGES
-- ============================================

CREATE TABLE images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES variants(id) ON DELETE SET NULL,

    url TEXT NOT NULL,
    alt_text VARCHAR(500),
    position INT DEFAULT 1,
    width INT,
    height INT,

    source VARCHAR(50),
    original_filename VARCHAR(255),
    shopify_image_id VARCHAR(255),

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_images_product ON images(product_id);

-- ============================================
-- SUPPLIER PROFILES (Per butik)
-- ============================================

CREATE TABLE supplier_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,

    file_type VARCHAR(20),
    column_mapping JSONB DEFAULT '{}',
    variant_strategy VARCHAR(50),
    variant_config JSONB,

    image_base_url TEXT,
    image_pattern VARCHAR(255),
    max_images INT DEFAULT 8,

    price_includes_vat BOOLEAN DEFAULT true,
    vat_rate DECIMAL(5,2) DEFAULT 0.25,
    margin_rule JSONB,
    category_mapping JSONB,

    default_vendor VARCHAR(255),
    default_tags TEXT[],
    defaults JSONB DEFAULT '{}',

    product_count INT DEFAULT 0,
    last_import_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_supplier_profiles_store ON supplier_profiles(store_id);

-- ============================================
-- PRICE CAMPAIGNS (Per butik)
-- ============================================

CREATE TABLE price_campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name VARCHAR(255),
    discount_percent DECIMAL(5,2) NOT NULL,
    filters JSONB DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'active',
    product_count INT DEFAULT 0,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_campaigns_store ON price_campaigns(store_id);

-- ============================================
-- PRICE CAMPAIGN PRODUCTS
-- ============================================

CREATE TABLE price_campaign_products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES price_campaigns(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    original_price DECIMAL(10,2),
    original_compare_at_price DECIMAL(10,2),
    new_price DECIMAL(10,2),
    variant_prices JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_campaign_products_campaign ON price_campaign_products(campaign_id);

-- ============================================
-- SYNC QUEUE
-- ============================================

CREATE TABLE sync_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL,
    priority INT DEFAULT 5,
    status VARCHAR(20) DEFAULT 'pending',
    attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    payload JSONB,
    error_message TEXT,
    scheduled_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sync_queue_status ON sync_queue(status);
CREATE INDEX idx_sync_queue_store ON sync_queue(store_id);

-- ============================================
-- ACTIVITY LOG (Per butik)
-- ============================================

CREATE TABLE activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    description TEXT,
    changes JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_activity_store ON activity_log(store_id);
CREATE INDEX idx_activity_entity ON activity_log(entity_type, entity_id);
CREATE INDEX idx_activity_created ON activity_log(created_at);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_stores_updated_at BEFORE UPDATE ON stores
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_variants_updated_at BEFORE UPDATE ON variants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION generate_handle()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.handle IS NULL OR NEW.handle = '' THEN
        NEW.handle = LOWER(
            REGEXP_REPLACE(
                REGEXP_REPLACE(
                    TRANSLATE(NEW.title, 'åäöÅÄÖéèêëÉÈÊË', 'aaoAAOeeeeEEEE'),
                    '[^a-zA-Z0-9]+', '-', 'g'
                ),
                '^-|-$', '', 'g'
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generate_product_handle BEFORE INSERT OR UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION generate_handle();

CREATE OR REPLACE FUNCTION mark_product_pending()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.shopify_product_id IS NOT NULL AND NEW.sync_status = 'synced' THEN
        NEW.sync_status = 'pending';
        NEW.pim_version = OLD.pim_version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mark_product_pending_on_update BEFORE UPDATE ON products
    FOR EACH ROW
    WHEN (OLD.title IS DISTINCT FROM NEW.title
       OR OLD.description IS DISTINCT FROM NEW.description
       OR OLD.metafields IS DISTINCT FROM NEW.metafields
       OR OLD.default_price IS DISTINCT FROM NEW.default_price
       OR OLD.seo_title IS DISTINCT FROM NEW.seo_title
       OR OLD.seo_description IS DISTINCT FROM NEW.seo_description
       OR OLD.tags IS DISTINCT FROM NEW.tags
       OR OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION mark_product_pending();

-- ============================================
-- VIEWS
-- ============================================

CREATE VIEW v_products_overview AS
SELECT
    p.id,
    p.store_id,
    p.title,
    p.vendor,
    p.product_type,
    p.status,
    p.sync_status,
    p.quality_score,
    p.default_price,
    p.shopify_product_id,
    p.updated_at,
    s.name as store_name,
    s.domain as store_domain,
    COUNT(v.id) as variant_count,
    COUNT(i.id) as image_count
FROM products p
JOIN stores s ON p.store_id = s.id
LEFT JOIN variants v ON p.id = v.product_id
LEFT JOIN images i ON p.id = i.product_id
GROUP BY p.id, s.name, s.domain;
