-- ============================================
-- SYNC BASELINE (non-destructive push / conflict detection)
--
-- Stores the last-known Shopify content per linked product so the PIM can tell
-- WHO changed a field since the last sync:
--   * PIM changed it      -> safe to push
--   * Shopify changed it  -> pull the Shopify value into the PIM
--   * both changed it     -> conflict, ask the user (never overwrite silently)
--
-- shopify_baseline holds the managed content as last seen from Shopify:
--   { title, body_html, product_type, tags: [...], metafields: { "ns.key": value } }
-- conflict_fields records unresolved conflicts so the UI can flag them.
-- ============================================

ALTER TABLE store_products
  ADD COLUMN IF NOT EXISTS shopify_baseline   JSONB,
  ADD COLUMN IF NOT EXISTS baseline_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS conflict_fields    JSONB;
