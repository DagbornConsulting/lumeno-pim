-- ============================================
-- MIGRATION: Prishistorik ("lägsta pris senaste 30 dagarna")
-- Run in Supabase SQL Editor.
--
-- One row per SKU and day with the live Shopify price + compare-at.
-- Written by the nightly cron (and on demand). Used to compute the
-- lowest price in the 30 days BEFORE a price reduction, as required by
-- prisinformationslagen (EU omnibus), and to feed the dashboard's REA
-- card + the lumeno.lagsta_pris_30d variant metafield the theme reads.
-- ============================================

CREATE TABLE IF NOT EXISTS price_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    sku VARCHAR(255) NOT NULL,
    day DATE NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    compare_at_price DECIMAL(10,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, sku, day)
);

CREATE INDEX IF NOT EXISTS idx_price_history_store_sku_day ON price_history(store_id, sku, day DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_store_day ON price_history(store_id, day);

ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
