-- 006_categories_index.sql
-- Speed up category lookup by wallet and transaction type.
CREATE INDEX IF NOT EXISTS idx_categories_scope_type
ON categories(scope, type);
