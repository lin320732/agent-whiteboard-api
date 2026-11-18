-- Speed up task-scoped reads used by the board and Agent polling.
-- Safe to run more than once; existing rows and identities are unchanged.
CREATE INDEX IF NOT EXISTS challenges_task ON challenges(task_id);
CREATE INDEX IF NOT EXISTS supplements_task ON supplements(task_id);
CREATE INDEX IF NOT EXISTS events_task_type_agent ON events(task_id, type, agent);
CREATE INDEX IF NOT EXISTS debate_messages_task ON debate_messages(task_id);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id);
CREATE INDEX IF NOT EXISTS work_subtasks_task ON work_subtasks(task_id);
CREATE INDEX IF NOT EXISTS work_subtask_events_task ON work_subtask_events(task_id);
CREATE INDEX IF NOT EXISTS work_activity_task ON work_activity(task_id);
