-- import_mappings: saves column mapping profiles per supplier for reuse
CREATE TABLE IF NOT EXISTS import_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
    supplier_name VARCHAR(255) NOT NULL,
    headers TEXT[] NOT NULL DEFAULT '{}',
    mapping JSONB NOT NULL DEFAULT '{}',
    group_col VARCHAR(255),
    variant_options JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(store_id, supplier_name)
);

CREATE INDEX IF NOT EXISTS idx_import_mappings_store ON import_mappings(store_id);
