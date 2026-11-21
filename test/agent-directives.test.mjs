import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';

async function createHuman(f, username, name, role) {
  const created = await f.request('POST', '/api/admin/users', { username, name, role }, f.admin);
  assert.equal(created.status, 201);
  const login = await f.request('POST', '/api/auth/login', { username, password: created.data.password });
  assert.equal(login.status, 200);
  return {
    id: created.data.id,
    auth: { Cookie: login.cookie.split(';')[0], Origin: 'https://board.test' },
  };
}

test('Admin directive lifecycle: create, surface in inbox top priority, complete with feedback, auto-archive permanently', async () => {
  const f = await fixture();

  // Create a regular open task so we can verify directives sort ABOVE normal inbox work.
  const task = await f.request('POST', '/api/tasks', {
    title: '普通待办任务',
    description: '用于验证留言指示排序高于普通待办',
    plan: { goal: 'research', delivery: { format: 'text' }, acceptance: { independent_review: false, min_sources: 0 } },
  }, f.admin);
  assert.equal(task.status, 201);
  const claimed = await f.request('POST', `/api/tasks/${task.data.id}/claim`, {}, f.host.auth);
  assert.equal(claimed.status, 200);

  // Admin sends a directive to Host
  const created = await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, {
    content: '请检查昨日数据抓取脚本是否漏掉香港市场，完成后把核查摘要和日志链接回馈给我。',
  }, f.admin);
  assert.equal(created.status, 201);
  assert.equal(created.data.ok, true);
  assert.equal(created.data.directive.status, 'pending');
  assert.equal(created.data.directive.agent_id, f.host.id);
  assert.equal(created.data.directive.author_name, 'owner');
  assert.equal(created.data.directive.result, '');
  assert.equal(created.data.directive.completed_at, null);
  assert.deepEqual(created.data.counts, { pending: 1, completed: 0, total: 1 });
  const directiveId = created.data.directive.id;

  // Admin agents listing shows pending_directives=1, completed_directives=0
  const agentList1 = await f.request('GET', '/api/admin/agents', undefined, f.admin);
  assert.equal(agentList1.status, 200);
  const hostRow1 = agentList1.data.accounts.find(a => a.id === f.host.id);
  assert.equal(hostRow1.pending_directives, 1);
  assert.equal(hostRow1.completed_directives, 0);

  // Agent reads /api/inbox: directive appears at index 0 (highest priority) and top-level directives[]
  const inbox1 = await f.request('GET', '/api/inbox', undefined, f.host.auth);
  assert.equal(inbox1.status, 200);
  assert.equal(inbox1.data.items[0].kind, 'directive');
  assert.equal(inbox1.data.items[0].directive_id, directiveId);
  assert.equal(inbox1.data.items[0].action, 'complete_directive');
  assert.equal(inbox1.data.items[0].complete_url, `/api/agent/directives/${directiveId}/complete`);
  assert.match(inbox1.data.items[0].content, /香港市场/);
  assert.equal(inbox1.data.directives.length, 1);
  assert.equal(inbox1.data.directives[0].id, directiveId);

  // Agent reads /api/agent/directives (default pending)
  const selfPending = await f.request('GET', '/api/agent/directives', undefined, f.host.auth);
  assert.equal(selfPending.status, 200);
  assert.equal(selfPending.data.directives.length, 1);
  assert.equal(selfPending.data.directives[0].id, directiveId);

  // Other agent (Worker) sees neither the directive in /api/inbox nor in /api/agent/directives, and gets 404 on complete
  const workerInbox = await f.request('GET', '/api/inbox', undefined, f.worker.auth);
  assert.equal(workerInbox.status, 200);
  assert.equal(workerInbox.data.directives.length, 0);
  assert.ok(!workerInbox.data.items.some(i => i.kind === 'directive'));
  const workerSelf = await f.request('GET', '/api/agent/directives', undefined, f.worker.auth);
  assert.equal(workerSelf.status, 200);
  assert.equal(workerSelf.data.directives.length, 0);
  const crossComplete = await f.request('POST', `/api/agent/directives/${directiveId}/complete`, {
    result: '越权尝试完成他人的留言',
  }, f.worker.auth);
  assert.equal(crossComplete.status, 404);

  // Host completes the directive with result & links
  const completed = await f.request('POST', `/api/agent/directives/${directiveId}/complete`, {
    result: '已核查脚本：香港市场因时区偏移漏跑 1 次，已补跑并修复 cron 配置。',
    links: ['https://example.com/hk-log', 'https://example.com/hk-log'],
  }, f.host.auth);
  assert.equal(completed.status, 200);
  assert.equal(completed.data.ok, true);
  assert.equal(completed.data.directive.status, 'completed');
  assert.match(completed.data.directive.result, /已补跑并修复/);
  assert.deepEqual(completed.data.directive.links, ['https://example.com/hk-log']);
  assert.ok(completed.data.directive.completed_at);

  // Duplicate completion is rejected with 409 and does not overwrite archived feedback
  const dup = await f.request('POST', `/api/agent/directives/${directiveId}/complete`, {
    result: '试图覆盖已归档的完成结果',
  }, f.host.auth);
  assert.equal(dup.status, 409);

  // Pending inbox & default /api/agent/directives no longer show completed directive
  const inbox2 = await f.request('GET', '/api/inbox', undefined, f.host.auth);
  assert.equal(inbox2.data.directives.length, 0);
  assert.ok(!inbox2.data.items.some(i => i.kind === 'directive'));
  const selfPending2 = await f.request('GET', '/api/agent/directives', undefined, f.host.auth);
  assert.equal(selfPending2.data.directives.length, 0);

  // Completed archive retains full original record
  const selfCompleted = await f.request('GET', '/api/agent/directives?status=completed', undefined, f.host.auth);
  assert.equal(selfCompleted.status, 200);
  assert.equal(selfCompleted.data.directives.length, 1);
  assert.equal(selfCompleted.data.directives[0].status, 'completed');
  assert.match(selfCompleted.data.directives[0].result, /已补跑并修复/);

  // Admin view shows archived record & updated counts
  const adminView = await f.request('GET', `/api/admin/agents/${f.host.id}/directives`, undefined, f.admin);
  assert.equal(adminView.status, 200);
  assert.deepEqual(adminView.data.counts, { pending: 0, completed: 1, total: 1 });
  assert.equal(adminView.data.directives.length, 1);
  assert.equal(adminView.data.directives[0].status, 'completed');
  assert.match(adminView.data.directives[0].result, /已补跑并修复/);
  assert.deepEqual(adminView.data.directives[0].links, ['https://example.com/hk-log']);

  // Admin agents listing reflects pending=0, completed=1
  const agentList2 = await f.request('GET', '/api/admin/agents', undefined, f.admin);
  const hostRow2 = agentList2.data.accounts.find(a => a.id === f.host.id);
  assert.equal(hostRow2.pending_directives, 0);
  assert.equal(hostRow2.completed_directives, 1);

  // Completed directive cannot be recalled (409)
  const recallCompleted = await f.request('DELETE', `/api/admin/agents/${f.host.id}/directives/${directiveId}`, undefined, f.admin);
  assert.equal(recallCompleted.status, 409);
});

test('Strict owner/admin RBAC on admin directive routes and agent-only access on agent directive routes', async () => {
  const f = await fixture();
  const viewer = await createHuman(f, 'viewer1', '观察员', 'viewer');
  const publisher = await createHuman(f, 'pub1', '发布员', 'publisher');

  // Unauthenticated, legacy key, viewer, publisher, and agent are rejected on GET & POST admin routes
  for (const [label, auth, expected] of [
    ['unauth', {}, 401],
    ['legacy', { Authorization: 'Bearer test-legacy' }, 403],
    ['viewer', viewer.auth, 403],
    ['publisher', publisher.auth, 403],
    ['agent', f.host.auth, 403],
  ]) {
    const g = await f.request('GET', `/api/admin/agents/${f.host.id}/directives`, undefined, auth);
    assert.equal(g.status, expected, `GET admin directives for ${label}`);
    const p = await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: '越权留言' }, auth);
    assert.equal(p.status, expected, `POST admin directives for ${label}`);
  }

  // Bad-origin mutating admin requests (POST/DELETE) are blocked by CSRF origin check
  const badOriginPost = await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: '跨站伪造留言' }, {
    Cookie: f.admin.Cookie,
    Origin: 'https://evil.example',
  });
  assert.equal(badOriginPost.status, 403);

  // Humans (even admin), legacy key, and unauth cannot call /api/agent/directives*
  for (const [label, auth, expected] of [
    ['unauth', {}, 401],
    ['legacy', { Authorization: 'Bearer test-legacy' }, 403],
    ['admin', f.admin, 403],
    ['viewer', viewer.auth, 403],
  ]) {
    const g = await f.request('GET', '/api/agent/directives', undefined, auth);
    assert.equal(g.status, expected, `GET agent directives for ${label}`);
    const p = await f.request('POST', '/api/agent/directives/1/complete', { result: 'ok' }, auth);
    assert.equal(p.status, expected, `POST agent complete for ${label}`);
  }
});

test('Pending directive recall, validation, inactive agent rejection, lossless pagination, and rename preservation', async () => {
  const f = await fixture();

  // Validation errors
  assert.equal((await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: '   ' }, f.admin)).status, 400);
  assert.equal((await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: 'x'.repeat(4001) }, f.admin)).status, 400);
  assert.equal((await f.request('POST', '/api/admin/agents/999999/directives', { content: '不存在的 agent' }, f.admin)).status, 404);

  // Create 3 directives: recall #1, complete #2, keep #3 pending
  const d1 = await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: '第一条待撤回' }, f.admin);
  const d2 = await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: '第二条已完成' }, f.admin);
  const d3 = await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: '第三条待处理' }, f.admin);
  assert.equal(d1.status, 201);
  assert.equal(d2.status, 201);
  assert.equal(d3.status, 201);

  // Recall pending directive #1
  const recalled = await f.request('DELETE', `/api/admin/agents/${f.host.id}/directives/${d1.data.directive.id}`, undefined, f.admin);
  assert.equal(recalled.status, 200);
  assert.equal(recalled.data.id, d1.data.directive.id);
  assert.deepEqual(recalled.data.counts, { pending: 2, completed: 0, total: 2 });

  // Recalling already deleted directive returns 404
  assert.equal((await f.request('DELETE', `/api/admin/agents/${f.host.id}/directives/${d1.data.directive.id}`, undefined, f.admin)).status, 404);

  // Invalid completion payloads
  assert.equal((await f.request('POST', `/api/agent/directives/${d2.data.directive.id}/complete`, { result: '' }, f.host.auth)).status, 400);
  assert.equal((await f.request('POST', `/api/agent/directives/${d2.data.directive.id}/complete`, { result: 'ok', links: ['javascript:alert(1)'] }, f.host.auth)).status, 400);

  // Complete #2
  const done2 = await f.request('POST', `/api/agent/directives/${d2.data.directive.id}/complete`, { result: '第二条完成回馈' }, f.host.auth);
  assert.equal(done2.status, 200);

  // Create a 4th directive so we have 3 total (#4 pending, #3 pending, #2 completed) and test lossless cursor pagination
  const d4 = await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: '第四条待处理' }, f.admin);
  assert.equal(d4.status, 201);

  const page1 = await f.request('GET', `/api/admin/agents/${f.host.id}/directives?limit=2`, undefined, f.admin);
  assert.equal(page1.status, 200);
  assert.deepEqual(page1.data.directives.map(d => d.id), [d4.data.directive.id, d3.data.directive.id]);
  assert.equal(page1.data.has_more, true);
  assert.equal(page1.data.next_cursor, String(d3.data.directive.id));

  const page2 = await f.request('GET', `/api/admin/agents/${f.host.id}/directives?limit=2&before=${page1.data.next_cursor}`, undefined, f.admin);
  assert.equal(page2.status, 200);
  assert.deepEqual(page2.data.directives.map(d => d.id), [d2.data.directive.id]);
  assert.equal(page2.data.has_more, false);

  // Status filter works (and omitted limit returns default page size, not 1)
  const onlyCompleted = await f.request('GET', `/api/admin/agents/${f.host.id}/directives?status=completed`, undefined, f.admin);
  assert.deepEqual(onlyCompleted.data.directives.map(d => d.id), [d2.data.directive.id]);
  const onlyPending = await f.request('GET', `/api/admin/agents/${f.host.id}/directives?status=pending`, undefined, f.admin);
  assert.deepEqual(onlyPending.data.directives.map(d => d.id), [d4.data.directive.id, d3.data.directive.id]);

  // Rename Host -> Host-Renamed and verify archived directive reflects updated display name
  const renamed = await f.request('POST', `/api/admin/agents/${f.host.id}/name`, { name: 'Host-Renamed' }, f.admin);
  assert.equal(renamed.status, 200);
  const afterRename = await f.request('GET', `/api/admin/agents/${f.host.id}/directives?status=completed`, undefined, f.admin);
  assert.equal(afterRename.data.directives[0].agent_name, 'Host-Renamed');

  // Deactivated agent cannot receive new directives, but admin can still read archived history
  const deactivated = await f.request('POST', `/api/admin/agents/${f.host.id}/revoke`, {}, f.admin);
  assert.equal(deactivated.status, 200);
  const blockedPost = await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: '停用后留言' }, f.admin);
  assert.equal(blockedPost.status, 404);
  const archivedRead = await f.request('GET', `/api/admin/agents/${f.host.id}/directives`, undefined, f.admin);
  assert.equal(archivedRead.status, 200);
  assert.equal(archivedRead.data.counts.completed, 1);
});

test('Migration 0017-agent-directives.sql is additive, idempotent, and D1 exec line-compatible', async () => {
  const f = await fixture();
  const sql = readFileSync(new URL('../migrations/0017-agent-directives.sql', import.meta.url), 'utf8');
  for (const line of sql.split('\n').map(l => l.trim()).filter(Boolean)) {
    await f.DB.exec(line);
  }
  const created = await f.request('POST', `/api/admin/agents/${f.host.id}/directives`, { content: '迁移验证留言' }, f.admin);
  assert.equal(created.status, 201);
  // Apply migration a second time; existing directive record must survive untouched
  for (const line of sql.split('\n').map(l => l.trim()).filter(Boolean)) {
    await f.DB.exec(line);
  }
  const list = await f.request('GET', `/api/admin/agents/${f.host.id}/directives`, undefined, f.admin);
  assert.equal(list.status, 200);
  assert.equal(list.data.directives.length, 1);
  assert.equal(list.data.directives[0].content, '迁移验证留言');
});
