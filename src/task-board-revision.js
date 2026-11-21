// The revision changes in the same SQLite transaction as the task data it describes.
const tableSql = "CREATE TABLE IF NOT EXISTS board_task_revision (id INTEGER PRIMARY KEY CHECK (id=1), revision TEXT NOT NULL)";
const seedSql = "INSERT OR IGNORE INTO board_task_revision (id,revision) VALUES (1,lower(hex(randomblob(16))))";
const taskTables = [
  'tasks', 'task_plans', 'task_workflows', 'challenges', 'supplements',
  'debate_messages', 'active_debate_messages', 'events', 'work_outcomes',
  'work_deliveries', 'work_issues', 'work_subtasks', 'work_reviews',
  'principals', 'principal_labels',
];
const triggerSql = taskTables.flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(action =>
  `CREATE TRIGGER IF NOT EXISTS board_revision_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN UPDATE board_task_revision SET revision=lower(hex(randomblob(16))) WHERE id=1; END`
));

export async function initBoardTaskRevision(db) {
  const statements = [tableSql, ...triggerSql, seedSql];
  if (db.batch) await db.batch(statements.map(sql => db.prepare(sql)));
  else for (const sql of statements) await db.exec(sql);
}

export async function readBoardTaskRevision(db) {
  try {
    const row = await db.prepare('SELECT revision FROM board_task_revision WHERE id=1').first();
    return row?.revision ?? null;
  } catch (error) {
    if (!/no such table:\s*(?:main\.)?board_task_revision\b/i.test(String(error?.message))) throw error;
    return null;
  }
}
