-- 003_budgets.sql
-- Budget per dompet (bukan per kategori) — disederhanakan dari flow kategori
CREATE TABLE IF NOT EXISTS budgets (
  scope   TEXT PRIMARY KEY,      -- 'keluarga' | 'pribadi'
  amount  INTEGER NOT NULL
);
