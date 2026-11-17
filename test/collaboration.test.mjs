import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

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
  const fresh=new DatabaseSync(':memory:');fresh.exec(sql);
  for(const {name} of fresh.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='sqlite_sequence'").all()) {
    assert.deepEqual(fresh.prepare(`PRAGMA table_info(${name})`).all(),DB.sqlite.prepare(`PRAGMA table_info(${name})`).all(),`${name}: migration must match runtime schema`);
  }
  fresh.close();
});

test('concurrent proposals create one task; stale issue confirmation fails and disputes reach admin inbox',async()=>{
  const f=await fixture(),{request,DB,admin,host,worker,checker}=f;
  const topic=await request('POST','/api/topics',{theme:'tools',title:'接力测试',content:'提出任务'},host.auth);
  const before=DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  const b={title:'试做',detail:'小样',expected:'演示',value:'核实价值'};
  const proposals=await Promise.all([request('POST',`/api/topics/${topic.data.id}/propose`,b,host.auth),request('POST',`/api/topics/${topic.data.id}/propose`,b,host.auth)]);
  assert.deepEqual(proposals.map(x=>x.status).sort(),[201,409]);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,before+1);
  await hosted(f);
  const issue=(await request('POST','/api/tasks/1/issues',{text:'数据有争议'},checker.auth)).data.id;
  await request('POST',`/api/tasks/1/issues/${issue}/respond`,{text:'修订第一版'},host.auth);
  const old=(await request('GET','/api/tasks/1',undefined,checker.auth)).data.workflow.issues[0].revision;
  await request('POST',`/api/tasks/1/issues/${issue}/respond`,{text:'修订第二版'},host.auth);
  assert.equal((await request('POST',`/api/tasks/1/issues/${issue}/resolve`,{note:'误批旧版',revision:old},checker.auth)).status,409);
  assert.equal((await request('POST',`/api/tasks/1/issues/${issue}/dispute`,{note:'仍未解决：缺少独立来源'},checker.auth)).status,200);
  assert.ok((await request('GET','/api/inbox',undefined,admin)).data.items.some(i=>i.issue_id===issue&&i.state==='disputed'));
});

test('waiting workflows suppress premature host work; revoked or contributing reviewers cannot self-certify',async()=>{
  const f=await fixture(),{request,DB,admin,host,worker,checker}=f;
  await hosted(f);
  assert.equal((await request('POST','/api/tasks/1/wait',{reason:'等财报',resume_at:'2030-01-01T00:00:00Z'},host.auth)).status,200);
  const inbox=(await request('GET','/api/inbox',undefined,host.auth)).data;
  assert.ok(inbox.waiting.some(i=>i.task_id===1));
  assert.equal(inbox.items.some(i=>i.task_id===1&&i.kind==='host'),false);
  await request('POST','/api/tasks/1/supplement',{summary:'我也写了关键结果',links:['https://example.com/checker']},checker.auth);
  const w=(await request('GET','/api/tasks/1',undefined,checker.auth)).data.workflow;
  assert.equal((await request('POST','/api/tasks/1/reviews',{fingerprint:w.fingerprint,note:'自批补充',evidence:['https://example.com/checker']},checker.auth)).status,403);
  await request('POST',`/api/admin/agents/${checker.id}/revoke`,{},admin);
  assert.equal((await request('GET','/api/inbox',undefined,checker.auth)).status,401);
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
  assert.equal((await request('POST','/api/tasks/1/verify',{force:true,force_reason:'试图跳过独立核查'},admin)).status,400);
  assert.equal((await request('GET','/api/inbox')).status,401);
  assert.equal((await request('GET','/api/inbox',undefined,checker.auth)).data.items.some(i=>i.task_id===1),true);
  assert.equal((await request('POST','/api/tasks/1/reviews',{...check,fingerprint:d.workflow.fingerprint},checker.auth)).status,201);
  assert.equal((await request('POST','/api/tasks/1/verify',{},admin)).status,200);
});

test('hosted content and opposing views use independently configured acceptance rules',async()=>{
  for(const type of ['creative','debate']) {
    const f=await fixture(),{request,DB,admin,host,worker,checker}=f;
    await hosted(f);
    const initial=(await request('GET','/api/tasks/1',undefined,admin)).data.plan;
    assert.equal((await request('POST','/api/tasks/1/plan',{revision:initial.revision,goal:type==='creative'?'content':'analysis',acceptance:{criteria:'按约定验收',min_sources:0,independent_review:type!=='creative',opposing_views:type==='debate'}},admin)).status,200);
    let d=(await request('GET','/api/tasks/1',undefined,checker.auth)).data;
    if(type==='creative') {assert.equal(d.verify_readiness.ready,true);continue;}
    await request('POST','/api/tasks/1/reviews',{fingerprint:d.workflow.fingerprint,note:'已核对论据',evidence:['https://example.com']},checker.auth);
    d=(await request('GET','/api/tasks/1',undefined,checker.auth)).data;
    assert.equal(d.verify_readiness.ready,false);
    await request('POST','/api/tasks/1/debate',{stance:'支持',content:'支持理由'},worker.auth);
    await request('POST','/api/tasks/1/debate',{stance:'反驳',content:'反方理由',links:['https://example.com/evidence']},host.auth);
    assert.equal((await request('GET','/api/tasks/1',undefined,checker.auth)).data.verify_readiness.ready,true);
  }
});

test('issues require independent resolution and remain in help queue after legacy counters turn green',async()=>{
  const f=await fixture(),{request,admin,host,worker,checker}=f;
  await hosted(f);
  const issue=await request('POST','/api/tasks/1/issues',{text:'价格不准确',severity:'blocking'},checker.auth);
  assert.equal(issue.status,201);
  assert.equal((await request('POST',`/api/tasks/2/issues/${issue.data.id}/respond`,{text:'跨任务'},host.auth)).status,404);
  assert.equal((await request('POST',`/api/tasks/1/issues/${issue.data.id}/respond`,{text:'已按官网更正',evidence:['https://example.com/fix']},host.auth)).status,200);
  assert.equal((await request('POST',`/api/tasks/1/issues/${issue.data.id}/resolve`,{note:'自批'},host.auth)).status,403);
  assert.equal((await request('POST',`/api/tasks/1/issues/${issue.data.id}/resolve`,{note:'核对修正正确',revision:1},checker.auth)).status,200);
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
