import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { fixture } from './helpers.mjs';
import { statusLevelFor, recordAgentQuota, readAgentQuota, pruneAgentQuotaReports } from '../src/agent-quotas.js';

const adminQuota = (f, id, auth = f.admin, query = '') => f.request('GET', `/api/admin/agents/${id}/quota${query}`, undefined, auth);

test('60/20 traffic-light grading boundaries are exact', () => {
  assert.equal(statusLevelFor(100, 1000), 'green');
  assert.equal(statusLevelFor(60, 600), 'green');
  assert.equal(statusLevelFor(59.9, 599), 'yellow');
  assert.equal(statusLevelFor(20, 200), 'yellow');
  assert.equal(statusLevelFor(19.9, 199), 'red');
  assert.equal(statusLevelFor(0, 0), 'red');
  assert.equal(statusLevelFor(null, 500), 'green');
  assert.equal(statusLevelFor(null, 0), 'red');
  assert.equal(statusLevelFor(null, null), 'none');
});

test('Unknown quota heartbeat records a channel and reason without reporting zero', async () => {
  const f = await fixture();
  const posted = await f.request('POST', '/api/agent/quota', { read_channel: 'none', reasons: ['daily'] }, f.host.auth);
  assert.equal(posted.status, 200);
  assert.equal(posted.data.quota.basis, 'unknown');
  assert.equal(posted.data.quota.status_level, 'none');
  assert.equal(posted.data.quota.overall_percent, null);
  assert.equal(posted.data.quota.free, null);
  assert.equal(posted.data.quota.permanent, null);
  const detail = await adminQuota(f, f.host.id);
  assert.equal(detail.data.history[0].read_channel, 'none');
  assert.deepEqual(detail.data.history[0].reasons, ['daily']);
  const listing = await f.request('GET', '/api/admin/agents', undefined, f.admin);
  assert.equal(listing.data.accounts.find(row => row.id === f.host.id).quota.basis, 'unknown');

  const temporary = await f.request('POST', '/api/agent/quota', { read_channel: 'api', unknown: true, reasons: ['channel'] }, f.host.auth);
  assert.equal(temporary.status, 200);
  assert.equal(temporary.data.quota.read_channel, 'api');
  assert.equal(temporary.data.quota.basis, 'unknown');
  const contradiction = await f.request('POST', '/api/agent/quota', { read_channel: 'none', free_percent: 0 }, f.host.auth);
  assert.equal(contradiction.status, 400);
});

test('Concurrent quota retries share a report id and an old replay cannot replace a newer snapshot', async () => {
  const f = await fixture();
  const body = { request_id: 'test-retry-12345678', free_percent: 25, read_channel: 'manual', reasons: ['threshold'] };
  const now = new Date();
  const [submitted, retried] = await Promise.all([
    recordAgentQuota(f.DB, f.host, body, now),
    recordAgentQuota(f.DB, f.host, body, now),
  ]);
  assert.equal(submitted.report_id, retried.report_id);
  const latest = await recordAgentQuota(f.DB, f.host, { ...body, request_id: 'next-report-12345678', free_percent: 10 }, now);
  assert.equal((await recordAgentQuota(f.DB, f.host, body, now)).report_id, submitted.report_id);
  const self = await readAgentQuota(f.DB, f.host.id, { now });
  assert.equal(self.quota.free.percent, 10);
  assert.deepEqual(self.history.map(row => row.id), [latest.report_id, submitted.report_id]);
  const differentAgent = await recordAgentQuota(f.DB, f.worker, body, now);
  assert.notEqual(differentAgent.report_id, submitted.report_id);
});

test('percent, reset date, permanent balance and report date survive reporting, summaries and history', async () => {
  const f = await fixture();
  const body = {
    unit: '积分',
    reported_at: '2026-11-21T10:00:00+08:00',
    free: { percent: 0, reset_at: '2026-11-25T15:00:00+08:00' },
    permanent: { remaining: 185000, unit: 'tokens' },
  };
  const posted = await f.request('POST', '/api/agent/quota', body, f.host.auth);
  assert.equal(posted.status, 200);
  const list = await f.request('GET', '/api/admin/agents', undefined, f.admin);
  const summary = list.data.accounts.find(agent => agent.id === f.host.id).quota;
  const detail = await adminQuota(f, f.host.id);
  for (const quota of [posted.data.quota, summary, detail.data.quota]) {
    assert.equal(quota.free.percent, 0);
    assert.equal(quota.free.reset_at, body.free.reset_at);
    assert.equal(quota.reset_at, body.free.reset_at);
    assert.equal(quota.permanent.remaining, 185000);
    assert.equal(quota.permanent.unit, 'tokens');
    assert.equal(quota.reported_at, '2026-11-21T02:00:00.000Z');
  }
  const history = detail.data.history[0];
  assert.equal(history.free_percent, 0);
  assert.equal(history.reset_at, body.free.reset_at);
  assert.equal(history.permanent_remaining, 185000);
  assert.equal(history.free_unit, '积分');
  assert.equal(history.permanent_unit, 'tokens');
  assert.equal(history.reported_at, '2026-11-21T02:00:00.000Z');
});

test('missing report dates use receipt time and total-only reports retain their reset date', async () => {
  const f = await fixture();
  const now = new Date();
  const resetAt = '2026-11-25T15:00:00+08:00';
  const saved = await recordAgentQuota(f.DB, f.host, { percent: 45, reset_at: resetAt }, now);
  assert.equal(saved.quota.reported_at, now.toISOString());
  assert.equal(saved.quota.updated_at, now.toISOString());
  const detail = await readAgentQuota(f.DB, f.host.id, { now });
  assert.equal(detail.quota.reset_at, resetAt);
  assert.equal(detail.history[0].reset_at, resetAt);
  assert.equal(detail.history[0].reported_at, now.toISOString());

  // Older clients did not always supply reported_at or a top-level reset date.
  const legacyPayload = JSON.stringify({ free: { percent: 45, reset_at: '每周三 15:00' }, reported_at: null });
  f.DB.sqlite.prepare('UPDATE agent_quotas SET payload_json=?, reported_at=NULL WHERE agent_id=?').run(legacyPayload, f.host.id);
  f.DB.sqlite.prepare('UPDATE agent_quota_reports SET payload_json=?, reported_at=NULL WHERE agent_id=?').run(legacyPayload, f.host.id);
  const legacy = await readAgentQuota(f.DB, f.host.id, { now });
  const listing = await f.request('GET', '/api/admin/agents', undefined, f.admin);
  const summary = listing.data.accounts.find(agent => agent.id === f.host.id).quota;
  for (const quota of [legacy.quota, legacy.history[0], summary]) {
    assert.equal(quota.reported_at, now.toISOString());
    assert.equal(quota.reset_at, '每周三 15:00');
  }
});

test('Agent uploads detailed free & permanent quotas with items, auto-summation, and appears in admin list & detail', async () => {
  const f = await fixture();
  const payload = {
    unit: '积分',
    source: 'muse-billing',
    note: '每日凌晨刷新免费额度',
    free: {
      reset_at: '2026-11-21T00:00:00+08:00',
      items: [
        { name: '每日免费积分', remaining: 400, total: 500, reset_at: '每日 00:00', note: '次日重置' },
        { name: '本月赠送积分', remaining: 250, total: 500, expires_at: '2026-11-30T23:59:59+08:00' },
      ],
    },
    permanent: {
      note: '账户永久积分，永不过期',
      items: [
        { name: '充值永久包', remaining: 3000, total: 4000 },
        { name: '活动奖励永久积分', remaining: 500, total: 1000 },
      ],
    },
  };
  const posted = await f.request('POST', '/api/agent/quota', payload, f.host.auth);
  assert.equal(posted.status, 200);
  assert.equal(posted.data.ok, true);
  assert.equal(posted.data.agent_id, f.host.id);
  const q = posted.data.quota;
  // Auto-summed buckets: free 650/1000 (65%), permanent 3500/5000 (70%), combined 4150/6000 (69.2%)
  assert.equal(q.free.remaining, 650);
  assert.equal(q.free.total, 1000);
  assert.equal(q.free.used, 350);
  assert.equal(q.free.percent, 65);
  assert.equal(q.free.status_level, 'green');
  assert.equal(q.free.items.length, 2);
  assert.equal(q.free.items[0].status_level, 'green'); // 80%
  assert.equal(q.free.items[1].status_level, 'yellow'); // 50% (< 60%)
  assert.equal(q.permanent.remaining, 3500);
  assert.equal(q.permanent.total, 5000);
  assert.equal(q.permanent.percent, 70);
  assert.equal(q.permanent.status_level, 'green');
  assert.equal(q.overall_percent, 69.2);
  assert.equal(q.basis, 'combined');
  assert.equal(q.status_level, 'green');

  // Agent can read back its own quota
  const selfRead = await f.request('GET', '/api/agent/quota?history=1', undefined, f.host.auth);
  assert.equal(selfRead.status, 200);
  assert.equal(selfRead.data.quota.free.remaining, 650);
  assert.equal(selfRead.data.history.length, 1);

  // Uploading quota also counts as a verified Agent API arrival
  const visits = await f.request('GET', `/api/admin/agents/${f.host.id}/visits`, undefined, f.admin);
  assert.equal(visits.data.visits.length, 2);

  // Admin list returns compact summary without extra per-agent queries
  const prepare = f.DB.prepare.bind(f.DB);
  const sqls = [];
  f.DB.prepare = sql => { sqls.push(sql); return prepare(sql); };
  const listRes = await f.request('GET', '/api/admin/agents', undefined, f.admin);
  f.DB.prepare = prepare;
  assert.equal(listRes.status, 200);
  const hostSummary = listRes.data.accounts.find(a => a.id === f.host.id);
  const workerSummary = listRes.data.accounts.find(a => a.id === f.worker.id);
  assert.equal(hostSummary.quota.overall_percent, 69.2);
  assert.equal(hostSummary.quota.status_level, 'green');
  assert.equal(hostSummary.quota.free.items_count, 2);
  assert.equal(hostSummary.quota.permanent.items_count, 2);
  assert.equal(workerSummary.quota, null);
  assert.equal(sqls.filter(s => /FROM agent_quotas\b/.test(s)).length, 0, 'Agent list joins agent_quotas in one query');

  // Admin detail returns full items + history
  const detailRes = await adminQuota(f, f.host.id);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.data.quota.free.items[0].name, '每日免费积分');
  assert.equal(detailRes.data.quota.permanent.items[1].name, '活动奖励永久积分');
  assert.equal(detailRes.data.history.length, 1);
});

test('shorthand aliases, PUT, balance-only permanent, yellow/red thresholds work cleanly', async () => {
  const f = await fixture();
  // Shorthand flat fields: free 450/1000 (45% -> yellow), permanent 2000 (no total) -> basis='free', 45% yellow
  const r1 = await f.request('PUT', '/api/agent/quota', {
    free_remaining: 450,
    free_total: 1000,
    permanent_remaining: 2000,
    unit: '次',
    note: '午间上报',
  }, f.worker.auth);
  assert.equal(r1.status, 200);
  assert.equal(r1.data.quota.overall_percent, 45);
  assert.equal(r1.data.quota.basis, 'free');
  assert.equal(r1.data.quota.status_level, 'yellow');
  assert.equal(r1.data.quota.permanent.remaining, 2000);
  assert.equal(r1.data.quota.permanent.total, null);
  assert.equal(r1.data.quota.permanent.percent, null);

  // Used + total derivation -> 150/1000 (15% -> red)
  const r2 = await f.request('POST', '/api/agent/quota', {
    free: { used: 850, total: 1000 },
    permanent: 0,
  }, f.worker.auth);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.quota.free.remaining, 150);
  assert.equal(r2.data.quota.free.percent, 15);
  assert.equal(r2.data.quota.overall_percent, 15);
  assert.equal(r2.data.quota.status_level, 'red');

  // Balance-only with positive permanent -> green, overall_percent null
  const r3 = await f.request('POST', '/api/agent/quota', { permanent: 1200 }, f.checker.auth);
  assert.equal(r3.status, 200);
  assert.equal(r3.data.quota.overall_percent, null);
  assert.equal(r3.data.quota.basis, 'balance');
  assert.equal(r3.data.quota.status_level, 'green');

  // Balance-only with 0 -> red, overall_percent 0
  const r4 = await f.request('POST', '/api/agent/quota', { free: 0, permanent: 0 }, f.checker.auth);
  assert.equal(r4.status, 200);
  assert.equal(r4.data.quota.overall_percent, 0);
  assert.equal(r4.data.quota.status_level, 'red');
});

test('percent-only uploads (Muse mode): percent, used_percent, % strings, percent-only items, and top-level percent', async () => {
  const f = await fixture();
  // 1) Muse reports percent-only free + permanent with sub-items and % string
  const r1 = await f.request('POST', '/api/agent/quota', {
    free: {
      reset_at: '每日 00:00',
      items: [
        { name: '每日免费额度', percent: '80%' },
        { name: '本月赠送额度', used_percent: '40%' },
      ],
    },
    permanent: {
      items: [{ name: '账户永久额度', percent: 40 }],
    },
    note: 'Muse 仅百分比上报',
  }, f.host.auth);
  assert.equal(r1.status, 200);
  const q1 = r1.data.quota;
  assert.equal(q1.free.remaining, null);
  assert.equal(q1.free.total, null);
  assert.equal(q1.free.percent, 70); // average of 80% and 60%
  assert.equal(q1.free.used_percent, 30);
  assert.equal(q1.free.status_level, 'green');
  assert.equal(q1.free.items[0].percent, 80);
  assert.equal(q1.free.items[1].percent, 60);
  assert.equal(q1.free.items[1].used_percent, 40);
  assert.equal(q1.permanent.percent, 40);
  assert.equal(q1.permanent.used_percent, 60);
  assert.equal(q1.permanent.status_level, 'yellow');
  assert.equal(q1.overall_percent, 70);
  assert.equal(q1.basis, 'free');

  // 2) Shorthand percent strings: free: "75%", permanent: "15%"
  const r2 = await f.request('POST', '/api/agent/quota', {
    free: '75%',
    permanent: '15%',
  }, f.worker.auth);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.quota.free.percent, 75);
  assert.equal(r2.data.quota.free.status_level, 'green');
  assert.equal(r2.data.quota.permanent.percent, 15);
  assert.equal(r2.data.quota.permanent.status_level, 'red');

  // 3) Flat used_percent shorthand
  const r3 = await f.request('POST', '/api/agent/quota', {
    free_used_percent: 82,
    permanent_percent: '65%',
  }, f.worker.auth);
  assert.equal(r3.status, 200);
  assert.equal(r3.data.quota.free.percent, 18);
  assert.equal(r3.data.quota.free.status_level, 'red');
  assert.equal(r3.data.quota.permanent.percent, 65);
  assert.equal(r3.data.quota.permanent.status_level, 'green');

  // 4) Top-level single percent only (when Agent cannot even distinguish free vs permanent)
  const r4 = await f.request('POST', '/api/agent/quota', { percent: '62.5%', note: '仅读到总百分比' }, f.checker.auth);
  assert.equal(r4.status, 200);
  assert.equal(r4.data.quota.overall_percent, 62.5);
  assert.equal(r4.data.quota.basis, 'reported');
  assert.equal(r4.data.quota.status_level, 'green');
  assert.equal(r4.data.quota.free, null);
  assert.equal(r4.data.quota.permanent, null);

  // 5) Real Muse hybrid mode: free is percentage-only + permanent is concrete token count (default unit: tokens)
  const r5 = await f.request('POST', '/api/agent/quota', {
    free: { percent: 75, reset_at: '每日 00:00' },
    permanent: {
      note: '平台赠送永久额度',
      items: [
        { name: '注册赠送永久额度', tokens: 150000 },
        { name: '活动奖励永久额度', tokens: 35000 },
      ],
    },
  }, f.host.auth);
  assert.equal(r5.status, 200);
  const q5 = r5.data.quota;
  assert.equal(q5.unit, 'tokens');
  assert.equal(q5.free.percent, 75);
  assert.equal(q5.free.remaining, null);
  assert.equal(q5.free.status_level, 'green');
  assert.equal(q5.permanent.remaining, 185000);
  assert.equal(q5.permanent.unit, 'tokens');
  assert.equal(q5.permanent.total, null);
  assert.equal(q5.permanent.percent, null);
  assert.equal(q5.permanent.status_level, 'green');
  assert.equal(q5.overall_percent, 75);
  assert.equal(q5.basis, 'free');

  // Flat shorthand for Muse hybrid: free_percent + permanent_tokens
  const r6 = await f.request('POST', '/api/agent/quota', {
    free_percent: 45,
    permanent_tokens: 185000,
  }, f.worker.auth);
  assert.equal(r6.status, 200);
  assert.equal(r6.data.quota.free.percent, 45);
  assert.equal(r6.data.quota.free.status_level, 'yellow');
  assert.equal(r6.data.quota.permanent.remaining, 185000);
  assert.equal(r6.data.quota.permanent.unit, 'tokens');
  assert.equal(r6.data.quota.overall_percent, 45);
});

test('strict auth, spoofing prevention, validation errors, and disabled agent history retention', async () => {
  const f = await fixture();
  const sample = { free: { remaining: 700, total: 1000 } };

  // Unauthorized / forbidden callers cannot post or read /api/agent/quota
  assert.equal((await f.request('POST', '/api/agent/quota', sample, {})).status, 401);
  assert.equal((await f.request('GET', '/api/agent/quota', undefined, {})).status, 401);
  assert.equal((await f.request('POST', '/api/agent/quota', sample, f.admin)).status, 403);
  assert.equal((await f.request('POST', '/api/agent/quota', sample, { Authorization: 'Bearer test-legacy' })).status, 403);
  const pub = await f.request('POST', '/api/admin/users', { username: 'pub1', name: 'Publisher', role: 'publisher' }, f.admin);
  assert.equal((await f.request('POST', '/api/agent/quota', sample, { Authorization: `Bearer ${pub.data.muse_token}` })).status, 403);
  assert.equal((await f.request('DELETE', '/api/agent/quota', undefined, f.host.auth)).status, 405);

  // Agent cannot spoof another agent_id
  const spoof = await f.request('POST', '/api/agent/quota', { agent_id: f.worker.id, free: { remaining: 800, total: 1000 } }, f.host.auth);
  assert.equal(spoof.status, 200);
  assert.equal(spoof.data.agent_id, f.host.id);
  assert.equal((await adminQuota(f, f.worker.id)).data.quota, null);
  assert.equal((await adminQuota(f, f.host.id)).data.quota.free.remaining, 800);

  // Validation errors
  for (const bad of [
    {},
    { unit: '积分' },
    { free: { remaining: -1, total: 100 } },
    { free: { remaining: 'abc', total: 100 } },
    { free: { percent: 150 } },
    { free: { remaining: 10 }, reported_at: 'not-a-date' },
    { free: { items: [{ remaining: 10 }] } }, // missing name
    { free: { items: Array.from({ length: 31 }, (_, i) => ({ name: `item-${i}`, remaining: 1 })) } },
  ]) {
    assert.equal((await f.request('POST', '/api/agent/quota', bad, f.host.auth)).status, 400);
  }

  // Admin detail access control
  assert.equal((await adminQuota(f, f.host.id, {})).status, 401);
  assert.equal((await adminQuota(f, f.host.id, f.host.auth)).status, 403);
  assert.equal((await adminQuota(f, f.host.id, { Cookie: f.admin.Cookie, Origin: 'https://evil.test' })).status, 200); // GET has no Origin CSRF requirement
  const viewer = await f.request('POST', '/api/admin/users', { username: 'view1', name: 'Viewer', role: 'viewer' }, f.admin);
  const vLogin = await f.request('POST', '/api/auth/login', { username: 'view1', password: viewer.data.password });
  assert.equal((await adminQuota(f, f.host.id, { Cookie: vLogin.cookie.split(';')[0] })).status, 403);
  assert.equal((await adminQuota(f, 99999)).status, 404);
  assert.equal((await adminQuota(f, 1)).status, 404); // human account
  assert.equal((await f.request('POST', `/api/admin/agents/${f.host.id}/quota`, {}, f.admin)).status, 405);

  // Revoked agent cannot upload anymore, but admin can still read its retained quota & history
  await f.request('POST', `/api/admin/agents/${f.host.id}/revoke`, {}, f.admin);
  assert.equal((await f.request('POST', '/api/agent/quota', sample, f.host.auth)).status, 401);
  const retained = await adminQuota(f, f.host.id);
  assert.equal(retained.status, 200);
  assert.equal(retained.data.quota.free.remaining, 800);
  assert.equal(retained.data.history.length, 1);
});

test('history pagination, 30-day retention pruning, cron cleanup, and repeatable migration', async () => {
  const f = await fixture();
  const base = Date.now() - 60_000;
  for (let i = 0; i < 25; i++) {
    await recordAgentQuota(f.DB, { id: f.host.id }, { free: { remaining: 1000 - i * 10, total: 1000 }, permanent: 500 }, new Date(base + i * 1000));
  }
  const page1 = await adminQuota(f, f.host.id);
  assert.equal(page1.status, 200);
  assert.equal(page1.data.history.length, 20);
  assert.ok(page1.data.next_cursor);
  // Insert a newer report between pages: pagination must not duplicate or skip
  await recordAgentQuota(f.DB, { id: f.host.id }, { free: { remaining: 500, total: 1000 } }, new Date(base + 30_000));
  const page2 = await adminQuota(f, f.host.id, f.admin, `?before=${encodeURIComponent(page1.data.next_cursor)}`);
  assert.equal(page2.status, 200);
  assert.equal(page2.data.history.length, 5);
  assert.equal(page2.data.next_cursor, null);
  const ids = [...page1.data.history, ...page2.data.history].map(r => r.id);
  assert.equal(new Set(ids).size, 25);

  // Invalid cursors rejected cleanly
  for (const bad of ['', 'bad', '2026-11-10T00:00:00.000Z,0', '2026-11-10T00:00:00.000Z,1 OR 1=1']) {
    assert.equal((await adminQuota(f, f.host.id, f.admin, `?before=${encodeURIComponent(bad)}`)).status, 400);
  }

  // 30-day pruning via readAgentQuota and scheduled cron
  const oldIso = new Date(Date.now() - 31 * 86400000).toISOString();
  f.DB.sqlite.prepare(`INSERT INTO agent_quota_reports (agent_id, unit, payload_json, created_at) VALUES (?, '积分', '{}', ?)`).run(f.worker.id, oldIso);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_quota_reports WHERE agent_id=?').get(f.worker.id).n, 1);
  await worker.scheduled({}, f.env, {});
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_quota_reports WHERE agent_id=?').get(f.worker.id).n, 0);

  // Explicit pruneAgentQuotaReports boundary
  const now = new Date('2026-11-20T12:00:00.000Z');
  const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  f.DB.sqlite.exec('DELETE FROM agent_quota_reports');
  f.DB.sqlite.prepare(`INSERT INTO agent_quota_reports (agent_id, unit, payload_json, created_at) VALUES (?, '积分', '{}', ?)`).run(f.host.id, '2026-10-21T11:59:59.999Z');
  f.DB.sqlite.prepare(`INSERT INTO agent_quota_reports (agent_id, unit, payload_json, created_at) VALUES (?, '积分', '{}', ?)`).run(f.host.id, cutoff);
  const res = await readAgentQuota(f.DB, f.host.id, { now });
  assert.deepEqual(res.history.map(r => r.created_at), [cutoff]);
  await pruneAgentQuotaReports(f.DB, new Date(now.getTime() + 1));
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_quota_reports').get().n, 0);

  // Query plan uses index (no full table scan)
  const plan = f.DB.sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM agent_quota_reports WHERE agent_id=? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 21')
    .all(f.host.id, cutoff).map(r => r.detail).join(' ');
  assert.match(plan, /SEARCH agent_quota_reports USING INDEX agent_quota_reports_recent/);

  // Repeatable additive migration preserves existing rows
  const tasksBefore = f.DB.sqlite.prepare('SELECT * FROM tasks ORDER BY id').all();
  const sql = readFileSync(new URL('../migrations/0014-agent-quotas.sql', import.meta.url), 'utf8');
  f.DB.sqlite.exec(sql);
  f.DB.sqlite.exec(sql);
  assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM tasks ORDER BY id').all(), tasksBefore);
});
