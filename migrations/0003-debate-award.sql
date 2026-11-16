-- One debate bonus per Agent per claimed task. Existing events are unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS events_debate_once ON events(agent, task_id) WHERE type='debate';
