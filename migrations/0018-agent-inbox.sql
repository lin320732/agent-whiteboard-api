-- Record successful mailbox fetches separately from general API arrivals.
-- No historical reads are inferred. Existing pending directives remain unfetched
-- until the Agent retrieves them after this migration.
CREATE TABLE IF NOT EXISTS agent_inbox_state (agent_id INTEGER PRIMARY KEY REFERENCES principals(id), last_inbox_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_directive_receipts (directive_id INTEGER PRIMARY KEY REFERENCES agent_directives(id) ON DELETE CASCADE, fetched_at TEXT NOT NULL);
