-- ============================================
-- MIGRATION: Product Feeds for Google Merchant Center
-- ============================================

-- Feed-optimerade titlar och beskrivningar på produkter
-- (Google vill ha attribut-packade titlar, butiken vill ha snygga)
ALTER TABLE products ADD COLUMN IF NOT EXISTS feed_title VARCHAR(150);
ALTER TABLE products ADD COLUMN IF NOT EXISTS feed_description TEXT;

-- ============================================
-- PRODUCT FEEDS (Feed-konfigurationer)
-- ============================================

CREATE TABLE IF NOT EXISTS product_feeds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    format VARCHAR(10) NOT NULL DEFAULT 'xml',  -- 'xml' | 'csv' | 'tsv'
    status VARCHAR(20) NOT NULL DEFAULT 'active',  -- 'active' | 'paused'

    -- Auth token för publik URL (GMC hämtar via denna)
    auth_token VARCHAR(64) NOT NULL UNIQUE,

    -- Filter: vilka produkter som inkluderas
    -- Exempel: { "vendors": ["TaylorMade"], "customLabel0": "Bästsäljare", "status": "active", "tags": ["nyhet"] }
    filters JSONB DEFAULT '{}',

    -- Inställningar
    settings JSONB DEFAULT '{}',
    -- Exempel: { "includeVariants": true, "currency": "SEK", "country": "SE", "language": "sv" }

    product_count INT DEFAULT 0,
    last_generated_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_feeds_store ON product_feeds(store_id);
CREATE INDEX IF NOT EXISTS idx_product_feeds_token ON product_feeds(auth_token);

CREATE TRIGGER update_product_feeds_updated_at BEFORE UPDATE ON product_feeds
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
