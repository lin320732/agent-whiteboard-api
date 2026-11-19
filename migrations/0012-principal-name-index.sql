-- Resolve historical authors by canonical name without scanning every account.
-- Safe to repeat; no identity or task rows are changed.
CREATE INDEX IF NOT EXISTS principals_name_kind ON principals(name,kind);
