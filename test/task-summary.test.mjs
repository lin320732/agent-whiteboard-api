import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { fixture } from './helpers.mjs';

function readBoard(f, { db = f.DB, etag, filters = '' } = {}) {
  return worker.fetch(new Request('https://board.test/api/tasks?view=summary' + filters, {
    headers: { ...f.admin, ...(etag ? { 'If-None-Match': etag } : {}) },
  }), { ...f.env, DB: db }, {});
}

function readOnlyDatabase(f) {
  const stats = { queries: 0, roundTrips: 0, batches: 0 };
  return {
    stats,
    db: {
      prepare(sql) {
        assert.match(sql, /^\s*(?:SELECT|WITH|PRAGMA)\b/i, 'summaries must only read');
        stats.queries++;
        const statement = f.DB.prepare(sql);
        for (const name of ['first', 'all']) {
          const original = statement[name].bind(statement);
          statement[name] = (...args) => { stats.roundTrips++; return original(...args); };
        }
        return statement;
      },
      batch(statements) { stats.batches++; stats.roundTrips++; return f.DB.batch(statements); },
      exec() { assert.fail('a summary must not initialize or migrate the schema'); },
    },
  };
}

test('summary database round trips stay bounded as the task count grows', async () => {
  const f = await fixture();
  await readBoard(f); // Install the revision tracking for this fresh fixture.
  const small = readOnlyDatabase(f);
  assert.equal((await readBoard(f, { db: small.db })).status, 200);
  const insert = f.DB.sqlite.prepare("INSERT INTO tasks(title,status,type) VALUES (?,'open','research')");
  for (let i = 0; i < 120; i++) insert.run(`任务 ${i}`);
  const large = readOnlyDatabase(f);
  const response = await readBoard(f, { db: large.db });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tasks.length, 123);
  assert.equal(large.stats.queries, small.stats.queries, 'no queries per task');
  assert.equal(large.stats.roundTrips, small.stats.roundTrips, 'no network rounds per task');
  assert.ok(large.stats.queries <= 20);
  assert.ok(large.stats.roundTrips <= 4);
  assert.equal(large.stats.batches, 1);
  const filtered = await readBoard(f, { filters: '&channelId=9999&status=review' });
  assert.deepEqual((await filtered.json()).tasks, []);
});

test('summary acceptance follows current report revisions and independent reviews', async () => {
  const f = await fixture(), source = 'https://example.com/source', reportURL = 'https://example.com/report';
  const created = await f.request('POST', '/api/tasks', {
    title: '批量摘要的报告核查',
    plan: { goal: 'analysis', acceptance: { min_sources: 1, independent_review: true }, delivery: { format: 'web_report', author_id: f.worker.id } },
  }, f.admin);
  assert.equal(created.status, 201);
  const id = created.data.id;
  const detail = async () => (await f.request('GET', `/api/tasks/${id}`, undefined, f.admin)).data;
  const publish = async revision => {
    const data = await detail();
    const response = await f.request('POST', `/api/tasks/${id}/outcomes`, {
      summary: `报告 ${revision} 的完整结论`, changes: `发布 ${revision}`, links: [source],
      fingerprint: data.workflow.fingerprint, report: { url: reportURL, revision, title: '报告' },
    }, f.admin);
    assert.equal(response.status, 201, JSON.stringify(response.data));
  };
  await publish('v1');
  let data = await detail();
  const reviewed = await f.request('POST', `/api/tasks/${id}/reviews`, {
    fingerprint: data.workflow.fingerprint, note: '核对网页与官方来源', evidence: [source, reportURL], report_revision: 'v1',
  }, f.checker.auth);
  assert.equal(reviewed.status, 201, JSON.stringify(reviewed.data));
  await f.request('POST', '/api/admin/users/1/name', { name: '改名后的管理员' }, f.admin);
  data = await detail();
  let summary = (await (await readBoard(f)).json()).tasks.find(task => task.id === id);
  assert.equal(summary.verify_readiness.ready, true);
  assert.deepEqual(summary.verify_readiness, data.verify_readiness);
  assert.equal(summary.report.revision, 'v1');
  assert.equal(summary.outcome_preview.author, '改名后的管理员');
  assert.equal(summary.created_by, '改名后的管理员');

  await publish('v2');
  data = await detail();
  summary = (await (await readBoard(f)).json()).tasks.find(task => task.id === id);
  assert.equal(summary.report.revision, 'v2');
  assert.equal(summary.verify_readiness.ready, false, 'old reviews cannot approve a new report');
  assert.deepEqual(summary.verify_readiness, data.verify_readiness);
});

test('summary challenges block acceptance without importing issues or returning their text', async () => {
  const f = await fixture();
  const reason = '只应在详情显示的质疑正文'.repeat(300);
  f.DB.sqlite.prepare('INSERT INTO challenges(task_id,agent,reason,created_at) VALUES (?,?,?,?)')
    .run(1, f.checker.name, reason, new Date().toISOString());
  await readBoard(f);
  const db = readOnlyDatabase(f);
  const before = f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM work_issues').get().n;
  const response = await readBoard(f, { db: db.db });
  const text = await response.text(), task = JSON.parse(text).tasks.find(task => task.id === 1);
  assert.equal(task.verify_readiness.ready, false);
  assert.match(task.collaboration.reason, /质疑/);
  assert.equal(text.includes(reason), false);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM work_issues').get().n, before);
});

test('summary ETags describe the revision of the same snapshot as their tasks', async () => {
  const f = await fixture();
  await readBoard(f);
  let changed = false;
  const concurrentDB = { ...f.DB, batch(statements) {
    if (!changed) {
      f.DB.sqlite.prepare('UPDATE tasks SET title=? WHERE id=1').run('查询期间更新的任务');
      changed = true;
    }
    return f.DB.batch(statements);
  } };
  const response = await readBoard(f, { db: concurrentDB });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tasks.find(task => task.id === 1).title, '查询期间更新的任务');
  assert.equal((await readBoard(f, { etag: response.headers.get('etag') })).status, 304);
});

test('compressed weak ETags and validator lists avoid rebuilding unchanged summaries', async () => {
  const f = await fixture();
  const etag = (await readBoard(f)).headers.get('etag');
  for (const value of [etag, `W/${etag}`, `"other", W/${etag}`, ` W/${etag} , "other"`]) {
    const db = readOnlyDatabase(f);
    const response = await readBoard(f, { etag: value, db: db.db });
    assert.equal(response.status, 304, value);
    assert.equal(await response.text(), '');
    assert.equal(db.stats.queries, 2, 'only the revision and current session are read');
    assert.equal(db.stats.batches, 0);
  }
  assert.equal((await readBoard(f, { etag: `W/${etag}`, filters: '&status=done' })).status, 200);
  f.DB.sqlite.prepare('UPDATE tasks SET title=? WHERE id=1').run('任务已修改');
  assert.equal((await readBoard(f, { etag: `W/${etag}` })).status, 200);
});
