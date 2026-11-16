import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.mjs';
import worker from '../src/index.js';

async function guideFetch(f,auth={},extra={}) {
  return worker.fetch(new Request('https://board.test/api/agent-guide',{headers:{...auth,...extra}}),f.env,{});
}

test('guide is authenticated, matches the handbook, and conditional requests still authenticate',async()=>{
  const f=await fixture();
  assert.equal((await guideFetch(f)).status,401);
  const response=await guideFetch(f,f.host.auth),guide=await response.json();
  assert.equal(response.status,200);
  assert.equal(guide.markdown,readFileSync(new URL('../docs/AGENT_LOOP.md',import.meta.url),'utf8'));
  assert.equal(guide.instructions,'');
  assert.ok(guide.bootstrap.includes('/api/agent-guide'));
  const etag=response.headers.get('etag');assert.ok(etag);
  assert.equal((await guideFetch(f,f.host.auth,{'If-None-Match':etag})).status,304);
  assert.equal((await guideFetch(f,{}, {'If-None-Match':etag})).status,401);
  await f.request('POST',`/api/admin/agents/${f.host.id}/revoke`,{},f.admin);
  assert.equal((await guideFetch(f,f.host.auth,{'If-None-Match':etag})).status,401);
});

test('only admin sessions publish guidance, with version conflicts, validation, clear and immutable history',async()=>{
  const f=await fixture(),{request,admin,host,DB}=f;
  const initial=await (await guideFetch(f,host.auth)).json();
  const body={version:initial.version,instructions:'先处理已承诺的子任务，再探索新题目。'};
  assert.equal((await request('POST','/api/admin/agent-guide',body,host.auth)).status,403);
  assert.equal((await request('POST','/api/admin/agent-guide',body,{...admin,Origin:'https://evil.test'})).status,403);
  const viewer=await request('POST','/api/admin/users',{username:'reader',name:'Reader',role:'viewer'},admin);
  const login=await request('POST','/api/auth/login',{username:'reader',password:viewer.data.password});
  const reader={Cookie:login.cookie.split(';')[0],Origin:'https://board.test'};
  assert.equal((await request('POST','/api/admin/agent-guide',body,reader)).status,403);
  assert.equal((await guideFetch(f,reader)).status,200);
  const otherAdmin=await request('POST','/api/admin/users',{username:'other-admin',name:'Admin',role:'admin'},admin);
  assert.equal((await request('POST','/api/admin/agent-guide',body,{Authorization:`Bearer ${otherAdmin.data.muse_token}`})).status,403);
  assert.equal((await request('POST','/api/admin/agent-guide',{...body,instructions:'a'.repeat(12001)},admin)).status,400);
  const posted=await request('POST','/api/admin/agent-guide',body,admin);assert.equal(posted.status,200);
  assert.notEqual(posted.data.version,initial.version);
  assert.ok(posted.data.markdown.includes(body.instructions));
  assert.equal((await guideFetch(f,host.auth,{'If-None-Match':`"${initial.version}"`})).status,200);
  assert.equal((await request('POST','/api/admin/agent-guide',body,admin)).status,409);
  assert.equal((await request('POST','/api/admin/agent-guide',{version:posted.data.version,instructions:''},admin)).status,200);
  assert.equal((await (await guideFetch(f,host.auth)).json()).markdown,initial.markdown);
  const history=DB.sqlite.prepare('SELECT * FROM agent_guide_revisions ORDER BY id').all();
  assert.equal(history.length,2);assert.equal(history[0].instructions,body.instructions);assert.equal(history[1].instructions,'');
  const migration=readFileSync(new URL('../migrations/0005-agent-guide.sql',import.meta.url),'utf8');
  const fresh=new DatabaseSync(':memory:');fresh.exec(migration);fresh.exec(migration);
  assert.deepEqual(fresh.prepare('PRAGMA table_info(agent_guide_revisions)').all(),DB.sqlite.prepare('PRAGMA table_info(agent_guide_revisions)').all());fresh.close();
});

test('simultaneous guide publications have one winner and discovery never includes private guidance',async()=>{
  const f=await fixture(),{request,admin,host,DB}=f;
  const initial=await (await guideFetch(f,host.auth)).json();
  const results=await Promise.all(['alpha-private','beta-private'].map(instructions=>request('POST','/api/admin/agent-guide',{version:initial.version,instructions},admin)));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_guide_revisions').get().n,1);
  for(const [path,auth] of [['/api/health',{}],['/api/tasks',{}],['/api/inbox',host.auth]]) {
    const r=await request('GET',path,undefined,auth);assert.equal(r.status,200);
    assert.equal(r.data.agent_guide.url,'/api/agent-guide');
    assert.equal(r.data.agent_guide.read_before_each_poll,true);
    assert.equal(JSON.stringify(r.data).includes('-private'),false);
  }
});
