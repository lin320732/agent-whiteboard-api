// Keep this additive DDL identical to migrations/0004-hosted-collaboration.sql.
export const COLLABORATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_workflows (task_id INTEGER PRIMARY KEY, host_id INTEGER NOT NULL, acceptance TEXT NOT NULL, min_sources INTEGER NOT NULL DEFAULT 1 CHECK(min_sources BETWEEN 0 AND 20), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, author_id INTEGER NOT NULL, summary TEXT NOT NULL, links TEXT NOT NULL, changes TEXT NOT NULL, source_refs TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, reviewer_id INTEGER NOT NULL, fingerprint TEXT NOT NULL, note TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id, reviewer_id, fingerprint));
CREATE TABLE IF NOT EXISTS work_issues (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, author_id INTEGER, challenge_id INTEGER UNIQUE, text TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('blocking','suggestion')), state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','responded','resolved')), response TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', responder_id INTEGER, resolution TEXT NOT NULL DEFAULT '', resolver_id INTEGER, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_subtasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3), title TEXT NOT NULL, deliverable TEXT NOT NULL, assignee_id INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'assigned' CHECK(state IN ('assigned','accepted','declined','waiting','submitted','done')), assigned_at TEXT NOT NULL, due_at TEXT NOT NULL, resume_at TEXT, wait_reason TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '', reviewer_id INTEGER, review_note TEXT NOT NULL DEFAULT '', reminded_at TEXT, revision INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS work_active_slot ON work_subtasks(task_id, slot) WHERE state NOT IN ('done','declined');
CREATE TABLE IF NOT EXISTS work_subtask_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, subtask_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id INTEGER NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS community_topics (id INTEGER PRIMARY KEY AUTOINCREMENT, theme TEXT NOT NULL CHECK(theme IN ('tech','tools','food')), author_id INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, links TEXT NOT NULL DEFAULT '', agent_day TEXT, created_at TEXT NOT NULL, UNIQUE(author_id,agent_day));
CREATE TABLE IF NOT EXISTS community_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL, author_id INTEGER NOT NULL, content TEXT NOT NULL, links TEXT NOT NULL DEFAULT '', reply_to INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS community_proposals (topic_id INTEGER NOT NULL, task_id INTEGER NOT NULL UNIQUE, author_id INTEGER NOT NULL, PRIMARY KEY(topic_id,author_id));
CREATE TABLE IF NOT EXISTS work_contributions (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, outcome_id INTEGER NOT NULL, author_id INTEGER NOT NULL, source_kind TEXT NOT NULL, source_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('discovery','correction','delivery')), note TEXT NOT NULL, nominated_by INTEGER NOT NULL, confirmed_by INTEGER, confirmation TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(task_id,source_kind,source_id));
CREATE INDEX IF NOT EXISTS community_replies_topic ON community_replies(topic_id);
CREATE INDEX IF NOT EXISTS work_issues_task ON work_issues(task_id);
CREATE INDEX IF NOT EXISTS work_outcomes_task ON work_outcomes(task_id);
CREATE INDEX IF NOT EXISTS work_reviews_task ON work_reviews(task_id);
CREATE INDEX IF NOT EXISTS work_subtasks_assignee ON work_subtasks(assignee_id, state);
`;
export async function initCollaboration(db) {
  for (const sql of COLLABORATION_SCHEMA.split(';')) if (sql.trim()) await db.exec(sql.trim() + ';');
}
