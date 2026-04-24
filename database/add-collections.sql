-- ============================================
-- Collections feature migration
-- ============================================

-- Main collections table
CREATE TABLE IF NOT EXISTS collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  handle VARCHAR(255),
  description TEXT,
  collection_type VARCHAR(20) DEFAULT 'manual' CHECK (collection_type IN ('manual', 'smart')),
  sort_order VARCHAR(50) DEFAULT 'best-selling',
  published BOOLEAN DEFAULT true,
  image_url TEXT,
  image_alt TEXT,
  rules JSONB DEFAULT '[]',
  disjunctive BOOLEAN DEFAULT false,
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

-- Products in manual collections (junction table)
CREATE TABLE IF NOT EXISTS collection_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  position INT,
  UNIQUE(collection_id, product_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_collections_store_id ON collections(store_id);
CREATE INDEX IF NOT EXISTS idx_collections_shopify_id ON collections(shopify_collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_products_collection_id ON collection_products(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_products_product_id ON collection_products(product_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_collections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_collections_updated_at ON collections;
CREATE TRIGGER trg_collections_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION update_collections_updated_at();
