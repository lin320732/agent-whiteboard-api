import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';

async function setup(f) {
  const created=await f.request('POST','/api/tasks',{title:'操作记录核对',plan:{goal:'content',collaboration:'hosted',acceptance:{criteria:'可核对',min_sources:0,independent_review:false}}},f.admin);
  assert.equal(created.status,201);
  const id=created.data.id;
  assert.equal((await f.request('POST',`/api/tasks/${id}/workflow`,{host_id:f.host.id,acceptance:'可核对',min_sources:0},f.admin)).status,200);
  assert.equal((await f.request('POST',`/api/tasks/${id}/claim`,{},f.worker.auth)).status,200);
  return id;
}
async function activity(f,id,auth=f.admin) {
  const response=await f.request('GET',`/api/tasks/${id}/activity`,undefined,auth);
  assert.equal(response.status,200);
  return response.data.events;
}

test('activity preserves repeated responses and attributes acceptance to the administrator, without duplicate rewards',async()=>{
  const f=await fixture(),id=await setup(f);
  await f.request('POST',`/api/tasks/${id}/result`,{summary:'初稿',links:[]},f.worker.auth);
  const issue=await f.request('POST',`/api/tasks/${id}/issues`,{text:'核实单位',severity:'blocking'},f.checker.auth);
  for(const text of ['修订第一版','修订第二版']) assert.equal((await f.request('POST',`/api/tasks/${id}/issues/${issue.data.id}/respond`,{text},f.host.auth)).status,200);
  assert.equal((await f.request('POST',`/api/tasks/${id}/issues/${issue.data.id}/resolve`,{note:'单位已核实',revision:2},f.checker.auth)).status,200);
  assert.equal((await f.request('POST',`/api/tasks/${id}/outcomes`,{summary:'修订后的结论',changes:'修正单位',links:[]},f.host.auth)).status,201);
  assert.equal((await f.request('POST',`/api/tasks/${id}/verify`,{agent:'Pretend Administrator'},f.admin)).status,200);
  const events=await activity(f,id);
  const responses=events.filter(row=>row.action==='issue_response');
  assert.equal(responses.length,2);
  assert.deepEqual(responses.map(row=>row.description).sort(),['修订第一版','修订第二版'].sort());
  assert.ok(responses.every(row=>row.actor_id===f.host.id&&row.at));
  for(const action of ['task_claim','task_result','task_verify']) assert.equal(events.filter(row=>row.action===action).length,1,action);
  assert.equal(events.find(row=>row.action==='task_verify').actor,'owner');
  assert.equal(events.filter(row=>row.action==='outcome').length,1);
  assert.equal(events.filter(row=>row.action==='issue').length,1);
  const writes=f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM work_activity').get().n;
  await activity(f,id);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM work_activity').get().n,writes,'Reading history must not append actions');
});

test('historical award recipients are never presented as the unknown verifier or approver',async()=>{
  const f=await fixture();
  for(const type of ['verify','result','propose_approved']) f.DB.sqlite.prepare('INSERT INTO events(agent,type,task_id,points,created_at) VALUES(?,?,1,0,?)').run('Worker',type,'2026-11-17T03:00:00Z');
  const events=(await activity(f,1)).filter(row=>row.source==='legacy_credit');
  assert.equal(events.length,3);
  for(const row of events) {assert.equal(row.actor,'操作人未记录');assert.equal(row.at,'2026-11-17T03:00:00Z');assert.ok(row.description.includes('积分归属：Worker'));}
});

test('activity requires personal identity and rejected requests never create successful-operation records',async()=>{
  const f=await fixture();
  for(const auth of [{},{Authorization:'Bearer test-legacy'}]) assert.equal((await f.request('GET','/api/tasks/1/activity',undefined,auth)).status,401);
  assert.equal((await f.request('GET','/api/tasks/999/activity',undefined,f.admin)).status,404);
  const before=f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM work_activity').get().n;
  assert.equal((await f.request('POST','/api/tasks/1/verify',{},f.worker.auth)).status,403);
  assert.equal((await f.request('POST','/api/tasks/1/activity',{},f.admin)).status,405);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM work_activity').get().n,before);
  const events=await activity(f,1,f.checker.auth);assert.ok(events.length);
});

test('subtask history keeps the assigning actor and original assignee when a task is reassigned',async()=>{
  const f=await fixture(),id=await setup(f),base=`/api/tasks/${id}`;
  const result=await f.request('POST',base+'/subtasks',{title:'原始分工',deliverable:'核实单位',assignee_id:f.worker.id,due_at:'2030-01-01T00:00:00Z'},f.host.auth);
  assert.equal(result.status,201);
  const sub=result.data.id;
  f.DB.sqlite.prepare('UPDATE work_subtasks SET assigned_at=? WHERE id=?').run('2020-01-01T00:00:00Z',sub);
  assert.equal((await f.request('POST',`${base}/subtasks/${sub}/reassign`,{assignee_id:f.checker.id,reason:'接单超时，改派核实',due_at:'2030-01-02T00:00:00Z'},f.host.auth)).status,200);
  const records=(await activity(f,id)).filter(row=>row.entity_type==='subtask'&&row.entity_id===sub);
  assert.equal(records.length,2);
  assert.ok(records.every(row=>row.actor_id===f.host.id));
  assert.ok(records.find(row=>row.action==='subtask_assigned').description.includes('受派人：Worker'));
  assert.ok(records.find(row=>row.action==='subtask_reassign').description.includes('受派人：Checker'));
});

test('missing response timestamps remain unknown, and account renames preserve actor identity',async()=>{
  const f=await fixture(),id=await setup(f);
  const result=await f.request('POST',`/api/tasks/${id}/issues`,{text:'历史问题'},f.checker.auth);
  f.DB.sqlite.prepare("UPDATE work_issues SET response='历史修正',responder_id=?,state='responded' WHERE id=?").run(f.host.id,result.data.id);
  assert.equal((await f.request('POST',`/api/admin/agents/${f.host.id}/name`,{name:'主持甲'},f.admin)).status,200);
  const response=(await activity(f,id)).find(row=>row.action==='issue_response');
  assert.equal(response.actor_id,f.host.id);assert.equal(response.actor,'主持甲');assert.equal(response.at,null);assert.equal(response.source,'undated');
});

test('approval, rejection and reopening record the acting administrator rather than the proposal author',async()=>{
  const f=await fixture();
  const created=await f.request('POST','/api/tasks',{title:'Agent 提案'},f.worker.auth),id=created.data.id;
  assert.equal((await f.request('POST',`/api/tasks/${id}/approve`,{},f.admin)).status,200);
  assert.equal((await f.request('POST',`/api/tasks/${id}/reopen`,{},f.admin)).status,200);
  const records=(await activity(f,id)).filter(row=>['task_approve','task_reopen'].includes(row.action));
  assert.equal(records.length,2);assert.ok(records.every(row=>row.actor==='owner'&&row.at));
  const another=await f.request('POST','/api/tasks',{title:'未批准提案'},f.worker.auth);
  assert.equal((await f.request('POST',`/api/tasks/${another.data.id}/reject`,{},f.admin)).status,200);
  assert.equal((await activity(f,another.data.id)).find(row=>row.action==='task_reject').actor,'owner');
});

test('recurring tasks attribute automatic creation to the system even when an account uses that name',async()=>{
  const f=await fixture();
  const alias=await f.request('POST','/api/admin/agents',{username:'system_alias',name:'系统'},f.admin);
  await f.request('POST',`/api/admin/agents/${alias.data.id}/name`,{name:'人工账号'},f.admin);
  const created=await f.request('POST','/api/tasks',{title:'定期执行',plan:{goal:'content',acceptance:{min_sources:0,independent_review:false},schedule:{kind:'recurring',start_at:'2020-01-01T00:00:00Z',interval_days:1}}},f.admin);
  const id=created.data.id;
  await f.request('POST',`/api/tasks/${id}/claim`,{},f.worker.auth);
  await f.request('POST',`/api/tasks/${id}/result`,{summary:'本期交付',links:[]},f.worker.auth);
  const accepted=await f.request('POST',`/api/tasks/${id}/verify`,{},f.admin);assert.equal(accepted.status,200);
  assert.equal((await activity(f,id)).find(row=>row.action==='recurrence_next').actor,'系统');
  const next=(await activity(f,accepted.data.next_task_id)).find(row=>row.action==='recurrence_create');
  assert.equal(next.actor,'系统（上期验收后生成）');assert.ok(next.at);
});
