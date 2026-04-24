-- ============================================
-- MIGRATION: Pricing Engine
-- Adds margin multiplier resolution per product/category/supplier/global
-- and supplier handling fee for dropshipping cost calculations
-- ============================================

-- Step 1: Per-product margin override (NULL = inherit from category/supplier/global)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS margin_multiplier DECIMAL(5,3);

-- Step 2: Per-category margin rules (matches products.product_type)
CREATE TABLE IF NOT EXISTS category_margin_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category VARCHAR(255) NOT NULL,
  margin_multiplier DECIMAL(5,3) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, category)
);

CREATE INDEX IF NOT EXISTS idx_category_margin_rules_store
  ON category_margin_rules(store_id);

-- Step 3: Supplier handling fee (0% by default — only some suppliers charge)
ALTER TABLE supplier_profiles
  ADD COLUMN IF NOT EXISTS supplier_fee_percent DECIMAL(5,2) DEFAULT 0;

-- Step 4: Global pricing settings per store
CREATE TABLE IF NOT EXISTS pricing_settings (
  store_id UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  default_margin_multiplier DECIMAL(5,3) DEFAULT 2.0,
  default_vat_rate DECIMAL(5,3) DEFAULT 0.25,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 5: Reuse update_updated_at trigger on the new tables
CREATE TRIGGER update_category_margin_rules_updated_at
  BEFORE UPDATE ON category_margin_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_pricing_settings_updated_at
  BEFORE UPDATE ON pricing_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
