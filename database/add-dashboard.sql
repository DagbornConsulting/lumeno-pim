-- ============================================
-- MIGRATION: Dashboard ("Översikt") data
-- Run in Supabase SQL Editor.
--
-- 1. supplier_stock — latest snapshot per SKU from the supplier file
--    (Affari "Dropship.csv": stock, dropship approval, purchase price).
--    Lets the dashboard flag "sold out at supplier but live in store" and
--    "purchase price changed" without touching products/prices.
-- 2. units_30d / revenue_30d on price_benchmarks — sales from Shopify so
--    price alerts can be sorted by impact (high-turnover first).
-- ============================================

CREATE TABLE IF NOT EXISTS supplier_stock (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    sku VARCHAR(255) NOT NULL,
    name VARCHAR(500),
    ean VARCHAR(32),
    supplier_price DECIMAL(10,2),        -- per unit, excl. VAT
    pack_qty INT,                        -- when the file has it (ExcelExportGeneral)
    stock INT,                           -- "Lagersaldo"
    in_stock BOOLEAN,                    -- "I lager"
    dropship_ok BOOLEAN,                 -- "Godkänd för dropship"
    delivery_week VARCHAR(10),           -- "Lev. vecka (ååvv)"
    supplier_updated_at TIMESTAMPTZ,     -- "Uppdaterat" in the file
    source_file VARCHAR(255),
    imported_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_supplier_stock_store ON supplier_stock(store_id);

ALTER TABLE price_benchmarks ADD COLUMN IF NOT EXISTS units_30d INT NOT NULL DEFAULT 0;
ALTER TABLE price_benchmarks ADD COLUMN IF NOT EXISTS revenue_30d DECIMAL(12,2);

ALTER TABLE supplier_stock ENABLE ROW LEVEL SECURITY;
