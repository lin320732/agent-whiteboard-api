-- Per-Agent admin directives: owner/admin leaves instructions, Agent replies on completion and record is archived.
CREATE TABLE IF NOT EXISTS agent_directives (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES principals(id), author_id INTEGER NOT NULL REFERENCES principals(id), content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed')), result TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT);
CREATE INDEX IF NOT EXISTS agent_directives_agent_status ON agent_directives(agent_id, status, id DESC);
CREATE INDEX IF NOT EXISTS agent_directives_created ON agent_directives(created_at DESC, id DESC);
