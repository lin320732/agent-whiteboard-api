-- Per-Agent guide instructions. Shared instructions stay in agent_guide_revisions;
-- this table only holds the latest revision history for each Agent principal.
CREATE TABLE IF NOT EXISTS agent_guide_personal_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  instructions TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(principal_id, revision)
);
CREATE INDEX IF NOT EXISTS agent_guide_personal_latest ON agent_guide_personal_revisions(principal_id, revision DESC);
