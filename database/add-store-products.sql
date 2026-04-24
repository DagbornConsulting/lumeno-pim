-- store_products: links PIM products to Shopify stores and tracks sync status
CREATE TABLE IF NOT EXISTS store_products (
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

CREATE INDEX IF NOT EXISTS idx_store_products_product ON store_products(product_id);
CREATE INDEX IF NOT EXISTS idx_store_products_store ON store_products(store_id);
CREATE INDEX IF NOT EXISTS idx_store_products_shopify ON store_products(shopify_product_id);
