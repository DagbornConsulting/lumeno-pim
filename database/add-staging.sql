-- Staging flag for newly imported products.
-- Products created via the rich import land in a "Nya produkter" staging list,
-- kept OUT of the main catalogue until pushed to Shopify. On successful publish
-- the flag is cleared and the product joins the main product list.

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_staged BOOLEAN DEFAULT false;

-- Backfill: everything that already exists is part of the live catalogue.
UPDATE products SET is_staged = false WHERE is_staged IS NULL;

-- Fast lookups for both the main list (is_staged = false) and staging (is_staged = true).
CREATE INDEX IF NOT EXISTS idx_products_staged ON products(store_id, is_staged);
