-- ============================================
-- MIGRATION: Prisbevakning (price watch)
-- Run in Supabase SQL Editor.
--
-- 1. pack_qty on products/variants — number of units the customer receives
--    per sold article (Affari: "Förpackningsantal dropship"). Affari's price
--    is per unit, so cost per sold article = cost × pack_qty.
-- 2. price_benchmarks — one row per Merchant Center offer with the latest
--    benchmark, computed status and acknowledgement state.
-- 3. price_benchmark_history — daily snapshot per offer (trend + audit).
-- 4. price_watch_runs — log of nightly/manual fetches.
--
-- The module NEVER writes prices to Shopify. Read + status only.
-- ============================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_qty INT NOT NULL DEFAULT 1;
ALTER TABLE variants ADD COLUMN IF NOT EXISTS pack_qty INT;  -- NULL = inherit from product

CREATE TABLE IF NOT EXISTS price_benchmarks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,

    -- Merchant Center offer (channel~lang~feedLabel~offerId → offerId)
    offer_id VARCHAR(255) NOT NULL,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    variant_id UUID REFERENCES variants(id) ON DELETE SET NULL,
    sku VARCHAR(255),
    title VARCHAR(500),
    brand VARCHAR(255),
    country_code VARCHAR(5),
    currency VARCHAR(3),

    -- Source values (per sold article, incl. VAT)
    our_price DECIMAL(10,2),
    benchmark_price DECIMAL(10,2),          -- NULL when Google has no benchmark
    benchmark_fetched_at TIMESTAMPTZ,
    reference_source VARCHAR(20),           -- 'merchant' | 'crawler' | NULL
    source_count INT NOT NULL DEFAULT 0,    -- crawler only (phase 2)
    observed_min DECIMAL(10,2),             -- crawler only (phase 2)
    observed_median DECIMAL(10,2),          -- crawler only (phase 2)

    -- Derived
    pack_qty INT NOT NULL DEFAULT 1,
    unit_price_ours DECIMAL(10,2),          -- our_price / pack_qty
    cost_price DECIMAL(10,2),               -- purchase price per sold article, excl. VAT
    floor_price DECIMAL(10,2),              -- lowest acceptable price incl. VAT
    price_index DECIMAL(8,3),               -- our_price / benchmark_price
    price_status VARCHAR(5) NOT NULL DEFAULT 'GRÅ',  -- GRÅ | RÖD | GUL | BLÅ | OK

    -- Acknowledgement (silences the alert until benchmark moves)
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by VARCHAR(255),
    acknowledged_benchmark DECIMAL(10,2),
    acknowledged_note TEXT,
    reopened_count INT NOT NULL DEFAULT 0,

    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_price_benchmarks_store_status ON price_benchmarks(store_id, price_status);
CREATE INDEX IF NOT EXISTS idx_price_benchmarks_product ON price_benchmarks(product_id);

CREATE TABLE IF NOT EXISTS price_benchmark_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    offer_id VARCHAR(255) NOT NULL,
    day DATE NOT NULL,
    our_price DECIMAL(10,2),
    benchmark_price DECIMAL(10,2),
    price_index DECIMAL(8,3),
    price_status VARCHAR(5),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, offer_id, day)
);

CREATE TABLE IF NOT EXISTS price_watch_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    trigger VARCHAR(20) NOT NULL DEFAULT 'manual',  -- 'manual' | 'scheduled'
    status VARCHAR(20) NOT NULL DEFAULT 'running',  -- 'running' | 'ok' | 'error'
    started_at TIMESTAMPTZ DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    offers_total INT DEFAULT 0,
    with_benchmark INT DEFAULT 0,
    matched INT DEFAULT 0,
    reopened INT DEFAULT 0,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_price_watch_runs_store ON price_watch_runs(store_id, started_at DESC);

-- Deny-all RLS like the other tables (see enable-rls.sql). The server uses the
-- service-role key, which bypasses RLS; anon/public access is blocked.
ALTER TABLE price_benchmarks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_benchmark_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_watch_runs         ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_price_benchmarks_updated_at ON price_benchmarks;
CREATE TRIGGER update_price_benchmarks_updated_at
  BEFORE UPDATE ON price_benchmarks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
