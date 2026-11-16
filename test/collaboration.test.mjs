import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

async function hosted(f) {
  const {request,admin,host,worker}=f;
  assert.equal((await request('POST','/api/tasks/1/workflow',{host_id:host.id,acceptance:'提交带来源的比较结果',min_sources:1},admin)).status,200);
  assert.equal((await request('POST','/api/tasks/1/claim',{},worker.auth)).status,200);
  assert.equal((await request('POST','/api/tasks/1/result',{summary:'原始研究',links:['https://example.com/a']},worker.auth)).status,200);
}

test('hosted policy accepts independent verification, rejects self review and invalidates changed evidence',async()=>{
  const f=await fixture(),{request,admin,host,worker,checker}=f;
  assert.equal((await request('POST','/api/tasks/1/workflow',{host_id:host.id,acceptance:'x'},host.auth)).status,403);
  await hosted(f);
  assert.equal((await request('POST','/api/tasks/1/outcomes',{summary:'冒充主持',links:['https://example.com']},worker.auth)).status,403);
  assert.equal((await request('POST','/api/tasks/1/outcomes',{summary:'整理后的结论',links:['https://example.com/a'],changes:'整合来源',source_refs:[]},host.auth)).status,201);
  let d=(await request('GET','/api/tasks/1',undefined,checker.auth)).data;
  assert.equal(d.workflow.host_id,host.id);
  assert.equal(d.verify_readiness.ready,false);
  const check={fingerprint:d.workflow.fingerprint,note:'已逐条对照官网，满足验收要求',evidence:['https://example.com/a']};
  assert.equal((await request('POST','/api/tasks/1/reviews',check,host.auth)).status,403);
  assert.equal((await request('POST','/api/tasks/1/reviews',check,worker.auth)).status,403);
  assert.equal((await request('POST','/api/tasks/1/reviews',check,checker.auth)).status,201);
  d=(await request('GET','/api/tasks/1',undefined,checker.auth)).data;
  assert.equal(d.verify_readiness.ready,true);
  assert.equal(d.verify_readiness.checks.some(c=>c.key==='challenge'),false);
  assert.equal((await request('POST','/api/tasks/1/supplement',{summary:'新增关键数字',links:['https://example.com/b']},worker.auth)).status,200);
  d=(await request('GET','/api/tasks/1',undefined,checker.auth)).data;
  assert.equal(d.verify_readiness.ready,false);
  assert.equal((await request('POST','/api/tasks/1/reviews',check,checker.auth)).status,409);
  assert.equal((await request('POST','/api/tasks/1/verify',{},admin)).status,400);
  assert.equal((await request('GET','/api/inbox')).status,401);
  assert.equal((await request('GET','/api/inbox',undefined,checker.auth)).data.items.some(i=>i.task_id===1),true);
});

test('issues require independent resolution and remain in help queue after legacy counters turn green',async()=>{
  const f=await fixture(),{request,admin,host,worker,checker}=f;
  await hosted(f);
  const issue=await request('POST','/api/tasks/1/issues',{text:'价格不准确',severity:'blocking'},checker.auth);
  assert.equal(issue.status,201);
  assert.equal((await request('POST',`/api/tasks/2/issues/${issue.data.id}/respond`,{text:'跨任务'},host.auth)).status,404);
  assert.equal((await request('POST',`/api/tasks/1/issues/${issue.data.id}/respond`,{text:'已按官网更正',evidence:['https://example.com/fix']},host.auth)).status,200);
  assert.equal((await request('POST',`/api/tasks/1/issues/${issue.data.id}/resolve`,{note:'自批'},host.auth)).status,403);
  assert.equal((await request('POST',`/api/tasks/1/issues/${issue.data.id}/resolve`,{note:'核对修正正确'},checker.auth)).status,200);
  assert.equal((await request('POST','/api/tasks/1/outcomes',{summary:'更正后的结果',changes:'修正价格',links:['https://example.com/fix']},host.auth)).status,201);
  const challenge=await request('POST','/api/tasks/1/challenge',{reason:'还需修正日期',evidence:'https://example.com/date'},checker.auth);
  assert.equal(challenge.status,200);
  const queue=(await request('GET','/api/tasks?needs=agent',undefined,worker.auth)).data.tasks;
  assert.ok(queue.find(t=>t.id===1));
  const d=(await request('GET','/api/tasks/1',undefined,worker.auth)).data;
  assert.ok(d.workflow.issues.some(i=>i.challenge_id===challenge.data.challenge.id&&i.state==='open'));
  assert.equal(d.verify_readiness.ready,false);
});

test('three unfinished subtask slots, acknowledgement, wait, independent check and audited reassignment',async()=>{
  const f=await fixture(),{request,DB,admin,host,worker,checker}=f;
  await hosted(f);
  const create=()=>request('POST','/api/tasks/1/subtasks',{title:'核实续费',deliverable:'官方价格与链接',assignee_id:worker.id,due_at:'2030-01-01T00:00:00Z'},host.auth);
  const created=await Promise.all([create(),create(),create(),create()]);
  assert.deepEqual(created.map(r=>r.status).sort(),[201,201,201,409]);
  const id=created.find(r=>r.status===201).data.id;
  assert.equal((await request('POST',`/api/tasks/1/subtasks/${id}/accept`,{},checker.auth)).status,403);
  assert.equal((await request('POST',`/api/tasks/1/subtasks/${id}/accept`,{},worker.auth)).status,200);
  assert.equal((await request('POST',`/api/tasks/1/subtasks/${id}/wait`,{reason:'等财报公布',resume_at:'2030-01-01T00:00:00Z'},worker.auth)).status,200);
  const inbox=(await request('GET','/api/inbox',undefined,worker.auth)).data;
  assert.equal(inbox.items.some(i=>i.kind==='subtask'&&i.subtask_id===id),false);
  assert.ok(inbox.waiting.some(i=>i.subtask_id===id));
  assert.equal((await request('POST',`/api/tasks/1/subtasks/${id}/reassign`,{assignee_id:checker.id,reason:'换人'},host.auth)).status,409);
  assert.equal((await request('POST',`/api/tasks/1/subtasks/${id}/submit`,{summary:'官方报价已核实',links:['https://example.com/a']},worker.auth)).status,200);
  assert.equal((await request('POST',`/api/tasks/1/subtasks/${id}/check`,{note:'自己核查'},worker.auth)).status,403);
  assert.equal((await request('POST',`/api/tasks/1/subtasks/${id}/check`,{note:'已对照官方来源'},checker.auth)).status,200);
  assert.equal((await create()).status,201);
  const pending=created.filter(r=>r.status===201)[1].data.id;
  DB.sqlite.prepare("UPDATE work_subtasks SET assigned_at='2020-01-01T00:00:00Z' WHERE id=?").run(pending);
  assert.equal((await request('POST',`/api/tasks/1/subtasks/${pending}/reassign`,{assignee_id:checker.id,reason:'未接单超过两小时'},host.auth)).status,200);
  assert.ok(DB.sqlite.prepare('SELECT * FROM work_subtask_events WHERE subtask_id=?').all(pending).length>=2);
});
