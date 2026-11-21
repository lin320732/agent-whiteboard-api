import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import {fixture} from './helpers.mjs';

function readBoard(f, {etag, auth = f.admin, filters = '', db = f.DB} = {}) {
  const headers = new Headers(auth);
  if (etag) headers.set('If-None-Match', etag);
  return worker.fetch(new Request('https://board.test/api/tasks?view=summary' + filters, {headers}), {...f.env, DB:db}, {});
}

test('unchanged board requests use the revision and session rows even on a fresh binding', async () => {
  const f = await fixture();
  const initial = await readBoard(f);
  assert.equal(initial.status, 200);
  const etag = initial.headers.get('etag');
  assert.ok(etag);
  assert.equal((await initial.json()).tasks.length, 3);
  const statements = [];
  const freshDb = {...f.DB, prepare(sql) {statements.push(sql);return f.DB.prepare(sql);}};
  const unchanged = await readBoard(f, {etag, db:freshDb});
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  assert.equal(unchanged.headers.get('etag'), etag);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /FROM board_task_revision/);
  assert.match(statements[1], /FROM sessions/);
  assert.equal((await readBoard(f, {etag, auth:{}})).status, 401);
  assert.equal((await readBoard(f, {etag, auth:f.host.auth})).status, 403);
  assert.equal((await readBoard(f, {etag, filters:'&status=done'})).status, 200);

  const note = await f.request('POST','/api/messages',{text:'讨论区留言',channelId:1},f.admin);
  assert.equal(note.status, 201);
  assert.equal((await readBoard(f, {etag})).status, 304);
});

test('task and discussion writes invalidate the list, and task details carry the discussion text', async () => {
  const f = await fixture();
  const mig = readFileSync(new URL('../migrations/0015-board-task-revision.sql', import.meta.url), 'utf8');
  f.DB.sqlite.exec(mig);
  const initial = await readBoard(f);
  const etag = initial.headers.get('etag');
  f.DB.sqlite.exec(mig);
  assert.equal((await readBoard(f, {etag})).status, 304, 'reapplying the migration keeps the current revision');
  const taskId = 1, body = '这段完整发言只出现在详情。';
  const statusBefore = f.DB.sqlite.prepare('SELECT updated_at FROM tasks WHERE id=?').get(taskId).updated_at;
  f.DB.sqlite.prepare("INSERT INTO debate_messages(task_id,agent,role,stance,content,created_at) VALUES (?,?,'agent','支持',?,?)")
    .run(taskId, f.host.name, body, new Date().toISOString());
  assert.equal(f.DB.sqlite.prepare('SELECT updated_at FROM tasks WHERE id=?').get(taskId).updated_at,statusBefore);
  const summary = await readBoard(f, {etag});
  assert.equal(summary.status, 200);
  assert.notEqual(summary.headers.get('etag'), etag);
  const text = await summary.text();
  assert.equal(text.includes(body), false);
  assert.equal('detail' in JSON.parse(text).tasks.find(task=>task.id===taskId), false);
  const detail = await f.request('GET','/api/tasks/1',undefined,f.admin);
  assert.equal(detail.data.debate[0].content, body);
  f.DB.sqlite.exec('BEGIN; DELETE FROM debate_messages WHERE task_id=1; ROLLBACK;');
  assert.equal((await readBoard(f, {etag:summary.headers.get('etag')})).status, 304);
});

test('a debate deadline invalidates the board summary even without a write', async t => {
  const f = await fixture();
  const start = Date.now();
  t.mock.method(Date,'now',()=>start);
  const end = start + 60_000;
  const created = await f.request('POST','/api/tasks',{
    title:'讨论截止时间', plan:{goal:'active_debate',schedule:{end_at:new Date(end).toISOString()}},
  },f.admin);
  assert.equal(created.status, 201);
  const taskId = created.data.id;
  const add = f.DB.sqlite.prepare("INSERT INTO debate_messages(task_id,agent,role,stance,content,reply_to,created_at) VALUES (?,?,'agent',?,?,?,?)");
  const post = (who, stance, body, reply = null) => Number(add.run(taskId,who,stance,body,reply,new Date(start).toISOString()).lastInsertRowid);
  for(let i=0;i<3;i++){
    const first=post(f.host.name,'支持','主张');
    const reply=post(f.worker.name,'反駁','反例',first);
    post(f.host.name,'補充','说明',reply);
  }
  const live = await readBoard(f);
  assert.deepEqual((await live.json()).tasks.find(task=>task.id===taskId).discussion,{phase:'active'});
  assert.equal((await readBoard(f,{etag:live.headers.get('etag')})).status,304);
  Date.now.mock.mockImplementation(()=>end+1);
  const expired = await readBoard(f,{etag:live.headers.get('etag')});
  assert.equal(expired.status,200);
  const task = (await expired.json()).tasks.find(task=>task.id===taskId);
  assert.deepEqual(task.discussion,{phase:'ended',participation_sufficient:true});
  assert.equal(task.status,'review');
  assert.equal(f.DB.sqlite.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'open');
  const detail = await f.request('GET',`/api/tasks/${taskId}`,undefined,f.admin);
  assert.equal(detail.data.workflow.discussion.rounds,3);
  assert.equal(detail.data.workflow.discussion.participation_sufficient,true);
});
