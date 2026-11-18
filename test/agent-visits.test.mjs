import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {fixture} from './helpers.mjs';
import {recordAgentVisit, readAgentVisits, pruneAgentVisits} from '../src/agent-visits.js';

const rows = f => f.DB.sqlite.prepare('SELECT * FROM agent_visits ORDER BY id').all();
const history = (f,id,auth=f.admin,query='') => f.request('GET',`/api/admin/agents/${id}/visits${query}`,undefined,auth);

test('each verified Agent arrival is recorded, including guide 304, health and denied business actions',async()=>{
  const f=await fixture();
  assert.equal(rows(f).length,0);
  await f.request('GET','/api/health',undefined,f.host.auth);
  const guide=await f.request('GET','/api/agent-guide',undefined,f.host.auth);
  assert.equal(guide.status,200);
  const response=await worker.fetch(new Request('https://board.test/api/agent-guide',{headers:{...f.host.auth,'If-None-Match':`"${guide.data.version}"`}}),f.env,{});
  assert.equal(response.status,304);
  await f.request('GET','/api/inbox',undefined,f.host.auth);
  await f.request('GET','/api/tasks?needs=agent',undefined,f.host.auth);
  assert.equal((await f.request('POST','/api/tasks/1/verify',{},f.host.auth)).status,403);
  assert.equal(rows(f).length,6);
  assert.ok(rows(f).every(row=>row.agent_id===f.host.id&&Number.isFinite(Date.parse(row.visited_at))));
  assert.deepEqual(Object.keys(rows(f)[0]).sort(),['agent_id','id','visited_at']);
  const agents=(await f.request('GET','/api/admin/agents',undefined,f.admin)).data.accounts;
  assert.equal(agents.find(row=>row.id===f.host.id).last_seen_at,rows(f).at(-1).visited_at);
  assert.equal(agents.find(row=>row.id===f.worker.id).last_seen_at,null);
  const logged=(await history(f,f.host.id)).data;
  assert.equal(logged.visits.length,6);assert.equal(logged.total_requests,6);
  assert.equal(rows(f).length,6,'Administrator reads must not become Agent arrivals');
});

test('anonymous, invalid, shared, human and revoked credentials cannot invent Agent visits',async()=>{
  const f=await fixture();
  for(const auth of [{},{Authorization:'Bearer bad-token'},{Authorization:'Bearer test-legacy'},f.admin]) await f.request('GET','/api/tasks?agent=Host',undefined,{...auth,'User-Agent':'Host','X-Agent-Id':String(f.host.id)});
  const publisher=await f.request('POST','/api/admin/users',{username:'writer',name:'Muse publisher',role:'publisher'},f.admin);
  await f.request('GET','/api/tasks',undefined,{Authorization:'Bearer '+publisher.data.muse_token});
  assert.equal(rows(f).length,0);
  await f.request('POST','/api/not-an-endpoint',{agent:'Checker',agent_id:f.checker.id},f.host.auth);
  assert.deepEqual(rows(f).map(row=>row.agent_id),[f.host.id]);
  await f.request('POST',`/api/admin/agents/${f.host.id}/revoke`,{},f.admin);
  assert.equal((await f.request('GET','/api/auth/me',undefined,f.host.auth)).status,401);
  assert.equal(rows(f).length,1);
  assert.equal((await history(f,f.host.id)).data.visits.length,1,'Revoking credentials preserves retained history');
});

test('the 30-day boundary is exact and read, new-arrival and idle cleanup remove expired records',async()=>{
  const f=await fixture(), now=new Date('2026-11-18T10:00:00.000Z');
  const cutoff=new Date(now.getTime()-30*86400000).toISOString();
  const insert=f.DB.sqlite.prepare('INSERT INTO agent_visits (agent_id,visited_at) VALUES (?,?)');
  insert.run(f.host.id,'2026-10-19T09:59:59.999Z');
  insert.run(f.host.id,cutoff);
  insert.run(f.worker.id,'2026-10-18T10:00:00.000Z');
  const result=await readAgentVisits(f.DB,f.host.id,{now});
  assert.equal(result.retention_days,30);assert.equal(result.cutoff_at,cutoff);assert.equal(result.timezone,'Asia/Shanghai');
  assert.deepEqual(result.visits.map(row=>row.visited_at),[cutoff]);
  assert.equal(rows(f).length,1,'Reading expires old records for all Agents');
  insert.run(f.worker.id,'2026-10-01T00:00:00.000Z');
  await recordAgentVisit(f.DB,{id:f.host.id,kind:'agent',via:'bearer'},now);
  assert.equal(rows(f).length,2);
  await pruneAgentVisits(f.DB,new Date(now.getTime()+1));
  assert.deepEqual(rows(f).map(row=>row.visited_at),[now.toISOString()]);
  f.DB.sqlite.exec('DELETE FROM agent_visits');
  insert.run(f.host.id,new Date(Date.now()-31*86400000).toISOString());
  const recent=new Date().toISOString();insert.run(f.worker.id,recent);
  await worker.scheduled({},f.env,{});
  assert.deepEqual(rows(f).map(row=>row.visited_at),[recent],'Cron cleans up even without Agent traffic');
});

test('visit details require an administrator session, including disabled Agent history',async()=>{
  const f=await fixture();
  assert.equal((await history(f,f.host.id,{})).status,401);
  assert.equal((await history(f,f.host.id,f.worker.auth)).status,403);
  assert.equal((await history(f,f.host.id,{Authorization:'Bearer test-legacy'})).status,403);
  const created=await f.request('POST','/api/admin/users',{username:'reader',name:'Viewer',role:'viewer'},f.admin);
  const login=await f.request('POST','/api/auth/login',{username:'reader',password:created.data.password});
  assert.equal((await history(f,f.host.id,{Cookie:login.cookie.split(';')[0]})).status,403);
  assert.equal((await history(f,99999)).status,404);
  assert.equal((await history(f,1)).status,404);
  assert.equal((await f.request('POST',`/api/admin/agents/${f.host.id}/visits`,{},f.admin)).status,405);
  await f.request('GET','/api/auth/me',undefined,f.host.auth);
  await f.request('POST',`/api/admin/agents/${f.host.id}/name`,{name:'Renamed Muse'},f.admin);
  const token=await f.request('POST',`/api/admin/agents/${f.host.id}/rotate`,{},f.admin);
  await f.request('GET','/api/auth/me',undefined,{Authorization:'Bearer '+token.data.token});
  assert.equal((await history(f,f.host.id)).data.visits.length,2);
  assert.equal((await f.request('GET','/api/admin/agents',undefined,f.admin)).data.accounts.find(row=>row.id===f.host.id).name,'Renamed Muse');
});

test('pagination is ordered by actual time and ID without losing records when new arrivals occur',async()=>{
  const f=await fixture(), insert=f.DB.sqlite.prepare('INSERT INTO agent_visits (agent_id,visited_at) VALUES (?,?)');
  const same=new Date(Date.now()-1000).toISOString();
  for(let i=0;i<101;i++) {insert.run(f.host.id,same);if(i%10===0)insert.run(f.worker.id,same);}
  const first=(await history(f,f.host.id)).data;
  assert.equal(first.visits.length,50);assert.ok(first.next_cursor);assert.equal(first.total_requests,101);
  insert.run(f.host.id,new Date().toISOString());
  const second=(await history(f,f.host.id,f.admin,'?before='+encodeURIComponent(first.next_cursor))).data;
  const third=(await history(f,f.host.id,f.admin,'?before='+encodeURIComponent(second.next_cursor))).data;
  assert.equal(second.total_requests,null);
  const all=[...first.visits,...second.visits,...third.visits];
  assert.equal(all.length,101);assert.equal(new Set(all.map(row=>row.id)).size,101);assert.equal(third.next_cursor,null);
  assert.ok(all.every((row,i)=>!i||all[i-1].id>row.id));
  for(const bad of ['','bad','2026-02-30T10:00:00.000Z,1',same+',0',same+',9007199254740992',same+",1 OR 1=1"]) assert.equal((await history(f,f.host.id,f.admin,'?before='+encodeURIComponent(bad))).status,400);
});

test('arrival logging uses the Worker lifecycle and logging failures do not interrupt collaboration',async t=>{
  const f=await fixture(), pending=[];
  const response=await worker.fetch(new Request('https://board.test/api/auth/me',{headers:f.host.auth}),f.env,{waitUntil(promise){pending.push(promise);}});
  assert.equal(response.status,200);assert.equal(pending.length,1);await Promise.all(pending);
  assert.equal(rows(f).length,1);
  const errors=[];t.mock.method(console,'error',(...args)=>errors.push(args));
  const original=f.DB.batch;f.DB.batch=()=>{throw Error('Database log temporarily unavailable');};
  assert.equal((await f.request('GET','/api/auth/me',undefined,f.host.auth)).status,200);
  f.DB.batch=original;
  assert.deepEqual(errors,[['whiteboard-agent-visit-write-failed']]);
});

test('the migration is additive, repeatable and does not rewrite existing identities or tasks',async()=>{
  const f=await fixture();
  const before=f.DB.sqlite.prepare('SELECT * FROM tasks ORDER BY id').all();
  const principals=f.DB.sqlite.prepare('SELECT * FROM principals ORDER BY id').all();
  const sql=readFileSync(new URL('../migrations/0007-agent-visits.sql',import.meta.url),'utf8');
  f.DB.sqlite.exec(sql);f.DB.sqlite.exec(sql);
  assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM tasks ORDER BY id').all(),before);
  assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM principals ORDER BY id').all(),principals);
});
