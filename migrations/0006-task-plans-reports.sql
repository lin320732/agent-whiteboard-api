-- Independent goals, acceptance, execution schedules and versioned external reports.
CREATE TABLE IF NOT EXISTS task_plans (task_id INTEGER PRIMARY KEY, goal TEXT NOT NULL, collaboration TEXT NOT NULL, acceptance_json TEXT NOT NULL, schedule_json TEXT NOT NULL, delivery_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_deliveries (outcome_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, base_outcome_id INTEGER NOT NULL, report_json TEXT NOT NULL DEFAULT 'null', UNIQUE(task_id,base_outcome_id));
CREATE TABLE IF NOT EXISTS task_recurrences (previous_task_id INTEGER PRIMARY KEY, next_task_id INTEGER NOT NULL UNIQUE);
CREATE INDEX IF NOT EXISTS work_deliveries_task ON work_deliveries(task_id);
