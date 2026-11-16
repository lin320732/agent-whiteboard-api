import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { readFileSync } from 'node:fs';

test('topics enforce a Macau-day cap, keep replies in their thread and turn discussion into an unapproved proposal',async()=>{
  const {request,DB,admin,host,worker}=await fixture();
  assert.equal((await request('GET','/api/topics')).status,401);
  const topic=await request('POST','/api/topics',{theme:'tools',title:'廉价服务器的新用法',content:'试做报告自动汇总器'},host.auth);
  assert.equal(topic.status,201);
  assert.equal((await request('POST','/api/topics',{theme:'food',title:'另开',content:'同一天再开话题'},host.auth)).status,429);
  const other=await request('POST','/api/topics',{theme:'food',title:'食材替代',content:'在澳门做世界美食'},worker.auth);
  const reply=await request('POST',`/api/topics/${topic.data.id}/replies`,{content:'可先做小样'},worker.auth);
  assert.equal(reply.status,201);
  assert.equal((await request('POST',`/api/topics/${other.data.id}/replies`,{content:'跨串引用',reply_to:reply.data.id},host.auth)).status,404);
  const proposed=await request('POST',`/api/topics/${topic.data.id}/propose`,{title:'自动报告小样',detail:'沿用闲置服务器',expected:'一份可运行演示',value:'减少人工整理',type:'data'},host.auth);
  assert.equal(proposed.status,201);
  assert.equal(proposed.data.status,'proposed');
  assert.equal((await request('POST',`/api/tasks/${proposed.data.id}/approve`,{},host.auth)).status,403);
  assert.equal((await request('POST',`/api/tasks/${proposed.data.id}/approve`,{},admin)).status,200);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE type=\'debate\'').get().n,0);
  const detail=(await request('GET',`/api/topics/${topic.data.id}`,undefined,host.auth)).data;
  assert.equal(detail.proposals[0].id,proposed.data.id);
  const digest=(await request('GET','/api/digest',undefined,admin)).data;
  assert.ok(digest.highlights.length<=3);
  assert.ok(digest.highlights.every(x=>x.task_id||x.topic_id));
});

test('adopted contributions refer to real task evidence, require independent confirmation and cannot double count',async()=>{
  const f=await fixture(),{request,host,worker,checker}=f;
  await hosted(f);
  const debate=await request('POST','/api/tasks/1/debate',{stance:'补充',content:'发现续费差异'},worker.auth);
  const outcome=await request('POST','/api/tasks/1/outcomes',{summary:'采用续费差异',changes:'补充总成本',links:['https://example.com'],source_refs:[{kind:'debate',id:debate.data.message.id}]},host.auth);
  assert.equal(outcome.status,201);
  const body={outcome_id:outcome.data.id,source_kind:'debate',source_id:debate.data.message.id,kind:'discovery',note:'发现影响总成本的续费差异'};
  assert.equal((await request('POST','/api/tasks/1/contributions',{...body,source_id:9999},host.auth)).status,404);
  const credit=await request('POST','/api/tasks/1/contributions',body,host.auth);
  assert.equal(credit.status,201);
  assert.equal((await request('POST',`/api/tasks/1/contributions/${credit.data.id}/confirm`,{note:'自己确认'},worker.auth)).status,403);
  assert.equal((await request('POST',`/api/tasks/1/contributions/${credit.data.id}/confirm`,{note:'在成果中已核实采用'},checker.auth)).status,200);
  assert.equal((await request('POST','/api/tasks/1/contributions',body,host.auth)).status,409);
  const records=(await request('GET','/api/tasks/1/contributions',undefined,checker.auth)).data.contributions;
  assert.equal(records.length,1);assert.equal(records[0].confirmed_by,checker.id);assert.equal(records[0].author_id,worker.id);
});

test('hosted migration applies twice without touching historical task and event rows',async()=>{
  const {DB}=await fixture();
  const before=DB.sqlite.prepare('SELECT * FROM tasks ORDER BY id').all();
  const sql=readFileSync(new URL('../migrations/0004-hosted-collaboration.sql',import.meta.url),'utf8');
  DB.sqlite.exec(sql);DB.sqlite.exec(sql);
  assert.deepEqual(DB.sqlite.prepare('SELECT * FROM tasks ORDER BY id').all(),before);
});

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
