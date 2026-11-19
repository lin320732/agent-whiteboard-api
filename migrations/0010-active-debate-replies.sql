-- Remove the old Agent-wide time-window constraint without changing message IDs or legacy poll slots.
-- Run after 0008-active-debate.sql; repeating this migration preserves existing rows.
CREATE TABLE IF NOT EXISTS active_debate_messages_unlimited (
  message_id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  content_key TEXT NOT NULL,
  base_message_id INTEGER NOT NULL,
  poll_slot INTEGER,
  UNIQUE(task_id, author_id, content_key)
);
INSERT OR IGNORE INTO active_debate_messages_unlimited (message_id, task_id, author_id, content_key, base_message_id, poll_slot)
  SELECT message_id, task_id, author_id, content_key, base_message_id, poll_slot FROM active_debate_messages;
DROP TABLE active_debate_messages;
ALTER TABLE active_debate_messages_unlimited RENAME TO active_debate_messages;
CREATE INDEX IF NOT EXISTS active_debate_task ON active_debate_messages(task_id, message_id);
