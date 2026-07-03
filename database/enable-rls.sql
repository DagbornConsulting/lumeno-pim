-- ============================================
-- ENABLE ROW LEVEL SECURITY (deny-all)  —  RUN THIS BEFORE ANY PUBLIC DEPLOY
--
-- Why: on Supabase every table in `public` is auto-exposed through PostgREST.
-- Without RLS, anyone holding the anon key (which is designed to be public)
-- can SELECT/INSERT/UPDATE/DELETE everything — including users.password_hash,
-- sessions.token, and stores.access_token. That is full compromise.
--
-- This migration turns RLS ON for every table and creates NO policies, which
-- denies all access to the anon and authenticated roles. The application server
-- connects with the service-role key, which BYPASSES RLS, so the app keeps
-- working. Net effect: the DB is reachable only through the server, never
-- directly via the anon key.
--
-- If you later add client-side Supabase access, add explicit, per-tenant
-- CREATE POLICY statements — do not just disable RLS.
-- ============================================

ALTER TABLE users                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_stores             ENABLE ROW LEVEL SECURITY;
ALTER TABLE products                ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants                ENABLE ROW LEVEL SECURITY;
ALTER TABLE images                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections             ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_products     ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_mappings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE metafield_definitions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_feeds           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_queue              ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_margin_rules   ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_campaign_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_profiles       ENABLE ROW LEVEL SECURITY;

-- Force RLS even for the table owner, so a mistaken owner-context query can't
-- leak data. (service_role still bypasses; it has the BYPASSRLS attribute.)
ALTER TABLE users    FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE stores   FORCE ROW LEVEL SECURITY;

-- Views run with the definer's privileges by default, which would bypass the
-- RLS above. Recreate them as security_invoker so they honor the caller's RLS.
-- (Requires PostgreSQL 15+, which Supabase uses.)
ALTER VIEW IF EXISTS v_products_overview  SET (security_invoker = true);
ALTER VIEW IF EXISTS v_discounted_products SET (security_invoker = true);

-- ============================================
-- Verify afterwards:
--   SELECT relname, relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace;
-- Every application table should show relrowsecurity = true.
-- ============================================
