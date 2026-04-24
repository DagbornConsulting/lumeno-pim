-- Add customs/export fields to products and variants
-- Used for international shipping (Norway, EU customs declarations)

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS country_of_origin VARCHAR(2),
  ADD COLUMN IF NOT EXISTS hs_code VARCHAR(20);

ALTER TABLE variants
  ADD COLUMN IF NOT EXISTS country_of_origin VARCHAR(2),
  ADD COLUMN IF NOT EXISTS hs_code VARCHAR(20);

COMMENT ON COLUMN products.country_of_origin IS 'ISO 3166-1 alpha-2 country code, e.g. SE, CN, IN';
COMMENT ON COLUMN products.hs_code IS 'Harmonized System tariff code for customs';
COMMENT ON COLUMN variants.country_of_origin IS 'Overrides product-level country_of_origin if set';
COMMENT ON COLUMN variants.hs_code IS 'Overrides product-level hs_code if set';
