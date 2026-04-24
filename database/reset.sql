-- ============================================
-- RESET: Drops all PIM tables, types and views
-- Run this BEFORE schema.sql if you have a partial/broken state
-- WARNING: Destroys all data in these tables
-- ============================================

DROP VIEW IF EXISTS v_discounted_products CASCADE;
DROP VIEW IF EXISTS v_products_overview CASCADE;

DROP TABLE IF EXISTS product_feeds CASCADE;
DROP TABLE IF EXISTS activity_log CASCADE;
DROP TABLE IF EXISTS sync_queue CASCADE;
DROP TABLE IF EXISTS price_campaign_products CASCADE;
DROP TABLE IF EXISTS price_campaigns CASCADE;
DROP TABLE IF EXISTS supplier_profiles CASCADE;
DROP TABLE IF EXISTS images CASCADE;
DROP TABLE IF EXISTS variants CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS metafield_definitions CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS user_stores CASCADE;
DROP TABLE IF EXISTS stores CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP TYPE IF EXISTS sync_status CASCADE;
DROP TYPE IF EXISTS product_status CASCADE;
DROP TYPE IF EXISTS user_role CASCADE;
DROP TYPE IF EXISTS inventory_policy CASCADE;
DROP TYPE IF EXISTS weight_unit CASCADE;
