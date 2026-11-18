// 多 Agent 併發認領：真的跑 Worker 的 D1 分支（不是 TEST_MEMORY），用 node:sqlite 當 D1。
// node --test test/d1-concurrency.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { LocalD1 } from './local-d1.mjs';

const ORIGIN = 'https://board.a4a4.ccwu.cc';

function harness() {
  const env = { DB: new LocalD1(), BOOTSTRAP_KEY: 'boot-test-key', BOARD_ORIGIN: ORIGIN };
  const call = async (method, path, { body, token, cookie } = {}) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET') headers.Origin = ORIGIN;
    const response = await worker.fetch(new Request(`http://local${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    }), env, {});
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
  return { env, call };
}

test('兩個 Agent 同時認領同一任務：只有一個成功，另一位不能交結果', async () => {
  const { env, call } = harness();

  const bootstrap = await call('POST', '/api/admin/bootstrap', { token: 'boot-test-key' });
  assert.equal(bootstrap.status, 201, '建立管理員');
  const login = await call('POST', '/api/auth/login', { body: { username: 'owner', password: bootstrap.data.password } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];

  const alpha = await call('POST', '/api/admin/agents', { cookie, body: { username: 'probe-alpha', name: 'probe-alpha' } });
  const beta = await call('POST', '/api/admin/agents', { cookie, body: { username: 'probe-beta', name: 'probe-beta' } });
  assert.equal(alpha.status, 201);
  assert.equal(beta.status, 201);
  assert.match(alpha.data.token, /^wba_/);
  assert.match(beta.data.token, /^wba_/, '每個 Agent 拿到自己的 wba_ 令牌');

  const created = await call('POST', '/api/tasks', { cookie, body: { title: '併發認領測試', detail: '可忽略', channelId: 1 } });
  assert.equal(created.status, 201);
  const taskId = created.data.id;

  const [a, b] = await Promise.all([
    call('POST', `/api/tasks/${taskId}/claim`, { token: alpha.data.token, body: { role: 'researcher' } }),
    call('POST', `/api/tasks/${taskId}/claim`, { token: beta.data.token, body: { role: 'researcher' } }),
  ]);
  const winners = [a, b].filter(r => r.status === 200);
  const losers = [a, b].filter(r => r.status !== 200);
  assert.equal(winners.length, 1, `只有一個認領成功（實際 ${a.status} / ${b.status}）`);
  assert.equal(losers.length, 1);
  assert.match(losers[0].data.error, /已被其他 Agent 認領/);

  const winner = a.status === 200 ? alpha : beta;
  const loser = a.status === 200 ? beta : alpha;
  const stored = await env.DB.prepare('SELECT status, claimed_by, claimed_role FROM tasks WHERE id=?').bind(taskId).first();
  assert.equal(stored.status, 'in_progress');
  assert.equal(stored.claimed_by, winner.data.username, '認領者按帳號記錄，不是 client 傳來的名字');
  assert.equal(stored.claimed_role, 'researcher');

  const stolen = await call('POST', `/api/tasks/${taskId}/result`, { token: loser.data.token, body: { summary: '冒充別人的成果' } });
  assert.equal(stolen.status, 403, '非認領者不能交結果');
  assert.match(stolen.data.error, /只有認領者能提交結果/);

  const delivered = await call('POST', `/api/tasks/${taskId}/result`, { token: winner.data.token, body: { summary: '認領者的成果' } });
  assert.equal(delivered.status, 200);

  const participants = await call('GET', '/api/participants', { token: winner.data.token });
  const names = participants.data.agents.map(agent => agent.username).sort();
  assert.deepEqual(names, ['probe-alpha', 'probe-beta'], '兩個 Agent 都在參與者名單');

  // legacy 共用 key 不在這個環境設定裡；確認沒有令牌連 /api/inbox 都讀不到。
  const anonymous = await call('GET', '/api/inbox');
  assert.equal(anonymous.status, 401);
});

test('legacy 共用 key 預設只能讀：不能認領、不能借用別人的名字', async () => {
  const { env, call } = harness();
  env.API_KEY = 'shared-legacy-key';
  const bootstrap = await call('POST', '/api/admin/bootstrap', { token: 'boot-test-key' });
  const login = await call('POST', '/api/auth/login', { body: { username: 'owner', password: bootstrap.data.password } });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const created = await call('POST', '/api/tasks', { cookie, body: { title: 'legacy 歸屬測試', channelId: 1 } });

  const read = await call('GET', '/api/tasks', { token: 'shared-legacy-key' });
  assert.equal(read.status, 200, '讀取仍可用，不擋舊頁面');

  const claimed = await call('POST', `/api/tasks/${created.data.id}/claim`, {
    token: 'shared-legacy-key', body: { agent: 'probe-alpha', role: 'researcher' },
  });
  assert.equal(claimed.status, 403, '共用憑證不能寫入');
  const stored = await env.DB.prepare('SELECT status, claimed_by FROM tasks WHERE id=?').bind(created.data.id).first();
  assert.equal(stored.status, 'open');
  assert.equal(stored.claimed_by, null, '不能借用別人的名字認領');
});

test('遷移窗口可用 ALLOW_LEGACY_WRITE=true 暫時恢復寫入', async () => {
  const { env, call } = harness();
  env.API_KEY = 'shared-legacy-key';
  env.ALLOW_LEGACY_WRITE = 'true';
  const bootstrap = await call('POST', '/api/admin/bootstrap', { token: 'boot-test-key' });
  const login = await call('POST', '/api/auth/login', { body: { username: 'owner', password: bootstrap.data.password } });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const created = await call('POST', '/api/tasks', { cookie, body: { title: '遷移窗口測試', channelId: 1 } });

  const claimed = await call('POST', `/api/tasks/${created.data.id}/claim`, {
    token: 'shared-legacy-key', body: { agent: 'probe-alpha', role: 'researcher' },
  });
  assert.equal(claimed.status, 200);
  const stored = await env.DB.prepare('SELECT claimed_by FROM tasks WHERE id=?').bind(created.data.id).first();
  assert.equal(stored.claimed_by, 'probe-alpha', '開啟窗口時仍可寫，但歸屬由 client 自填');
});
