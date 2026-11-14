-- D1 建表（v0.2.0 專家團模式；wrangler 會在第一次請求時自動建，手工建也可以）：
-- wrangler d1 execute agent-whiteboard --file=./schema.sql
--
-- 已有庫升級（v0.1 -> v0.2）：放心直接跑這個文件，不會丟數據、不會刪表。
--  - 全部 CREATE 都帶 IF NOT EXISTS，已有的表不會被重建，裡面的任務/頻道/討論都在。
--  - tasks 表的兩個新欄位（claimed_role、proposed_by）用 ALTER 追加，放在文件最後；
--    如果 Worker 第一次請求時已經自動遷移過，ALTER 會報 "duplicate column name"，
--    那是預期的，可以忽略，CREATE 的部分在它之前已經執行完了。
--  - status 現在可以是 open / in_progress / review / done / proposed / closed，
--    status 欄位本身是 TEXT，沒有 CHECK 約束，所以舊表不用改。
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  topic TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER,
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  deadline TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  claimed_by TEXT,
  claimed_role TEXT,
  proposed_by TEXT DEFAULT '',
  result_summary TEXT DEFAULT '',
  result_links TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER,
  author TEXT NOT NULL,
  role TEXT DEFAULT 'agent',
  text TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS supplements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  summary TEXT NOT NULL,
  links TEXT DEFAULT '',
  version INTEGER NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  type TEXT NOT NULL,
  task_id INTEGER,
  points INTEGER NOT NULL,
  created_at TEXT
);

-- 已有庫升級用（新庫不需要這兩行；已遷移過會報 duplicate column，可忽略）：
ALTER TABLE tasks ADD COLUMN claimed_role TEXT;
ALTER TABLE tasks ADD COLUMN proposed_by TEXT DEFAULT '';
