import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';
import { INBOX_TIMEOUT_SECONDS, readInboxStatus, recordInboxFetch, summarizeInboxStatus } from '../src/agent-inbox.js';

const listAgents = async f => (await f.request('GET', '/api/admin/agents', undefined, f.admin)).data.accounts;
const hostStatus = async f => (await listAgents(f)).find(a=>a.id===f.host.id);
async function directive(f, agentId=f.host.id, age=0) {
  const created = await f.request('POST', `/api/admin/agents/${agentId}/directives`, {content:'请处理这条个人留言'}, f.admin);
  assert.equal(created.status, 201);
  const id = created.data.directive.id;
  if (age) f.DB.sqlite.prepare('UPDATE agent_directives SET created_at=? WHERE id=?').run(new Date(Date.now()-age).toISOString(), id);
  return id;
}
const oldAge = (INBOX_TIMEOUT_SECONDS+60)*1000;

test('task-only patrol leaves an overdue directive visible; successful inbox fetch clears only the fetch warning', async()=>{
  const f = await fixture();
  const id = await directive(f, f.host.id, oldAge);
  for (const path of ['/api/health','/api/agent-guide','/api/tasks?needs=agent','/api/agent/quota']) {
    assert.equal((await f.request('GET',path,undefined,f.host.auth)).status,200);
  }
  let status = await hostStatus(f);
  assert.ok(status.last_seen_at);
  assert.equal(status.last_inbox_at,null);
  assert.equal(status.unfetched_directives,1);
  assert.equal(status.inbox_overdue,true);
  const adminRead = await f.request('GET',`/api/admin/agents/${f.host.id}/directives`,undefined,f.admin);
  assert.equal(adminRead.data.inbox_status.inbox_overdue,true,'Administrator reads do not fetch on behalf of the Agent');
  const inbox = await f.request('GET','/api/inbox',undefined,f.host.auth);
  assert.equal(inbox.status,200);
  assert.equal(inbox.data.items[0].directive_id,id);
  status = await hostStatus(f);
  assert.ok(status.last_inbox_at);
  assert.equal(status.unfetched_directives,0);
  assert.equal(status.inbox_overdue,false);
  assert.equal(status.pending_directives,1,'Fetching never marks work completed');
  assert.equal((await hostStatus(f)).last_inbox_at,status.last_inbox_at);
  assert.equal((await listAgents(f)).find(a=>a.id===f.worker.id).last_inbox_at,null);
});

test('receipts apply only to returned IDs, including paginated directives and arrivals during a poll', async()=>{
  const f = await fixture();
  const first = await directive(f,f.host.id,oldAge);
  const second = await directive(f,f.host.id,oldAge);
  const page = await f.request('GET','/api/agent/directives?limit=1',undefined,f.host.auth);
  assert.equal(page.status,200);
  assert.equal(page.data.directives[0].id,second);
  let status = await hostStatus(f);
  assert.ok(status.last_inbox_at);
  assert.equal(status.unfetched_directives,1);
  assert.equal(status.inbox_overdue,true,'A recent partial fetch does not hide an older unfetched message');
  const detail = await f.request('GET',`/api/admin/agents/${f.host.id}/directives`,undefined,f.admin);
  assert.ok(detail.data.directives.find(d=>d.id===second).fetched_at);
  assert.equal(detail.data.directives.find(d=>d.id===first).fetched_at,null);
  await f.request('GET',`/api/agent/directives?before=${page.data.next_cursor}`,undefined,f.host.auth);
  assert.equal((await hostStatus(f)).inbox_overdue,false);
  const third = await directive(f,f.host.id,oldAge);
  await recordInboxFetch(f.DB,{id:f.host.id,kind:'agent',via:'bearer'},[first,second]);
  status = await hostStatus(f);
  assert.equal(status.unfetched_directives,1);
  assert.equal(status.inbox_overdue,true,'A row absent from the response cannot get a receipt');
  await f.request('GET','/api/inbox',undefined,f.host.auth);
  await f.request('POST',`/api/agent/directives/${third}/complete`,{result:'完成'},f.host.auth);
  assert.equal((await hostStatus(f)).unfetched_directives,0);
});

test('history, failed requests and other identities cannot invent successful mailbox fetches',async()=>{
  const f = await fixture();
  await directive(f,f.host.id,oldAge);
  assert.equal((await f.request('GET','/api/agent/directives?status=completed',undefined,f.host.auth)).status,200);
  assert.equal((await f.request('GET','/api/agent/directives?status=invalid',undefined,f.host.auth)).status,400);
  assert.equal((await f.request('POST','/api/agent/directives',{},f.host.auth)).status,405);
  for(const auth of [{},{Authorization:'Bearer invalid'},{Authorization:'Bearer test-legacy'}]) {
    assert.equal((await f.request('GET','/api/inbox',undefined,auth)).status,401);
  }
  assert.equal((await f.request('GET','/api/inbox',undefined,f.admin)).status,200);
  assert.equal((await hostStatus(f)).last_inbox_at,null);
  await f.request('GET','/api/inbox',undefined,f.worker.auth);
  assert.ok((await listAgents(f)).find(a=>a.id===f.worker.id).last_inbox_at,'An empty successful inbox is still a fetch');
  assert.equal((await hostStatus(f)).inbox_overdue,true);
  const prepare = f.DB.prepare;
  f.DB.prepare = sql => {
    if (sql.includes('SELECT * FROM tasks WHERE status NOT IN')) throw new Error('inbox read failed');
    return prepare(sql);
  };
  await assert.rejects(f.request('GET','/api/inbox',undefined,f.host.auth),/inbox read failed/);
  f.DB.prepare = prepare;
  assert.equal((await hostStatus(f)).last_inbox_at,null,'A failed inbox query cannot advance the fetch time');
  await f.request('POST',`/api/admin/agents/${f.host.id}/revoke`,{},f.admin);
  assert.equal((await f.request('GET','/api/inbox',undefined,f.host.auth)).status,401);
  assert.equal((await hostStatus(f)).inbox_overdue,false,'Disabled Agents retain history without an active warning');
});

test('timeout boundary, recall and out-of-order requests preserve accurate mailbox status',async()=>{
  const now = new Date('2026-11-21T00:00:00.000Z');
  const row = {active:1,unfetched_directives:1,oldest_unfetched_directive_at:new Date(now.getTime()-INBOX_TIMEOUT_SECONDS*1000).toISOString()};
  assert.equal(summarizeInboxStatus(row,new Date(now.getTime()-1)).inbox_overdue,false);
  assert.equal(summarizeInboxStatus(row,now).inbox_overdue,true);
  assert.equal(summarizeInboxStatus({...row,unfetched_directives:0},now).inbox_overdue,false);
  const f = await fixture();
  const id = await directive(f,f.host.id,oldAge);
  const principal = {id:f.host.id,kind:'agent',via:'bearer'};
  await recordInboxFetch(f.DB,principal,[id],now);
  await recordInboxFetch(f.DB,principal,[],new Date(now.getTime()-1));
  assert.equal((await readInboxStatus(f.DB,f.host.id)).last_inbox_at,now.toISOString());
  const unseen = await directive(f,f.host.id,oldAge);
  const removed = await f.request('DELETE',`/api/admin/agents/${f.host.id}/directives/${unseen}`,undefined,f.admin);
  assert.equal(removed.status,200);
  assert.equal(removed.data.inbox_status.inbox_overdue,false);
  assert.equal(removed.data.inbox_status.unfetched_directives,0);
});

test('inbox migration is additive, repeatable and compatible with D1 single-line DDL',async()=>{
  const f = await fixture();
  const id = await directive(f);
  const sql = readFileSync(new URL('../migrations/0018-agent-inbox.sql',import.meta.url),'utf8');
  for(let i=0;i<2;i++) {
    for(const line of sql.split('\n').map(s=>s.trim()).filter(s=>s&&!s.startsWith('--'))) {
      assert.match(line,/^CREATE TABLE IF NOT EXISTS .*;$/);
      await f.DB.exec(line);
    }
  }
  assert.equal(f.DB.sqlite.prepare('SELECT status FROM agent_directives WHERE id=?').get(id).status,'pending');
  assert.equal((await hostStatus(f)).last_inbox_at,null);
});
