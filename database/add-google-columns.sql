-- Add individual Google Shopping columns to products table
-- Run this in Supabase SQL Editor

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS google_product_category VARCHAR(500),
  ADD COLUMN IF NOT EXISTS google_gender VARCHAR(50),
  ADD COLUMN IF NOT EXISTS google_age_group VARCHAR(50),
  ADD COLUMN IF NOT EXISTS google_mpn VARCHAR(255),
  ADD COLUMN IF NOT EXISTS google_condition VARCHAR(50),
  ADD COLUMN IF NOT EXISTS google_custom_label_0 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS google_custom_label_1 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS variant_schema VARCHAR(255),
  ADD COLUMN IF NOT EXISTS inventory_policy VARCHAR(50) DEFAULT 'deny';
