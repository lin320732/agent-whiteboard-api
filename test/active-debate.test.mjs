import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './helpers.mjs';
import {debateProgress} from '../src/active-debate.js';

async function setup(t,extra={}) {
  let at=Date.now();t.mock.method(Date,'now',()=>at);
  const f=await fixture(),end=new Date(at+3*3600000).toISOString();
  const made=await f.request('POST','/api/tasks',{title:'激辩测试',type:'active_debate',plan:{schedule:{end_at:end},...extra}},f.admin);
  assert.equal(made.status,201,JSON.stringify(made.data));
  const id=made.data.id;
  const detail=async(auth=f.worker.auth)=>(await f.request('GET',`/api/tasks/${id}`,undefined,auth)).data;
  const say=async(actor,content,stance='支持',reply_to=null,body={})=>{
    const d=await detail(actor.auth);
    return f.request('POST',`/api/tasks/${id}/debate`,{content,stance,reply_to,expected_latest_id:d.workflow.discussion.last_message_id,...body},actor.auth);
  };
  const inbox=async(actor=f.worker)=>(await f.request('GET','/api/inbox',undefined,actor.auth)).data;
  return {...f,id,end,detail,say,inbox,advance(ms=600000){at+=ms;},endNow(){at=Date.parse(end);},time:()=>at};
}

test('adopted history with no recorded creation time remains readable without inventing activity',()=>{
  const at=Date.now(),progress=debateProgress({status:'open'},{schedule:{end_at:new Date(at+3600000).toISOString()}},[],at);
  assert.equal(progress.last_activity_at,null);assert.equal(progress.phase,'active');assert.equal(progress.rounds,0);
  assert.equal(progress.poll_after_seconds,300);assert.equal('per_poll_limit' in progress,false);
  assert.equal(Date.parse(progress.cold_at)-at,1800000);
});

test('active debate requires an explicit zoned deadline and compatible plan before writing anything',async()=>{
  const f=await fixture(),before=f.DB.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  const future=new Date(Date.now()+86400000).toISOString();
  for(const plan of [{},{schedule:{end_at:'2030-01-01T10:00'}},{schedule:{kind:'recurring',start_at:future,end_at:future,interval_days:1}},{schedule:{end_at:future},acceptance:{independent_review:true}},{schedule:{end_at:future},delivery:{format:'web_report'}},{goal:'content',schedule:{end_at:future}}]) {
    assert.equal((await f.request('POST','/api/tasks',{title:'invalid',type:'active_debate',plan},f.admin)).status,400);
  }
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n,before);
  const created=await f.request('POST','/api/tasks',{title:'新激辩',plan:{goal:'active_debate',schedule:{end_at:future}}},f.admin);
  assert.equal(created.status,201);
  const d=(await f.request('GET',`/api/tasks/${created.data.id}`,undefined,f.worker.auth)).data;
  assert.equal(d.task.type,'active_debate');assert.equal(d.plan.acceptance.independent_review,false);
  assert.equal(d.collaboration.suggested_action,'debate');assert.equal(d.workflow.discussion.next_action.kind,'enter');
  assert.equal(d.verify_readiness.ready,false);
});

test('unclaimed discussion invites everyone, prioritizes direct replies and preserves stable author IDs after renaming',async t=>{
  const f=await setup(t);
  assert.equal((await f.inbox()).items.find(i=>i.task_id===f.id).kind,'active_debate');
  const first=await f.say(f.worker,'我主张先公开论证假设，再讨论结论是否成立。');assert.equal(first.status,201);
  assert.equal((await f.say(f.worker,'没有新内容时再补一条')).status,429);
  const second=await f.say(f.checker,'这个前提忽略了实际成本，需要先回答投入如何衡量。','反駁',first.data.message.id);assert.equal(second.status,201);
  const other=await f.request('POST','/api/tasks',{title:'另一个激辩',type:'active_debate',plan:{schedule:{end_at:f.end}}},f.admin);
  f.advance();
  const pending=await f.inbox();assert.equal(pending.poll_after_seconds,300);
  assert.equal(pending.items.filter(i=>i.kind==='active_debate')[0].task_id,f.id);
  assert.equal((await f.request('POST',`/api/tasks/${other.data.id}/debate`,{content:'引用另一场讨论的发言。',stance:'支持',reply_to:first.data.message.id,expected_latest_id:0},f.worker.auth)).status,400);
  let turn=(await f.inbox()).items.find(i=>i.task_id===f.id);
  assert.equal(turn.action,'reply');assert.equal(turn.reply_to,second.data.message.id);
  assert.equal((await f.say(f.worker,'绕过待回应事项，另开一个完全不同的话题。')).status,400);
  await f.request('POST',`/api/admin/agents/${f.worker.id}/name`,{name:'新的显示名'},f.admin);
  const reply=await f.say(f.worker,'我接受成本需要衡量，但公开假设本身能降低后续验证成本。','反駁',second.data.message.id);
  assert.equal(reply.status,201);
  const d=await f.detail();assert.equal(d.workflow.discussion.rounds,1);assert.equal(d.workflow.discussion.participants,2);
  assert.equal(d.task.claimed_by,null);assert.equal(d.task.status,'in_progress');
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/claim`,{},f.host.auth)).status,409);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/result`,{summary:'提前收尾'},f.worker.auth)).status,409);
  turn=(await f.inbox(f.host)).items.find(i=>i.task_id===f.id);assert.equal(turn.action,'enter');
});

test('optimistic writes and retries remain safe while one Agent can post to separate tasks concurrently',async t=>{
  const f=await setup(t),path=`/api/tasks/${f.id}/debate`,body={stance:'支持',content:'先列出可证伪的主张，再用不同情境检验它。',expected_latest_id:0};
  const replies=await Promise.all([f.request('POST',path,body,f.worker.auth),f.request('POST',path,{...body,content:'我更看重公开讨论中对少数观点的充分回应。'},f.checker.auth)]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[201,409]);
  const winner=replies[0].status===201?f.worker:f.checker;
  const chosen=replies[0].status===201?body:{...body,content:'我更看重公开讨论中对少数观点的充分回应。'};
  const retry=await f.request('POST',path,chosen,winner.auth);assert.equal(retry.status,200);assert.equal(retry.data.replayed,true);
  assert.equal((await f.request('POST',path,{...chosen,stance:'補充'},winner.auth)).status,409);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM debate_messages WHERE task_id=?').get(f.id).n,1);
  const next=await f.request('POST','/api/tasks',{title:'另一场',type:'active_debate',plan:{schedule:{end_at:f.end}}},f.admin);
  const third=await f.request('POST','/api/tasks',{title:'第三场',type:'active_debate',plan:{schedule:{end_at:f.end}}},f.admin);
  const due=(await f.inbox(winner)).items.filter(i=>[next.data.id,third.data.id].includes(i.task_id));
  assert.equal(due.length,2);assert.ok(due.every(i=>i.action==='enter'));
  const concurrent=await Promise.all([
    f.request('POST',`/api/tasks/${next.data.id}/debate`,{...body,content:'在另一场激辩中给出独立观点。'},winner.auth),
    f.request('POST',`/api/tasks/${third.data.id}/debate`,{...body,content:'在第三场激辩中给出独立观点。'},winner.auth),
  ]);
  assert.deepEqual(concurrent.map(r=>r.status),[201,201]);
  f.advance(1800000);
  const duplicate=await f.request('POST',path,{...chosen,expected_latest_id:retry.data.message.id},winner.auth);assert.equal(duplicate.status,409);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM active_debate_messages').get().n,3);
});

test('one Agent can answer every direct reply in the same task without waiting for another poll',async t=>{
  const f=await setup(t);
  const first=await f.say(f.worker,'先明确讨论中的核心假设。');assert.equal(first.status,201);
  const fromChecker=await f.say(f.checker,'我质疑这个假设忽略了成本。','反駁',first.data.message.id);
  const fromHost=await f.say(f.host,'我还想追问适用的时间范围。','反駁',first.data.message.id);
  assert.equal(fromChecker.status,201);assert.equal(fromHost.status,201);
  let pending=(await f.inbox()).items.find(i=>i.task_id===f.id);
  assert.deepEqual(pending.pending_reply_ids,[fromChecker.data.message.id,fromHost.data.message.id]);
  assert.equal((await f.say(f.worker,'成本应按可验证的投入来算。','補充',fromChecker.data.message.id)).status,201);
  pending=(await f.inbox()).items.find(i=>i.task_id===f.id);
  assert.deepEqual(pending.pending_reply_ids,[fromHost.data.message.id]);
  assert.equal((await f.say(f.worker,'时间范围应覆盖整个执行周期。','補充',fromHost.data.message.id)).status,201);
  assert.ok((await f.inbox()).waiting.some(i=>i.task_id===f.id));
  assert.equal((await f.say(f.worker,'没有新回复时继续发言')).status,429);
});

test('thirty minutes of inactivity creates an icebreaker turn, and stale simultaneous icebreakers cannot both land',async t=>{
  const f=await setup(t),first=await f.say(f.worker,'讨论先从一个能够被反例挑战的判断开始。');
  f.advance();
  let waiting=(await f.inbox()).waiting.find(i=>i.task_id===f.id);assert.equal(waiting.action,'wait');
  f.advance(1200000);
  assert.equal((await f.inbox()).items.find(i=>i.task_id===f.id).action,'icebreak');
  const d=await f.detail();
  assert.equal((await f.say(f.worker,'换一个情境：当参与者掌握的信息不对称时，原结论还成立吗？','補充')).status,201);
  const stale=await f.request('POST',`/api/tasks/${f.id}/debate`,{content:'另一条过期上下文破冰',stance:'支持',expected_latest_id:d.workflow.discussion.last_message_id},f.host.auth);
  assert.equal(stale.status,409);assert.ok(first.data.message.id);
});

test('three disjoint exchanges keep discussion open until deadline, then summary and admin acceptance finish without new awards',async t=>{
  const f=await setup(t),awards=f.DB.sqlite.prepare('SELECT COUNT(*) n FROM events').get().n;
  let last=(await f.say(f.worker,'我的判断是先讨论假设，能够更快找出真正有分歧的地方。')).data.message;
  for(let round=0;round<3;round++) {
    if(round) f.advance();
    const rebuttal=await f.say(f.checker,`第 ${round+1} 轮：只谈假设仍不足，请回应这个具体情境下的代价与取舍。`,'反駁',last.id);
    assert.equal(rebuttal.status,201,JSON.stringify(rebuttal.data));f.advance();
    const response=await f.say(f.worker,`第 ${round+1} 轮回应：应明确区分可验证的事实与价值取舍，并按情境修正我的主张。`,'反駁',rebuttal.data.message.id);
    assert.equal(response.status,201,JSON.stringify(response.data));last=response.data.message;
  }
  let d=await f.detail();assert.equal(d.workflow.discussion.rounds,3);assert.equal(d.workflow.discussion.participation_sufficient,true);
  assert.equal(d.task.status,'in_progress');assert.equal(d.verify_readiness.ready,false);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/outcomes`,{fingerprint:d.workflow.fingerprint,summary:'太早总结',changes:'总结'},f.worker.auth)).status,409);
  f.endNow();d=await f.detail();assert.equal(d.task.status,'review');assert.equal(d.workflow.discussion.phase,'ended');
  assert.equal((await f.say(f.host,'截止后仍尝试加入的新观点')).status,409);
  const summary={fingerprint:d.workflow.fingerprint,summary:'双方争议集中在信息成本，已接受应按具体情境修正，仍对执行顺序保留分歧。',links:[],changes:'截止总结',source_refs:[]};
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/outcomes`,summary,f.checker.auth)).status,403);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/outcomes`,summary,f.worker.auth)).status,201);
  d=await f.detail();assert.equal(d.verify_readiness.ready,true);
  const issue=await f.request('POST',`/api/tasks/${f.id}/issues`,{text:'总结遗漏了对适用情境的分歧，需要补足。',severity:'blocking'},f.checker.auth);
  assert.equal(issue.status,201);d=await f.detail();assert.equal(d.verify_readiness.ready,false);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/verify`,{},f.admin)).status,400);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/issues/${issue.data.id}/respond`,{text:'总结已列明适用情境与保留分歧。'},f.worker.auth)).status,200);
  d=await f.detail();
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/issues/${issue.data.id}/resolve`,{note:'已确认总结中的适用情境与分歧说明。',revision:d.workflow.issues[0].revision},f.admin)).status,200);
  assert.equal((await f.detail()).verify_readiness.ready,true);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/verify`,{},f.worker.auth)).status,403);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/verify`,{},f.admin)).status,200);
  assert.equal((await f.detail()).task.status,'done');
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM events').get().n,awards);
});

test('insufficient discussion expires into admin decisions, cannot force acceptance, and closes with a reason',async t=>{
  const f=await setup(t);await f.say(f.worker,'先提出一个独立的观点，等待其他参与者质疑。');f.endNow();
  let d=await f.detail();assert.equal(d.task.status,'review');assert.equal(d.workflow.discussion.participation_sufficient,false);
  const inbox=(await f.request('GET','/api/inbox',undefined,f.admin)).data;
  assert.ok(inbox.items.some(i=>i.task_id===f.id&&i.reason.includes('参与不足')));
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/verify`,{force:true,force_reason:'忽略不足'},f.admin)).status,400);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/close`,{reason:'参与不足，结束本次讨论'},f.worker.auth)).status,403);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/close`,{},f.admin)).status,400);
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/close`,{reason:'参与不足，结束本次讨论'},f.admin)).status,200);
  d=await f.detail();assert.equal(d.task.status,'closed');
  assert.equal((await f.say(f.worker,'关闭以后继续尝试发言')).status,400);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) n FROM work_activity WHERE task_id=? AND kind='discussion_close'").get(f.id).n,1);
  const activity=(await f.request('GET',`/api/tasks/${f.id}/activity`,undefined,f.admin)).data;
  assert.ok(JSON.stringify(activity).includes('参与不足，结束本次讨论'));
});

test('future, proposed, cross-task and self-replies cannot manufacture participation or exchanges',async t=>{
  const f=await setup(t,{schedule:{start_at:new Date(Date.now()+3600000).toISOString(),end_at:new Date(Date.now()+7200000).toISOString()}});
  assert.equal((await f.say(f.worker,'尚未开始时提前发言')).status,409);
  const made=await f.request('POST','/api/tasks',{title:'Agent 自提激辩',type:'active_debate',plan:{schedule:{end_at:f.end}}},f.worker.auth);
  assert.equal(made.data.status,'proposed');
  assert.equal((await f.request('POST',`/api/tasks/${made.data.id}/debate`,{stance:'支持',content:'未批准先发言',expected_latest_id:0},f.worker.auth)).status,409);
  const task={status:'in_progress',created_at:new Date().toISOString()},plan={schedule:{end_at:f.end}};
  const messages=Array.from({length:7},(_,i)=>({id:i+1,author_id:f.worker.id,role:'agent',stance:i?'反駁':'支持',content:'同一个作者的自我回复',reply_to:i||null,created_at:new Date().toISOString()}));
  const progress=debateProgress(task,plan,messages);assert.equal(progress.rounds,0);assert.equal(progress.participants,1);assert.equal(progress.opposing_views,false);
  messages[1].author_id=f.checker.id;messages[2].author_id=f.worker.id;
  assert.equal(debateProgress(task,plan,messages).rounds,1);
});

test('extending the deadline resumes discussion and invalidates an earlier summary',async t=>{
  const f=await setup(t);await f.say(f.worker,'我先主张用具体反例检验当前观点。');f.endNow();
  let d=await f.detail();
  await f.request('POST',`/api/tasks/${f.id}/outcomes`,{summary:'本次参与不足，只有一个观点。',changes:'截止总结',fingerprint:d.workflow.fingerprint},f.worker.auth);
  d=await f.detail();assert.equal(d.workflow.discussion.has_summary,true);
  const end_at=new Date(f.time()+3600000).toISOString();
  assert.equal((await f.request('POST',`/api/tasks/${f.id}/plan`,{revision:d.plan.revision,schedule:{end_at}},f.admin)).status,200);
  d=await f.detail();assert.equal(d.task.status,'in_progress');assert.equal(d.workflow.discussion.has_summary,false);
  assert.equal((await f.say(f.checker,'我来反驳原来的假设，补充一个边界情境。','反駁',d.debate[0].id)).status,201);
});

test('topic proposals retain active-debate plans and earlier migration remains repeatable',async()=>{
  const f=await fixture(),end_at=new Date(Date.now()+86400000).toISOString();
  const topic=await f.request('POST','/api/topics',{theme:'tools',title:'工具是否值得订阅',content:'欢迎提出不同观点'},f.worker.auth);
  const proposal=await f.request('POST',`/api/topics/${topic.data.id}/propose`,{title:'订阅激辩',detail:'来回讨论',expected:'观点与分歧总结',value:'比较不同使用情境',type:'active_debate',plan:{schedule:{end_at}}},f.worker.auth);
  assert.equal(proposal.status,201);assert.equal(proposal.data.status,'proposed');
  const d=(await f.request('GET',`/api/tasks/${proposal.data.id}`,undefined,f.admin)).data;assert.equal(d.plan.goal,'active_debate');
  const old=f.DB.sqlite.prepare('SELECT * FROM tasks').all(),sql=readFileSync(new URL('../migrations/0008-active-debate.sql',import.meta.url),'utf8');
  f.DB.sqlite.exec(sql);f.DB.sqlite.exec(sql);assert.deepEqual(f.DB.sqlite.prepare('SELECT * FROM tasks').all(),old);
});

test('reply migration removes the old time-window constraint and preserves history on repeat',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0008-active-debate.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO active_debate_messages(message_id,task_id,author_id,content_key,base_message_id,poll_slot) VALUES (?,?,?,?,?,?)').run(41,17,7,'existing-message',0,123);
  const migration=readFileSync(new URL('../migrations/0010-active-debate-replies.sql',import.meta.url),'utf8');
  db.exec(migration);db.exec(migration);
  assert.deepEqual(db.prepare('SELECT message_id,task_id,author_id,content_key,base_message_id,poll_slot FROM active_debate_messages').all().map(row=>({...row})),[{message_id:41,task_id:17,author_id:7,content_key:'existing-message',base_message_id:0,poll_slot:123}]);
  db.prepare('INSERT INTO active_debate_messages(message_id,task_id,author_id,content_key,base_message_id,poll_slot) VALUES (?,?,?,?,?,?)').run(42,18,7,'another-task',0,123);
  assert.throws(()=>db.prepare('INSERT INTO active_debate_messages(message_id,task_id,author_id,content_key,base_message_id) VALUES (?,?,?,?,?)').run(43,17,7,'existing-message',41),/UNIQUE constraint/);
  db.close();
});

test('new posting code accepts concurrent task posts before the old table is migrated',async t=>{
  const f=await setup(t),db=f.DB.sqlite;
  db.exec('DROP TABLE active_debate_messages');
  db.exec(readFileSync(new URL('../migrations/0008-active-debate.sql',import.meta.url),'utf8'));
  const other=await f.request('POST','/api/tasks',{title:'旧库中的第二场激辩',type:'active_debate',plan:{schedule:{end_at:f.end}}},f.admin);
  const posted=await Promise.all([
    f.request('POST',`/api/tasks/${f.id}/debate`,{stance:'支持',content:'第一场的独立观点。',expected_latest_id:0},f.worker.auth),
    f.request('POST',`/api/tasks/${other.data.id}/debate`,{stance:'支持',content:'第二场的独立观点。',expected_latest_id:0},f.worker.auth),
  ]);
  assert.deepEqual(posted.map(r=>r.status),[201,201]);
  assert.deepEqual(db.prepare('SELECT poll_slot FROM active_debate_messages ORDER BY message_id').all().map(row=>row.poll_slot),[null,null]);
});
