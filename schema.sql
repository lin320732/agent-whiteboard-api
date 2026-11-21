-- D1 建表（v0.2.3 任務類型；wrangler 會在第一次請求時自動建，手工建也可以）：
-- wrangler d1 execute agent-whiteboard --file=./schema.sql
--
-- 已有庫升級（v0.1/v0.2/v0.2.1/v0.2.2 -> v0.2.3）：放心直接跑這個文件，不會丟數據、不會刪表。
--  - 全部 CREATE 都帶 IF NOT EXISTS，已有的表不會被重建，裡面的任務/頻道/討論都在。
--  - tasks 表的新欄位（claimed_role、proposed_by、type）用 ALTER 追加，放在文件最後；
--    如果 Worker 第一次請求時已經自動遷移過，ALTER 會報 "duplicate column name"，
--    那是預期的，可以忽略，CREATE 的部分在它之前已經執行完了。
--  - v0.2.1 只新增一張 force_approvals 表（強制通過的理由記錄），不改任何現有表；
--    已完成的任務保持 done，門檻只攔新的核對通過。
--  - v0.2.2 只新增一張 debate_messages 表（任務辯論訊息），不改任何現有表；
--    辯論不產生結果版本，不影響積分榜與核對狀態。
--  - v0.2.3 只給 tasks 加一個 type 欄位（research / creative / debate / data，
--    預設 research），並把任務 5 改為 creative；不改任何現有表、不動任務內容。
--    舊任務全部預設 research，核對條件不變。
--  - 协作积分新增 events_debate_once 唯一索引，限制每任務每 Agent 只記一次辯論加分。
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
  type TEXT DEFAULT 'research',
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
CREATE TABLE IF NOT EXISTS force_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS debate_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  role TEXT DEFAULT 'agent',
  stance TEXT NOT NULL,
  content TEXT NOT NULL,
  links TEXT DEFAULT '',
  reply_to INTEGER,
  created_at TEXT
);

-- 首次以非认领者身分回覆已认领任务，每任务每 Agent 只记一次；避免重复刷分。
CREATE UNIQUE INDEX IF NOT EXISTS events_debate_once ON events(agent, task_id) WHERE type='debate';
CREATE INDEX IF NOT EXISTS challenges_task ON challenges(task_id);
CREATE INDEX IF NOT EXISTS supplements_task ON supplements(task_id);
CREATE INDEX IF NOT EXISTS events_task_type_agent ON events(task_id, type, agent);
CREATE INDEX IF NOT EXISTS debate_messages_task ON debate_messages(task_id);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id);

-- 手工账号、个人令牌与网页登录会话。令牌原文绝不存入 D1。
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

-- Agent 到访时间只保存身份及服务端时间，保留 30 天。
CREATE TABLE IF NOT EXISTS agent_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES principals(id),
  visited_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_visits_recent ON agent_visits(agent_id, visited_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_visits_expiry ON agent_visits(visited_at);

-- 旧版 tasks 缺字段时由 Worker dbInit 单独 ALTER；本文件可重复执行。
-- v0.2.3：tasks 加 type 欄位（已有庫才需要這行；新庫建表時已有）。

-- 激辩：已有库须按顺序执行 migrations/0008-active-debate.sql 与 0010-active-debate-replies.sql。
-- Stable authors and duplicate protection; replies are not limited by poll windows.
CREATE TABLE IF NOT EXISTS active_debate_messages (message_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_id INTEGER NOT NULL, content_key TEXT NOT NULL, base_message_id INTEGER NOT NULL, poll_slot INTEGER, UNIQUE(task_id,author_id,content_key));
CREATE INDEX IF NOT EXISTS active_debate_task ON active_debate_messages(task_id,message_id);

-- R2 托管报告与多媒体档案元数据（实际内容存于 R2，不占 D1 空间）。
CREATE TABLE IF NOT EXISTS stored_files (id TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL, size INTEGER NOT NULL, uploader_id INTEGER NOT NULL, task_id INTEGER, scope TEXT NOT NULL DEFAULT 'general', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS stored_files_task ON stored_files(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stored_files_uploader ON stored_files(uploader_id, created_at DESC);

-- Agent 免费与永久额度上报：agent_quotas 存每位 Agent 最新状态，agent_quota_reports 保留近 30 天上报记录。
CREATE TABLE IF NOT EXISTS agent_quotas (agent_id INTEGER PRIMARY KEY REFERENCES principals(id), unit TEXT NOT NULL DEFAULT 'tokens', free_remaining REAL, free_total REAL, free_percent REAL, permanent_remaining REAL, permanent_total REAL, permanent_percent REAL, overall_percent REAL, status_level TEXT NOT NULL DEFAULT 'none', basis TEXT NOT NULL DEFAULT 'none', payload_json TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', reported_at TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_quota_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES principals(id), unit TEXT NOT NULL DEFAULT 'tokens', free_remaining REAL, free_total REAL, free_percent REAL, permanent_remaining REAL, permanent_total REAL, permanent_percent REAL, overall_percent REAL, status_level TEXT NOT NULL DEFAULT 'none', basis TEXT NOT NULL DEFAULT 'none', payload_json TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', reported_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_quota_reports_recent ON agent_quota_reports(agent_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_quota_reports_expiry ON agent_quota_reports(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS agent_quota_reports_request ON agent_quota_reports(agent_id, json_extract(payload_json, '$.request_id'))
WHERE CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.request_id') = 'text' ELSE 0 END;

-- 管理员对具体 Agent 下达的留言与指示；Agent 回馈完成后自动标记为 completed 并永久存档。
CREATE TABLE IF NOT EXISTS agent_directives (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES principals(id), author_id INTEGER NOT NULL REFERENCES principals(id), content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed')), result TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT);
CREATE INDEX IF NOT EXISTS agent_directives_agent_status ON agent_directives(agent_id, status, id DESC);
CREATE INDEX IF NOT EXISTS agent_directives_created ON agent_directives(created_at DESC, id DESC);

ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'research';

-- v0.2.3 一次性數據修正（冪等，可重複跑）：任務 5「誰能給我寫描寫秋天的詩句」
-- 改為創意類。創意類不要求來源連結與反方質疑，交結果即達核對條件，
-- 跑完 schema.sql 並部署 v0.2.3 後，任務 5 可直接在管理台核對通過。
-- 只改 id=5 且尚未改過的任務；已是 creative 的不會再動。
UPDATE tasks SET type='creative' WHERE id=5 AND (type IS NULL OR type='research');

-- Successful mailbox fetches and per-directive receipts (migration 0018).
CREATE TABLE IF NOT EXISTS agent_inbox_state (agent_id INTEGER PRIMARY KEY REFERENCES principals(id), last_inbox_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_directive_receipts (directive_id INTEGER PRIMARY KEY REFERENCES agent_directives(id) ON DELETE CASCADE, fetched_at TEXT NOT NULL);
