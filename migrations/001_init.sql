-- 001_init.sql
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  name        TEXT,
  scope       TEXT DEFAULT 'keluarga',
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT DEFAULT 'expense',
  budget      INTEGER,
  is_default  INTEGER DEFAULT 0,
  UNIQUE(scope, name)
);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  scope       TEXT NOT NULL,
  type        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  category    TEXT NOT NULL,
  note        TEXT,
  tx_date     TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(scope, tx_date);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, tx_date);

-- Kategori default: Keluarga
INSERT OR IGNORE INTO categories (scope, name, type, is_default) VALUES
  ('keluarga', 'Makan', 'expense', 1),
  ('keluarga', 'Transport', 'expense', 1),
  ('keluarga', 'Kebutuhan', 'expense', 1),
  ('keluarga', 'Cicilan', 'expense', 1),
  ('keluarga', 'Pendidikan', 'expense', 1),
  ('keluarga', 'Kesehatan', 'expense', 1),
  ('keluarga', 'Hiburan', 'expense', 1),
  ('keluarga', 'Lainnya', 'expense', 1),
  ('keluarga', 'Gaji', 'income', 1),
  ('keluarga', 'Side Income', 'income', 1);

-- Kategori default: Pribadi
INSERT OR IGNORE INTO categories (scope, name, type, is_default) VALUES
  ('pribadi', 'Jajan', 'expense', 1),
  ('pribadi', 'Transport', 'expense', 1),
  ('pribadi', 'Invest', 'expense', 1),
  ('pribadi', 'Project', 'expense', 1),
  ('pribadi', 'Lainnya', 'expense', 1),
  ('pribadi', 'Side Income', 'income', 1);
