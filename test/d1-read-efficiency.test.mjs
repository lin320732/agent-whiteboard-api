import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './helpers.mjs';

const indexes = [
  'challenges_task', 'supplements_task', 'events_task_type_agent',
  'debate_messages_task', 'messages_channel', 'work_subtasks_task',
  'work_subtask_events_task', 'work_activity_task',
];

test('read index migration replaces task scans and preserves stored records', async () => {
  const f = await fixture();
  const db = f.DB.sqlite;
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const principals = db.prepare('SELECT * FROM principals ORDER BY id').all();
  for (const name of indexes) db.exec(`DROP INDEX ${name}`);
  const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join(' ');
  assert.match(plan('SELECT agent FROM events WHERE task_id=? AND type IN (?,?)', 1, 'claim', 'result'), /SCAN events/);
  assert.match(plan('SELECT * FROM debate_messages WHERE task_id=? ORDER BY id', 1), /SCAN debate_messages/);

  const migration = readFileSync(new URL('../migrations/0011-d1-read-indexes.sql', import.meta.url), 'utf8');
  db.exec(migration);
  db.exec(migration);
  for (const [table, sql, args] of [
    ['events', 'SELECT agent FROM events WHERE task_id=? AND type IN (?,?)', [1, 'claim', 'result']],
    ['debate_messages', 'SELECT * FROM debate_messages WHERE task_id=? ORDER BY id', [1]],
    ['challenges', 'SELECT * FROM challenges WHERE task_id=? ORDER BY id', [1]],
    ['supplements', 'SELECT * FROM supplements WHERE task_id=? ORDER BY id', [1]],
    ['work_subtasks', 'SELECT * FROM work_subtasks WHERE task_id=? ORDER BY id', [1]],
    ['work_subtask_events', 'SELECT * FROM work_subtask_events WHERE task_id=? ORDER BY id', [1]],
    ['messages', 'SELECT * FROM messages WHERE channel_id=? ORDER BY id', [1]],
  ]) assert.match(plan(sql, ...args), new RegExp(`SEARCH ${table} USING`), table);
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), tasks);
  assert.deepEqual(db.prepare('SELECT * FROM principals ORDER BY id').all(), principals);
});

test('list and inbox reuse people, and Agent list skips completed task contexts', async () => {
  const f = await fixture();
  f.DB.sqlite.exec("UPDATE tasks SET status='done' WHERE id=1");
  const prepare = f.DB.prepare.bind(f.DB);
  let statements = [];
  f.DB.prepare = sql => { statements.push(sql); return prepare(sql); };
  const peopleReads = () => statements.filter(sql => /SELECT p\.id,p\.name AS actor.*FROM principals p LEFT JOIN principal_labels/.test(sql)).length;
  const planReads = () => statements.filter(sql => /SELECT \* FROM task_plans WHERE task_id=\?/.test(sql)).length;

  const list = await f.request('GET', '/api/tasks?needs=agent', undefined, f.host.auth);
  assert.equal(list.status, 200);
  assert.equal(list.data.tasks.some(task => task.id === 1), false);
  assert.equal(peopleReads(), 1);
  assert.equal(planReads(), 2);
  assert.equal(statements.some(sql => /SELECT \* FROM tasks WHERE id=\?/.test(sql)), false);

  statements = [];
  const inbox = await f.request('GET', '/api/inbox', undefined, f.host.auth);
  assert.equal(inbox.status, 200);
  assert.equal(peopleReads(), 1);
  assert.equal(planReads(), 2);
});
