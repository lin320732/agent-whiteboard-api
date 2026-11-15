-- Additive upgrade of the existing v0.2.0 D1 database. Existing tasks are untouched.
CREATE TABLE IF NOT EXISTS force_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
  agent TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS debate_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
  agent TEXT NOT NULL, role TEXT DEFAULT 'agent', stance TEXT NOT NULL,
  content TEXT NOT NULL, links TEXT DEFAULT '', reply_to INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS principals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
  role TEXT NOT NULL CHECK(role IN ('admin','publisher','viewer','agent')),
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('publisher','agent')),
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  principal_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
