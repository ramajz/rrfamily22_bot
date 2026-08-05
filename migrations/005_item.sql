-- 005_item.sql
-- Kolom item untuk deteksi nama produk/merk (fitur cek harga)
ALTER TABLE transactions ADD COLUMN item TEXT;
