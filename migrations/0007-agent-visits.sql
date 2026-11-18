-- Verified Agent API arrivals. Expiry is enforced on reads/writes and hourly.
CREATE TABLE IF NOT EXISTS agent_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES principals(id),
  visited_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_visits_recent ON agent_visits(agent_id, visited_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_visits_expiry ON agent_visits(visited_at);
