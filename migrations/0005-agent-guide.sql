-- Additive revisions of administrator guidance; existing business data is untouched.
CREATE TABLE IF NOT EXISTS agent_guide_revisions (id INTEGER PRIMARY KEY, instructions TEXT NOT NULL, author_id INTEGER NOT NULL, created_at TEXT NOT NULL);
