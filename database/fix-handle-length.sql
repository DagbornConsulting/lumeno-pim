-- Migration: Increase handle length from 160 to 500 characters
-- This fixes "value too long for type character varying(160)" errors during import

-- Step 1: Drop dependents (view + trigger reference seo_title/seo_description)
DROP VIEW IF EXISTS v_discounted_products;
DROP TRIGGER IF EXISTS mark_product_pending_on_update ON products;

-- Step 2: Update products table columns
ALTER TABLE products
ALTER COLUMN handle TYPE VARCHAR(500);

-- Also increase seo_title if needed (Shopify allows up to 70)
ALTER TABLE products
ALTER COLUMN seo_title TYPE VARCHAR(100);

-- Increase seo_description (Shopify meta descriptions can be longer)
ALTER TABLE products
ALTER COLUMN seo_description TYPE VARCHAR(320);

-- Step 3: Recreate the trigger (same definition as schema.sql)
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

-- Step 4: Recreate the view
CREATE VIEW v_discounted_products AS
SELECT
    p.*,
    pc.discount_percent,
    pc.name as campaign_name,
    pcp.original_price,
    pcp.new_price
FROM products p
JOIN price_campaign_products pcp ON p.id = pcp.product_id
JOIN price_campaigns pc ON pcp.campaign_id = pc.id
WHERE pc.status = 'active';

-- Step 5: Add index on handle for faster lookups
CREATE INDEX IF NOT EXISTS idx_products_handle ON products(handle);

-- Step 6: Verify changes
SELECT
    column_name,
    data_type,
    character_maximum_length
FROM information_schema.columns
WHERE table_name = 'products'
  AND column_name IN ('handle', 'seo_title', 'seo_description');
