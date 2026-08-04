-- 004_struk_data.sql
-- Tambah kolom data untuk konfirmasi struk (JSON hasil parse)
ALTER TABLE pending_input ADD COLUMN data TEXT;
