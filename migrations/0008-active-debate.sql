-- Stable authors, duplicate protection and one Agent message per ten-minute poll window.
CREATE TABLE IF NOT EXISTS active_debate_messages (message_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_id INTEGER NOT NULL, content_key TEXT NOT NULL, base_message_id INTEGER NOT NULL, poll_slot INTEGER, UNIQUE(task_id,author_id,content_key), UNIQUE(author_id,poll_slot));
CREATE INDEX IF NOT EXISTS active_debate_task ON active_debate_messages(task_id,message_id);
