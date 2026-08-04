-- 002_pending_input.sql
CREATE TABLE IF NOT EXISTS pending_input (
  telegram_id INTEGER PRIMARY KEY,
  action      TEXT NOT NULL,      -- 'set_budget'
  scope       TEXT,
  category    TEXT,
  updated_at  TEXT DEFAULT (datetime('now'))
);
