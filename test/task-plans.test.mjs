import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './helpers.mjs';
import {createNextOccurrence,TASK_PLAN_SCHEMA} from '../src/task-plan.js';
import {hashSecret} from '../src/auth.js';

const source='https://example.com/official',reportUrl='https://reports.example.com/market';
async function create(f,plan={}) {
  const response=await f.request('POST','/api/tasks',{title:'报告协作',detail:'核实变化，制作可发布网页',plan},f.admin);
  assert.equal(response.status,201,JSON.stringify(response.data));return response.data.id;
}
async function detail(f,id) {const r=await f.request('GET',`/api/tasks/${id}`,undefined,f.admin);assert.equal(r.status,200);return r.data;}
async function publish(f,id,revision,author=f.worker.auth,extra={}) {
  const d=await detail(f,id);
  return f.request('POST',`/api/tasks/${id}/outcomes`,{summary:`当前报告 ${revision}`,links:[source],changes:`发布 ${revision}`,source_refs:[],fingerprint:d.workflow.fingerprint,report:{url:reportUrl,revision,title:'市场报告'},...extra},author);
}
async function review(f,id,extra={}) {
  const d=await detail(f,id);
  return f.request('POST',`/api/tasks/${id}/reviews`,{fingerprint:d.workflow.fingerprint,note:'已打开网页，对照发布版本与官方材料，检查结论及移动版图表',evidence:[reportUrl,source],report_revision:d.workflow.outcomes[0]?.report?.revision,...extra},f.checker.auth);
}

test('goal templates initialize acceptance; later goal changes preserve it, including factual content',async()=>{
  const f=await fixture();
  const id=await create(f,{goal:'content',acceptance:{criteria:'核实促销日期',independent_review:true,min_sources:1}});
  let d=await detail(f,id);
  assert.equal(d.plan.acceptance.independent_review,true);
  assert.equal((await f.request('POST',`/api/tasks/${id}/claim`,{},f.worker.auth)).status,200);
  await f.request('POST',`/api/tasks/${id}/result`,{summary:'含产品事实的文案',links:[source]},f.worker.auth);
  d=await detail(f,id);
  assert.equal(d.verify_readiness.ready,false);
  assert.equal(d.verify_readiness.checks.find(c=>c.key==='independent').met,false);
  assert.equal((await f.request('POST',`/api/tasks/${id}/plan`,{revision:d.plan.revision,goal:'build'},f.admin)).status,200);
  const updated=await detail(f,id);
  assert.deepEqual(updated.plan.acceptance,d.plan.acceptance);
  assert.equal(updated.plan.goal,'build');
  assert.equal((await f.request('POST',`/api/tasks/${id}/plan`,{revision:d.plan.revision,goal:'research'},f.admin)).status,409);
  assert.equal((await f.request('POST',`/api/tasks/${id}/plan`,{revision:updated.plan.revision,goal:'research'},f.worker.auth)).status,403);
  await f.request('POST',`/api/tasks/${id}/workflow`,{host_id:f.host.id,acceptance:'核实促销日期'},f.admin);
  assert.deepEqual((await detail(f,id)).plan.acceptance,updated.plan.acceptance);
  const pure=await create(f,{goal:'content'});
  assert.equal((await detail(f,pure)).plan.acceptance.independent_review,false);
  const report=await create(f,{goal:'content',delivery:{format:'web_report'}});
  assert.equal((await detail(f,report)).plan.acceptance.independent_review,true);
});

test('invalid plans are rejected before a task or topic proposal is written',async()=>{
  const f=await fixture(),before=f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  const invalid=[{goal:'debate'},{acceptance:{min_sources:'1'}},{acceptance:{independent_review:1}},{schedule:{kind:'recurring'}},{schedule:{kind:'event',event:''}},{schedule:{kind:'once',start_at:'2030-01-01T10:00'}},{delivery:{author_id:99999}}];
  for(const plan of invalid) assert.equal((await f.request('POST','/api/tasks',{title:'invalid',plan},f.admin)).status,400);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,before);
  const topic=await f.request('POST','/api/topics',{theme:'tools',title:'报告工具',content:'制作网页'},f.host.auth);
  const proposal=await f.request('POST',`/api/topics/${topic.data.id}/propose`,{title:'报告提案',detail:'说明',expected:'网页',value:'阅读方便',plan:{goal:'analysis',delivery:{format:'web_report',author_id:f.worker.id},schedule:{kind:'event',event:'公告发布'}}},f.host.auth);
  assert.equal(proposal.status,201);
  const d=await detail(f,proposal.data.id);
  assert.equal(d.plan.goal,'analysis');assert.equal(d.plan.schedule.event,'公告发布');assert.equal(d.plan.delivery.author_id,f.worker.id);
});

test('MUSE reports support a dedicated author, independent findings, revision and re-verification',async()=>{
  const f=await fixture();
  const id=await create(f,{goal:'analysis',collaboration:'hosted',acceptance:{min_sources:1},delivery:{format:'web_report',author_id:f.worker.id}});
  assert.equal((await f.request('POST',`/api/tasks/${id}/workflow`,{host_id:f.host.id,acceptance:'结论有依据，页面可阅读',min_sources:1},f.admin)).status,200);
  assert.equal((await publish(f,id,'v1',f.checker.auth)).status,403);
  assert.equal((await publish(f,id,'v1',f.worker.auth,{report:{url:'javascript:alert(1)',revision:'v1'}})).status,400);
  assert.equal((await publish(f,id,'v1',f.worker.auth,{report:null})).status,400);
  assert.equal((await publish(f,id,'v1')).status,201);
  let d=await detail(f,id),v1=d.workflow.fingerprint;
  assert.equal(d.workflow.outcomes[0].report.url,reportUrl);
  assert.equal(d.workflow.outcomes[0].author_id,f.worker.id);
  const authorInbox=(await f.request('GET','/api/inbox',undefined,f.worker.auth)).data;
  assert.equal(authorInbox.items.some(i=>i.task_id===id&&i.kind==='report'),false);
  assert.ok(authorInbox.waiting.some(i=>i.task_id===id&&i.kind==='report_review'));
  assert.ok((await f.request('GET','/api/inbox',undefined,f.checker.auth)).data.items.some(i=>i.task_id===id&&i.report?.revision==='v1'));
  assert.equal((await f.request('POST',`/api/tasks/${id}/reviews`,{fingerprint:v1,note:'自己核查',evidence:[reportUrl],report_revision:'v1'},f.worker.auth)).status,403);
  assert.equal((await review(f,id,{report_revision:'v0'})).status,400);
  assert.equal((await review(f,id,{evidence:[source]})).status,400);
  assert.equal((await review(f,id)).status,201);
  assert.equal((await detail(f,id)).verify_readiness.ready,true);
  const issue=await f.request('POST',`/api/tasks/${id}/issues`,{fingerprint:v1,text:'图表单位与官方来源不一致',severity:'blocking'},f.checker.auth);
  assert.equal(issue.status,201);
  assert.ok((await f.request('GET','/api/inbox',undefined,f.worker.auth)).data.items.some(i=>i.task_id===id&&i.issue_id===issue.data.id));
  assert.equal((await f.request('POST',`/api/tasks/${id}/verify`,{},f.admin)).status,400);
  assert.equal((await f.request('POST',`/api/tasks/${id}/issues/${issue.data.id}/respond`,{text:'已统一图表单位，即将发布新版',evidence:[source]},f.worker.auth)).status,200);
  assert.equal((await publish(f,id,'v1')).status,409);
  assert.equal((await publish(f,id,'v2',f.worker.auth,{fingerprint:v1})).status,409);
  assert.equal((await publish(f,id,'v2')).status,201);
  d=await detail(f,id);
  assert.equal(d.workflow.current_reviews.length,0);
  assert.equal(d.workflow.outcomes.length,2);
  assert.equal(d.workflow.outcomes[1].report.revision,'v1');
  assert.equal(d.workflow.issues[0].outcome_id,d.workflow.outcomes[1].id);
  assert.equal((await review(f,id,{fingerprint:v1})).status,409);
  assert.equal((await f.request('POST',`/api/tasks/${id}/issues`,{fingerprint:v1,text:'旧页面问题'},f.checker.auth)).status,409);
  const resolution={revision:d.workflow.issues[0].revision,note:'已打开 v2，图表单位已修正',fingerprint:d.workflow.fingerprint};
  assert.equal((await f.request('POST',`/api/tasks/${id}/issues/${issue.data.id}/resolve`,resolution,f.worker.auth)).status,403);
  assert.equal((await f.request('POST',`/api/tasks/${id}/issues/${issue.data.id}/resolve`,resolution,f.checker.auth)).status,200);
  assert.equal((await review(f,id)).status,201);
  assert.equal((await f.request('POST',`/api/tasks/${id}/verify`,{},f.admin)).status,200);
  const list=(await f.request('GET','/api/tasks',undefined,f.admin)).data.tasks.find(t=>t.id===id);
  assert.equal(list.report.revision,'v2');assert.equal(list.goal,'analysis');
});

test('a report link does not count as its factual source, and simultaneous versions have one winner',async()=>{
  const f=await fixture(),id=await create(f,{goal:'research',delivery:{format:'web_report',author_id:f.worker.id}});
  assert.equal((await publish(f,id,'v1',f.worker.auth,{links:[reportUrl]})).status,201);
  let d=await detail(f,id);
  assert.equal(d.verify_readiness.checks.find(c=>c.key==='sources').met,false);
  const base=d.workflow.fingerprint;
  const results=await Promise.all(['v2','v3'].map(revision=>publish(f,id,revision,f.worker.auth,{fingerprint:base})));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  d=await detail(f,id);assert.equal(d.workflow.outcomes.length,2);
});

test('future and event schedules gate work, expose waiting reasons and activate with recorded evidence',async()=>{
  const f=await fixture();
  const future=await create(f,{schedule:{kind:'once',start_at:'2099-01-01T09:00:00+08:00'}});
  const event=await create(f,{schedule:{kind:'event',event:'官方公告已经发布'}});
  let queue=(await f.request('GET','/api/tasks?needs=agent',undefined,f.worker.auth)).data.tasks;
  assert.equal(queue.some(t=>[future,event].includes(t.id)),false);
  for(const id of [future,event]) assert.equal((await f.request('POST',`/api/tasks/${id}/claim`,{},f.worker.auth)).status,409);
  const inbox=(await f.request('GET','/api/inbox',undefined,f.worker.auth)).data;
  assert.equal(inbox.waiting.some(t=>t.task_id===event&&t.reason.includes('官方公告')),true);
  let d=await detail(f,event);
  assert.equal((await f.request('POST',`/api/tasks/${event}/trigger`,{revision:d.plan.revision,note:'官网已发布'},f.worker.auth)).status,400);
  const triggered=await f.request('POST',`/api/tasks/${event}/trigger`,{revision:d.plan.revision,note:'官网已发布',evidence:[source]},f.worker.auth);
  assert.equal(triggered.status,200);assert.equal(triggered.data.plan.revision,d.plan.revision+1);
  assert.equal((await f.request('POST',`/api/tasks/${event}/trigger`,{revision:d.plan.revision,note:'重复',evidence:[source]},f.worker.auth)).status,409);
  queue=(await f.request('GET','/api/tasks?needs=agent',undefined,f.worker.auth)).data.tasks;
  assert.equal(queue.some(t=>t.id===event),true);
  assert.equal((await f.request('POST',`/api/tasks/${event}/claim`,{},f.worker.auth)).status,200);
  d=await detail(f,event);
  assert.equal((await f.request('POST',`/api/tasks/${event}/plan`,{revision:d.plan.revision,goal:'analysis'},f.admin)).status,200);
  assert.ok((await detail(f,event)).plan.schedule.triggered_at);
});

test('recurring acceptance creates exactly one future task without reusing reports or reviews',async()=>{
  const f=await fixture(),start=new Date(Date.now()-3600000).toISOString();
  const id=await create(f,{goal:'content',schedule:{kind:'recurring',start_at:start,interval_days:1}});
  await f.request('POST',`/api/tasks/${id}/claim`,{},f.worker.auth);
  await f.request('POST',`/api/tasks/${id}/result`,{summary:'今日日报'},f.worker.auth);
  const verified=await f.request('POST',`/api/tasks/${id}/verify`,{},f.admin);
  assert.equal(verified.status,200,JSON.stringify(verified.data));
  const next=verified.data.next_task_id;
  assert.ok(next);
  const current=await detail(f,id),future=await detail(f,next);
  assert.equal(current.task.status,'done');assert.equal(current.workflow.next_task_id,next);
  assert.equal(future.task.status,'open');assert.equal(future.workflow.previous_task_id,id);
  assert.equal(future.workflow.outcomes.length,0);assert.equal(future.workflow.reviews.length,0);
  assert.equal(Date.parse(future.plan.schedule.start_at)-Date.parse(start),86400000);
  assert.equal((await f.request('POST',`/api/tasks/${next}/claim`,{},f.worker.auth)).status,409);
  assert.equal(await createNextOccurrence(f.DB,current.task,current.plan),next);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM task_recurrences WHERE previous_task_id=?').get(id).n,1);
});

test('a failure creating the next period rolls back acceptance and its award, then safely retries',async()=>{
  const f=await fixture(),id=await create(f,{goal:'content',schedule:{kind:'recurring',start_at:new Date(Date.now()-3600000).toISOString(),interval_days:1}});
  await f.request('POST',`/api/tasks/${id}/workflow`,{host_id:f.host.id,acceptance:'按作品质量验收',min_sources:0},f.admin);
  await f.request('POST',`/api/tasks/${id}/claim`,{},f.worker.auth);
  await f.request('POST',`/api/tasks/${id}/result`,{summary:'今日内容'},f.worker.auth);
  const prepare=f.DB.prepare;
  f.DB.prepare=function(sql) {const statement=prepare.call(this,sql);if(sql.startsWith('INSERT INTO task_recurrences')) statement.execute=()=>{throw Error('simulated next-period failure');};return statement;};
  await assert.rejects(f.request('POST',`/api/tasks/${id}/verify`,{},f.admin),/simulated/);
  f.DB.prepare=prepare;
  assert.equal((await detail(f,id)).task.status,'review');
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type='verify'").get(id).n,0);
  const done=await f.request('POST',`/api/tasks/${id}/verify`,{},f.admin);
  assert.equal(done.status,200);
  const next=await detail(f,done.data.next_task_id);
  assert.equal(next.workflow.host_id,f.host.id);
  assert.equal(next.plan.acceptance.independent_review,false);
  assert.equal(next.plan.acceptance.criteria,'按作品质量验收');
});

test('task plan migration is repeatable and leaves legacy tasks and their gates unchanged',async()=>{
  const f=await fixture(),before=f.DB.sqlite.prepare('SELECT * FROM tasks').all();
  const migration=readFileSync(new URL('../migrations/0006-task-plans-reports.sql',import.meta.url),'utf8');
  const statements=s=>s.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
  assert.deepEqual(statements(migration),statements(TASK_PLAN_SCHEMA));
  for(let i=0;i<2;i++) f.DB.sqlite.exec(migration);
  assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM tasks').all(),before);
  const d=await detail(f,1);
  assert.equal(d.plan.configured,false);
  assert.ok(d.verify_readiness.checks.some(c=>c.key==='challenge'));
  // Reviews from before this migration must remain valid for untouched hosted history.
  f.DB.sqlite.prepare("UPDATE tasks SET status='done',claimed_by=?,result_summary='历史成果',result_links=? WHERE id=1").run(f.worker.name,source);
  f.DB.sqlite.prepare("INSERT INTO task_workflows(task_id,host_id,acceptance,min_sources,created_at) VALUES(1,?,'旧验收',1,'2026-11-16')").run(f.host.id);
  const fingerprint=await hashSecret(JSON.stringify({summary:'历史成果',links:source,claimant:f.worker.name,profile:{host_id:f.host.id,acceptance:'旧验收',min_sources:1},outcome:null,issues:[]}));
  f.DB.sqlite.prepare("INSERT INTO work_reviews(task_id,reviewer_id,fingerprint,note,evidence,created_at) VALUES(1,?,?,'历史核查',?,'2026-11-16')").run(f.checker.id,fingerprint,source);
  const history=await detail(f,1);
  assert.equal(history.workflow.fingerprint,fingerprint);
  assert.equal(history.workflow.current_reviews.length,1);
  assert.equal(history.verify_readiness.ready,true);
});
