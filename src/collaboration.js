import { hashSecret, originAllowed, permit } from './auth.js';
import { GUIDE_DISCOVERY } from './agent-guide.js';
import { readPlan, normalizePlan, savePlan, scheduleState, normalizeReport } from './task-plan.js';
import { readTaskActivity } from './task-activity.js';
import { isActiveDebate, discussionContext, personalDebateTurn, DEBATE_POLL_SECONDS } from './active-debate.js';

export class WorkError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const fail = (message, status = 400) => { throw new WorkError(message, status); };
export const answer = (data, status = 200) => new Response(JSON.stringify({ok:true,...data}), {status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}});
export const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
export async function readBatch(db, queries) {
  const statements=queries.map(([sql,...args])=>db.prepare(sql).bind(...args));
  const results=db.batch?await db.batch(statements):await Promise.all(statements.map(s=>s.all()));
  return results.map(r=>r.results);
}
export const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
export const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
export const now = () => new Date(Date.now()).toISOString();
export function text(value, max = 12000) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`内容须为 1–${max} 个字符`); return value.trim(); }
export function id(value) { if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) fail('无效编号'); return Number(value); }
export function links(value = []) {
  const list = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value;
  if (!Array.isArray(list) || list.length > 30) fail('链接须为数组，最多 30 条');
  return [...new Set(list.map(v => { if (typeof v !== 'string' || v.length>2048) fail('无效链接'); try { const u=new URL(v); if (!['https:','http:'].includes(u.protocol)) fail('链接须使用 HTTP(S)'); return u.href; } catch { fail('链接须使用 HTTP(S)'); } }))].join('\n');
}
function future(value) { const ms=Date.parse(value); if (!Number.isFinite(ms) || ms<=Date.now()) fail('请选择未来的日期时间'); return new Date(ms).toISOString(); }
export const admin = p => permit(p,'admin');
export const agent = p => p?.kind==='agent' && !!p.id;
export async function activeAgent(db, value) { const row=await first(db,"SELECT id FROM principals WHERE id=? AND active=1 AND kind='agent'",id(value)); if(!row) fail('Agent 不存在或已停用',404); return row.id; }
export async function audit(db, taskId, p, kind, recordId, detail) { await run(db,'INSERT INTO work_activity (task_id,actor_id,kind,record_id,detail,created_at) VALUES (?,?,?,?,?,?)',taskId,p.id,kind,recordId,detail,now()); }
export async function requireTask(db, taskId) { const t=await first(db,'SELECT * FROM tasks WHERE id=?',taskId); if(!t) fail('任务不存在',404); return t; }
export function writable(t) { if (['proposed','closed','done'].includes(t.status)) fail('任务需已批准且尚未完成',409); }
export function hostAllowed(p, profile) { return admin(p) || (agent(p) && profile?.host_id===p.id); }

// Import challenges without rewriting their original records. Completed history stays untouched.
export async function syncIssues(db, taskId) {
  await run(db,`INSERT OR IGNORE INTO work_issues (task_id,author_id,challenge_id,text,severity,created_at)
    SELECT c.task_id, CASE WHEN (SELECT COUNT(*) FROM principals p WHERE p.name=c.agent)=1 THEN (SELECT id FROM principals p WHERE p.name=c.agent) ELSE NULL END,
    c.id,c.reason,'blocking',COALESCE(c.created_at,?) FROM challenges c JOIN tasks t ON t.id=c.task_id
    WHERE c.task_id=? AND t.status NOT IN ('done','closed')`,now(),taskId);
}
export async function sourceRef(db, taskId, ref) {
  const tables={debate:'debate_messages',challenge:'challenges',supplement:'supplements',subtask:'work_subtasks',issue:'work_issues'};
  if (!ref || !Object.hasOwn(tables,ref.kind)) fail('无效来源类型');
  const row=await first(db,`SELECT * FROM ${tables[ref.kind]} WHERE id=? AND task_id=?`,id(ref.id),taskId);
  if(!row) fail('来源不属于这条任务',404);
  if(ref.kind==='subtask'&&row.state!=='done') fail('子任务尚未独立核查',409);
  let authorId=row.assignee_id || row.author_id || null;
  if(row.agent) {const matches=await all(db,'SELECT id FROM principals WHERE name=?',row.agent);if(matches.length===1) authorId=matches[0].id;}
  return {kind:ref.kind,id:row.id,author_id:authorId};
}
export async function workflowContext(db, task) {
  await syncIssues(db,task.id);
  const [profiles,issues,subtasks,outcomes,people,subtaskEvents,contributors,reviews,deliveries,periods]=await readBatch(db,[
    ['SELECT * FROM task_workflows WHERE task_id=?',task.id],
    ['SELECT * FROM work_issues WHERE task_id=? ORDER BY id',task.id],
    ['SELECT * FROM work_subtasks WHERE task_id=? ORDER BY id',task.id],
    ['SELECT * FROM work_outcomes WHERE task_id=? ORDER BY id DESC',task.id],
    [`SELECT p.id,p.name AS actor,COALESCE(l.display_name,p.name) AS name,p.active FROM principals p LEFT JOIN principal_labels l ON l.principal_id=p.id`],
    ['SELECT * FROM work_subtask_events WHERE task_id=? ORDER BY id',task.id],
    [`SELECT DISTINCT p.id FROM supplements s JOIN principals p ON p.name=s.agent WHERE s.task_id=?`,task.id],
    [`SELECT r.*,COALESCE(l.display_name,p.name) AS reviewer FROM work_reviews r JOIN principals p ON p.id=r.reviewer_id LEFT JOIN principal_labels l ON l.principal_id=p.id WHERE r.task_id=? ORDER BY r.id DESC`,task.id],
    ['SELECT * FROM work_deliveries WHERE task_id=?',task.id],
    ['SELECT * FROM task_recurrences WHERE previous_task_id=? OR next_task_id=?',task.id,task.id],
  ]);
  const profile=profiles[0]||null;
  const plan=await readPlan(db,task,profile),scheduled=scheduleState(plan);
  const discussion=isActiveDebate(plan)?await discussionContext(db,task,plan,people):null;
  const names=new Map(people.map(p=>[p.id,p.name]));
  for(const i of issues) { i.author=names.get(i.author_id)||'历史记录';i.responder=names.get(i.responder_id)||'';i.resolver=names.get(i.resolver_id)||''; }
  for(const s of subtasks) {s.history=subtaskEvents.filter(e=>e.subtask_id===s.id).map(e=>({...e,actor:names.get(e.actor_id)||'历史账号',detail:JSON.parse(e.detail||'{}')}));s.assignee=names.get(s.assignee_id)||'未知账号';s.reviewer=names.get(s.reviewer_id)||'';s.assignee_active=!!people.find(p=>p.id===s.assignee_id)?.active;s.ack_overdue=s.state==='assigned'&&Date.now()-Date.parse(s.assigned_at)>=7200000;s.overdue=['accepted','waiting'].includes(s.state)&&Date.parse(s.resume_at||s.due_at)<=Date.now();}
  for(const o of outcomes) {o.author=names.get(o.author_id)||'未知账号';o.source_refs=JSON.parse(o.source_refs);o.report=JSON.parse(deliveries.find(d=>d.outcome_id===o.id)?.report_json||'null');}
  const outcome=outcomes[0]||null;
  if(discussion) discussion.has_summary=!!outcome&&Date.parse(outcome.created_at)>=Date.parse(discussion.end_at);
  // Preserve pre-upgrade review fingerprints until an existing task explicitly adopts a plan.
  const fingerprint=await hashSecret(JSON.stringify({summary:task.result_summary,links:task.result_links,claimant:task.claimed_by,profile:profile?{host_id:profile.host_id,acceptance:profile.acceptance,min_sources:profile.min_sources}:null,...(plan.configured?{plan}:{}),...(discussion?{discussion:discussion.last_message_id}:{}),outcome:outcome?.id||null,issues:issues.map(i=>({id:i.id,text:i.text,response:i.response,evidence:i.evidence}))}));
  const authors=new Set([profile?.host_id,plan.delivery.author_id,outcome?.author_id,...contributors.map(p=>p.id),...(outcome?.source_refs||[]).map(s=>s.author_id),...people.filter(p=>p.actor===task.claimed_by).map(p=>p.id)].filter(Boolean));
  const independent=reviews.filter(r=>r.fingerprint===fingerprint&&!authors.has(r.reviewer_id));
  const waiting=!discussion&&!!profile?.resume_at&&Date.parse(profile.resume_at)>Date.now();
  return {enabled:!!profile||plan.configured,plan,scheduled,...(discussion?{discussion}:{}),waiting:waiting||!scheduled.ready,resume_at:waiting?profile.resume_at:scheduled.resume_at,wait_reason:waiting?profile.wait_reason:scheduled.reason,host_id:profile?.host_id||null,host:names.get(profile?.host_id)||'',report_author_id:plan.delivery.author_id,report_author:names.get(plan.delivery.author_id)||'',acceptance:plan.acceptance.criteria,min_sources:plan.acceptance.min_sources,fingerprint,author_ids:[...authors],issues,subtasks,outcomes,reviews,current_reviews:independent,blocking:issues.filter(i=>i.severity==='blocking'&&i.state!=='resolved').length,previous_task_id:periods.find(p=>p.next_task_id===task.id)?.previous_task_id||null,next_task_id:periods.find(p=>p.previous_task_id===task.id)?.next_task_id||null};
}
export async function decorateCollaboration(db, task, context, readiness, collaboration, principal=null) {
  const work=await workflowContext(db,task);
  const check=(key,label,met,detail)=>({key,label,met,detail});
  if(work.discussion) {
    const d=work.discussion,summary=d.has_summary?work.outcomes[0]?.summary||'':'';
    d.next_action=await personalDebateTurn(db,d,d.messages,principal,d.summary_author_id,!!summary);
    delete d.messages;
    const checks=[check('deadline','已到讨论截止时间',d.phase==='ended'||d.phase==='done','持续讨论至 '+d.end_at),
      check('agents','至少两位 Agent 发言',d.participants>=2,`已有 ${d.participants} 位 Agent`),
      check('stances','不同 Agent 提出正反观点',d.opposing_views,d.opposing_views?'已有正反观点':'等待不同 Agent 提出支持与反驳'),
      check('rounds','至少三轮交锋',d.rounds>=d.min_rounds,`已完成 ${d.rounds}/${d.min_rounds} 轮；达标后继续到截止时间`),
      check('summary','已提交截止总结',!!summary,summary?'已有截止总结':'截止后总结观点、分歧与参与情况'),
      check('issues','重要问题已解决',!work.blocking,work.blocking?`还有 ${work.blocking} 项重要问题`:'没有未解决的重要问题')];
    readiness={ready:checks.every(c=>c.met),checks};
    const turn=d.next_action,active=d.phase==='active',ended=d.phase==='ended';
    const action=turn?.kind==='summarize'?'outcome':active&&turn?.kind!=='wait'?'debate':ended?'coordinate':'wait';
    collaboration={...collaboration,participants:d.participants,help_wanted:(active&&(!turn||turn.kind!=='wait'))||(ended&&turn?.kind==='summarize'),actions:active?['debate']:ended?['outcome']:[],suggested_action:action,
      missing:checks.filter(c=>!c.met),reason:turn?.reason||(active?'开放激辩，无需认领；主动发言并持续到截止时间':ended&&!d.participation_sufficient?'激辩已截止，参与不足，等待总结与管理员处理':'激辩已截止，等待总结与验收')};
  } else if(work.enabled) {
    const current=work.outcomes[0];
    const summary=current?.summary||task.result_summary||'';
    const missingReport=work.plan.delivery.format==='web_report'&&!current?.report;
    const sourceLinks=current?(work.plan.configured?current.links:current.links||task.result_links):task.result_links;
    const urls=new Set((sourceLinks||'').match(/https?:\/\/[^\s]+/g)||[]);
    if(current?.report) urls.delete(current.report.url);
    const policy=work.plan.acceptance;
    const checks=[check('result','交付物已提交',!!summary.trim()&&!missingReport,missingReport?'等待主要作者发布并登记网页报告；文字材料不算报告交付':summary.trim()?'已有成果内容':'等待主持人整理成果'),
      check('waiting','等待事项已恢复',!work.waiting,work.waiting?`等待 ${work.wait_reason} 至 ${work.resume_at}`:'当前无需等待外部事件'),
      check('issues','重要问题已解决',!work.blocking,work.blocking?`还有 ${work.blocking} 项重要问题待处理`:'没有未解决的重要问题'),
      check('subtasks','分工已完成',!work.subtasks.some(s=>!['done','declined'].includes(s.state)),'未完成的分工须交付或明确退出')];
    if(work.plan.collaboration==='hosted') checks.push(check('host','已指定主持人',!!work.host_id,work.host_id?'已有主持人':'等待管理员指定主持人'));
    if(work.plan.delivery.format==='web_report') checks.push(check('report','网页报告链接与版本已登记',!!current?.report,current?.report?`${current.report.title} · ${current.report.revision}`:'等待主要作者发布网页并登记链接与版本'));
    if(policy.independent_review) {
      checks.push(check('independent','独立核查通过',work.current_reviews.length>0,work.current_reviews.length?'当前版本有独立核查记录':'等待非作者核查当前版本'));
    }
    checks.push(check('sources','符合来源要求',urls.size>=policy.min_sources,`已附 ${urls.size} 条，要求至少 ${policy.min_sources} 条（报告本身不计为来源）`));
    if(policy.opposing_views) {
      const supports=(context.debate||[]).filter(d=>d.role!=='human'&&d.stance==='支持').map(d=>d.agent);
      const rebuts=[...(context.debate||[]).filter(d=>d.role!=='human'&&d.stance==='反駁').map(d=>d.agent),...(context.challenges||[]).map(c=>c.agent)];
      const met=supports.some(s=>rebuts.some(r=>r&&s!==r));
      checks.push(check('stances','已核对正反观点',met,met?'不同 Agent 已提出正反观点':'等待不同 Agent 提供正反观点'));
    }
    readiness={ready:checks.every(c=>c.met),checks};
    const missing=checks.filter(c=>!c.met);
    collaboration={...collaboration,help_wanted:!['done','closed','proposed'].includes(task.status)&&(missing.length>0||['open','in_progress'].includes(task.status)),missing,reason:missing.map(c=>c.detail).join('；')||'等待用户确认成果',suggested_action:work.blocking?'respond':task.status==='open'&&!task.claimed_by?'claim':!summary.trim()||missing.some(c=>c.key==='report')?'outcome':policy.independent_review&&!work.current_reviews.length?'review':'coordinate'};
  } else if(work.blocking) {
    readiness={ready:false,checks:[...readiness.checks,check('issues','重要问题已解决',false,`还有 ${work.blocking} 项质疑待回应及确认`)]};
    collaboration={...collaboration,help_wanted:!['done','closed','proposed'].includes(task.status),suggested_action:'respond',reason:`还有 ${work.blocking} 项质疑待回应及确认`,missing:[...collaboration.missing,{key:'issues',label:'重要问题',detail:'质疑尚未解决'}]};
  }
  if(work.waiting&&!work.blocking) collaboration={...collaboration,help_wanted:false,suggested_action:'wait',reason:`等待 ${work.wait_reason}，预计 ${work.resume_at} 恢复`};
  return {workflow:work,readiness,collaboration};
}

async function inbox(db,p) {
  const tasks=await all(db,"SELECT * FROM tasks WHERE status NOT IN ('done','closed','proposed') ORDER BY id DESC");
  const items=[], waiting=[];
  for(const t of tasks) {
    const w=await workflowContext(db,t);
    const missingReport=w.plan.delivery.format==='web_report'&&!w.outcomes[0]?.report;
    const base={task_id:t.id,title:t.title};
    if(w.discussion) {
      const d=w.discussion,turn=await personalDebateTurn(db,d,d.messages,p,d.summary_author_id,d.has_summary);
      if(agent(p)&&turn?.kind!=='wait') items.push({...base,...turn,kind:'active_debate',action:turn?.kind,expected_latest_id:d.last_message_id,end_at:d.end_at});
      else if(admin(p)&&d.phase==='ended') items.push({...base,kind:'active_debate',action:turn?.kind==='summarize'?'summarize':'decide',reason:d.participation_sufficient?'激辩已截止，请检查总结与验收条件':'激辩已截止，参与不足；请决定关闭或调整截止时间'});
      else if(turn?.kind==='wait') waiting.push({...base,...turn,kind:'active_debate',action:'wait'});
      continue;
    }
    if(w.waiting&&!w.blocking) {
      if(admin(p)||w.host_id===p.id||w.report_author_id===p.id||t.claimed_by===p.name||(!w.host_id&&agent(p))) waiting.push({...base,kind:'schedule',resume_at:w.resume_at,reason:w.wait_reason});
      continue;
    }
    if(w.host_id===p.id||admin(p)) (w.waiting?waiting:items).push({...base,kind:'host',state:w.waiting?'waiting':undefined,resume_at:w.resume_at,reason:w.waiting?w.wait_reason:w.blocking?`${w.blocking} 项重要问题待处理`:'整理成果、协调分工'});
    for(const s of w.subtasks) {
      if(s.assignee_id!==p.id||['done','declined','submitted'].includes(s.state)) continue;
      const item={...base,kind:'subtask',subtask_id:s.id,title:s.title,state:s.state,due_at:s.due_at,resume_at:s.resume_at};
      (s.state==='waiting'&&Date.parse(s.resume_at)>Date.now()?waiting:items).push(item);
    }
    for(const i of w.issues.filter(i=>i.state!=='resolved')) {
      const responsible=w.report_author_id===p.id||w.outcomes[0]?.author_id===p.id;
      if(w.host_id===p.id||i.author_id===p.id||admin(p)||((responsible||t.claimed_by===p.name)&&i.state==='open')) items.push({...base,kind:'issue',issue_id:i.id,reason:i.text,state:i.state});
    }
    if(agent(p)&&w.report_author_id===p.id) {
      if(!w.outcomes[0]?.report) items.push({...base,kind:'report',reason:`先制作并发布网页报告，再通过 POST /api/tasks/${t.id}/outcomes 提交 report.url、report.revision 与当前 workflow.fingerprint`});
      else if(!w.issues.some(i=>i.state==='open')) waiting.push({...base,kind:'report_review',resume_at:null,reason:w.blocking?'报告问题已回应，等待他人确认':w.plan.acceptance.independent_review&&!w.current_reviews.length?'报告已登记，等待独立核查':'报告已交付，等待用户确认'});
    }
    if(agent(p)&&w.enabled&&!missingReport&&w.plan.acceptance.independent_review&&!w.author_ids.includes(p.id)&&!w.current_reviews.length&&(w.outcomes.length||t.result_summary)) items.push({...base,kind:'review',fingerprint:w.fingerprint,report:w.outcomes[0]?.report||null,reason:w.outcomes[0]?.report?'打开当前报告，核查内容、来源及页面展示':'请独立核查当前成果'});
    if(agent(p)) for(const s of w.subtasks.filter(s=>s.state==='submitted'&&s.assignee_id!==p.id)) items.push({...base,kind:'subtask_review',subtask_id:s.id,title:s.title});
  }
  const priority=item=>item.kind!=='active_debate'?0:item.pending_reply_ids?.length?1:item.action==='summarize'?2:item.action==='enter'?3:4;
  items.sort((a,b)=>priority(a)-priority(b));
  return {items,waiting,poll_after_seconds:[...items,...waiting].some(i=>i.kind==='active_debate')?DEBATE_POLL_SECONDS:900,agent_guide:GUIDE_DISCOVERY};
}

export async function collaborationRoute(request, env, principal, path) {
  const match=path.match(/^\/api\/tasks\/(\d+)\/(activity|plan|trigger|workflow|outcomes|reviews|issues|subtasks|wait|close)(?:\/(\d+)\/(respond|resolve|dispute|accept|decline|wait|submit|check|reassign|remind))?$/);
  if(!match&&!['/api/inbox','/api/participants'].includes(path)) return null;
  try {
    if(!principal?.id) fail('请使用个人账号或独立 Agent 令牌',401);
    if(!originAllowed(request,env,principal)) fail('来源不符',403);
    if(!['GET','POST'].includes(request.method)) fail('不支持此方法',405);
    const db=env.DB,p=principal;
    if(path==='/api/inbox'&&request.method==='GET') return answer(await inbox(db,p));
    if(path==='/api/participants'&&request.method==='GET') return answer({agents:await all(db,`SELECT p.id,p.username,COALESCE(l.display_name,p.name) AS name FROM principals p LEFT JOIN principal_labels l ON l.principal_id=p.id WHERE p.kind='agent' AND p.active=1 ORDER BY p.id`)});
    if(!match) fail('不支持此方法',405);
    const taskId=Number(match[1]),kind=match[2],recordId=match[3]?Number(match[3]):null,action=match[4];
    const task=await requireTask(db,taskId);
    if(kind==='activity') {
      if(request.method!=='GET'||recordId||action) fail('不支持此方法',405);
      return answer(await readTaskActivity(db,task));
    }
    const w=await workflowContext(db,task);
    if(request.method==='GET') return answer({workflow:w,plan:w.plan});
    if(!agent(p)&&!admin(p)) fail('需要 Agent 或管理员权限',403);
    const b=await request.json().catch(()=>null);if(!b||typeof b!=='object'||Array.isArray(b)) fail('无效 JSON');
    if(kind==='plan') {
      if(!admin(p)) fail('只有管理员可更改任务目标、验收与安排',403);
      if(['done','closed'].includes(task.status)) fail('已结束的任务不能更改安排',409);
      if(b.revision!==w.plan.revision) fail('任务安排已更新，请刷新后再保存',409);
      const plan=normalizePlan(b,w.plan);
      const saved=await savePlan(db,task,plan,b.revision);
      if(isActiveDebate(saved)&&task.status==='review'&&Date.parse(saved.schedule.end_at)>Date.now()) await run(db,"UPDATE tasks SET status='in_progress',updated_at=? WHERE id=? AND status='review'",now(),taskId);
      await audit(db,taskId,p,'plan',taskId,JSON.stringify(saved));
      return answer({plan:saved});
    }
    if(kind==='close') {
      if(!admin(p)) fail('只有管理员可关闭激辩',403);
      if(!w.discussion||['done','closed','proposed'].includes(task.status)) fail('仅可关闭已批准且未结束的激辩',409);
      const reason=text(b.reason,2000);
      await db.batch([
        db.prepare("UPDATE tasks SET status='closed',updated_at=? WHERE id=? AND status NOT IN ('done','closed','proposed')").bind(now(),taskId),
        db.prepare("INSERT INTO work_activity(task_id,actor_id,kind,record_id,detail,created_at) SELECT ?,?,'discussion_close',?,?,? WHERE changes()=1").bind(taskId,p.id,taskId,JSON.stringify({reason}),now()),
      ]);
      return answer({status:'closed'});
    }
    if(kind==='workflow') {
      if(['done','closed'].includes(task.status)) fail('已结束的任务不能更改主持设置',409);
      if(!admin(p)) fail('只有管理员能指定主持人和验收要求',403);
      const hostId=await activeAgent(db,b.host_id),acceptance=text(b.acceptance,3000),min=b.min_sources??w.plan.acceptance.min_sources;
      if(!Number.isInteger(min)||min<0||min>20) fail('来源数量须为 0–20');
      const plan=normalizePlan({collaboration:'hosted',acceptance:{criteria:acceptance,min_sources:min}},w.plan);
      await savePlan(db,task,plan,w.plan.revision);
      await run(db,`INSERT INTO task_workflows(task_id,host_id,acceptance,min_sources,created_at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET host_id=excluded.host_id,acceptance=excluded.acceptance,min_sources=excluded.min_sources`,taskId,hostId,acceptance,min,now());
      await audit(db,taskId,p,'host',taskId,JSON.stringify({host_id:hostId,acceptance,min_sources:min}));
      return answer({host_id:hostId});
    }
    writable(task);
    if(kind==='trigger') {
      if(w.plan.schedule.kind!=='event') fail('该任务不等待事件触发',409);
      if(b.revision!==w.plan.revision||w.plan.schedule.triggered_at) fail('执行安排已更新，请刷新',409);
      if(w.plan.schedule.start_at&&Date.parse(w.plan.schedule.start_at)>Date.now()) fail('尚未到计划开始时间',409);
      const note=text(b.note,2000),evidence=links(b.evidence);if(!evidence) fail('请附事件发生的证据链接');
      const plan={...w.plan,schedule:{...w.plan.schedule,triggered_at:now(),trigger_note:`${note}\n${evidence}`}};
      const saved=await savePlan(db,task,plan,w.plan.revision);
      await audit(db,taskId,p,'trigger',taskId,plan.schedule.trigger_note);
      return answer({plan:saved});
    }
    if(['outcomes','subtasks'].includes(kind)&&!w.scheduled.ready) fail(w.scheduled.reason,409);
    if(kind==='wait') {
      if(w.discussion) fail('激辩通过计划开始与截止时间安排；请修改任务安排或关闭讨论',409);
      if(!w.host_id||!hostAllowed(p,w)) fail('请先指定主持人，再设置临时等待',403);
      const reason=b.resume_at?text(b.reason,2000):'',resume=b.resume_at?future(b.resume_at):null;
      await run(db,'UPDATE task_workflows SET wait_reason=?,resume_at=? WHERE task_id=?',reason,resume,taskId);
      await audit(db,taskId,p,'wait',taskId,JSON.stringify({reason,resume_at:resume}));
      return answer({resume_at:resume});
    }
    if(kind==='outcomes') {
      if(w.discussion&&w.discussion.phase!=='ended') fail('激辩持续到截止时间，之后才提交总结',409);
      if(w.discussion&&b.fingerprint!==w.fingerprint) fail('讨论或总结已更新，请重读后再提交',409);
      const report=b.report==null?null:normalizeReport(b.report);
      const reportTask=w.plan.delivery.format==='web_report'||!!report;
      const permitted=admin(p)||(agent(p)&&(w.discussion?p.id===w.discussion.summary_author_id:reportTask&&w.report_author_id?p.id===w.report_author_id:hostAllowed(p,w)||(!w.host_id&&task.claimed_by===p.name)));
      if(!w.enabled||!permitted) fail('由管理员、主持人或指定的主要作者提交成果',403);
      if(w.plan.delivery.format==='web_report'&&!report) fail('请先发布网页报告，并提交 report.url 与 report.revision');
      if((report||b.fingerprint!=null)&&b.fingerprint!==w.fingerprint) fail('成果已更新，请重读后再发布当前版本',409);
      if(report&&w.outcomes.some(o=>o.report?.url===report.url&&o.report?.revision===report.revision)) fail('同一报告链接的修改须使用新的发布版本',409);
      const summary=text(b.summary),urls=links(b.links),changes=text(b.changes,2000),refs=b.source_refs??[];
      if(!Array.isArray(refs)||refs.length>50) fail('来源引用最多 50 条');
      const sources=[];for(const ref of refs) sources.push(await sourceRef(db,taskId,ref));
      let results;
      try {results=await db.batch([
        db.prepare('INSERT INTO work_outcomes(task_id,author_id,summary,links,changes,source_refs,created_at) VALUES(?,?,?,?,?,?,?)').bind(taskId,p.id,summary,urls,changes,JSON.stringify(sources),now()),
        db.prepare('INSERT INTO work_deliveries(outcome_id,task_id,base_outcome_id,report_json) VALUES(last_insert_rowid(),?,?,?)').bind(taskId,w.outcomes[0]?.id||0,JSON.stringify(report)),
        db.prepare("UPDATE tasks SET status='review',updated_at=? WHERE id=?").bind(now(),taskId),
      ]);} catch(e) {if(String(e.message).includes('UNIQUE constraint')) fail('已有新的成果版本，请重读后再提交',409);throw e;}
      const outcomeId=results[0].meta.last_row_id;
      await audit(db,taskId,p,'outcome',outcomeId,changes);
      return answer({id:outcomeId,report},201);
    }
    if(kind==='reviews') {
      if(!w.enabled||!agent(p)||w.author_ids.includes(p.id)) fail('核查须由当前成果作者以外的 Agent 执行',403);
      if(b.fingerprint!==w.fingerprint) fail('成果已更新，请重新读取并核查',409);
      if(w.plan.delivery.format==='web_report'&&!w.outcomes[0]?.report) fail('尚未登记网页报告，请等待主要作者发布并通过 /outcomes 提交报告链接与版本后再核查',409);
      if(!w.outcomes.length&&!String(task.result_summary||'').trim()) fail('尚无成果可核查',409);
      const note=text(b.note,4000),evidence=links(b.evidence),report=w.outcomes[0]?.report;
      if(report&&(b.report_revision!==report.revision||!evidence.split('\n').includes(report.url))) fail('请实际打开当前网页报告，附报告链接及对应 report_revision 后核查');
      if(!evidence&&w.plan.acceptance.min_sources>0) fail('核查须附查证链接');
      await run(db,'INSERT OR IGNORE INTO work_reviews(task_id,reviewer_id,fingerprint,note,evidence,created_at) VALUES(?,?,?,?,?,?)',taskId,p.id,w.fingerprint,note,evidence,now());
      return answer({fingerprint:w.fingerprint},201);
    }
    if(kind==='issues') {
      if(!recordId) {
        const severity=b.severity||'blocking';if(!['blocking','suggestion'].includes(severity)) fail('无效问题级别');
        const content=text(b.text,6000);
        if(w.outcomes[0]?.report&&b.fingerprint!==w.fingerprint) fail('报告版本已更新，请重读后再提出问题',409);
        const r=await run(db,'INSERT INTO work_issues(task_id,author_id,outcome_id,opened_fingerprint,text,severity,created_at) VALUES(?,?,?,?,?,?,?)',taskId,p.id,w.outcomes[0]?.id||null,w.fingerprint,content,severity,now());
        if(severity==='blocking') await run(db,"UPDATE tasks SET status='in_progress',updated_at=? WHERE id=?",now(),taskId);
        await audit(db,taskId,p,'issue',r.meta.last_row_id,content);
        return answer({id:r.meta.last_row_id},201);
      }
      const issue=w.issues.find(i=>i.id===recordId);if(!issue) fail('问题不存在',404);
      if(action==='respond') {
        if(issue.state==='resolved') fail('问题已解决，请提出新问题',409);
        if(!hostAllowed(p,w)&&task.claimed_by!==p.name&&w.report_author_id!==p.id&&w.outcomes[0]?.author_id!==p.id) fail('由主持人或成果提交者回应',403);
        const response=text(b.text,6000),evidence=links(b.evidence);
        const r=await run(db,"UPDATE work_issues SET response=?,evidence=?,responder_id=?,state='responded',revision=revision+1 WHERE id=? AND revision=?",response,evidence,p.id,recordId,issue.revision);
        if(!r.meta.changes) fail('问题已更新，请刷新',409);
        await audit(db,taskId,p,'issue_response',recordId,JSON.stringify({response,evidence}));
      } else if(action==='resolve'||action==='dispute') {
        if(!admin(p)&&(!agent(p)||p.id===issue.responder_id||w.author_ids.includes(p.id)||task.claimed_by===p.name)) fail('解决确认须由独立核查者执行',403);
        if(issue.state==='disputed'&&!admin(p)) fail('分歧已交给用户裁决',403);
        if(action==='resolve'&&b.revision!==issue.revision) fail('回应已更新，请重读后确认并附上 revision',409);
        if(action==='resolve'&&w.outcomes[0]?.report&&b.fingerprint!==w.fingerprint) fail('请核对当前报告及回应，并附当前 fingerprint',409);
        if(!['responded','disputed'].includes(issue.state)&&!admin(p)) fail('请先等待问题回应',409);
        const note=text(b.note,4000),state=action==='dispute'?'disputed':'resolved';
        const r=await run(db,"UPDATE work_issues SET state=?,resolution=?,resolver_id=?,revision=revision+1 WHERE id=? AND revision=?",state,note,p.id,recordId,issue.revision);
        if(!r.meta.changes) fail('问题已更新，请刷新',409);
        await audit(db,taskId,p,action==='dispute'?'issue_dispute':'issue_resolution',recordId,note);
      } else fail('未知操作',404);
      return answer({id:recordId});
    }
    if(kind==='subtasks') {
      if(!w.host_id) fail('请先指定主持人',409);
      if(!recordId) {
        if(!hostAllowed(p,w)) fail('只有主持人可安排分工',403);
        const title=text(b.title,200),deliverable=text(b.deliverable,3000),assignee=await activeAgent(db,b.assignee_id),due=future(b.due_at);
        const r=await run(db,`INSERT INTO work_subtasks(task_id,slot,title,deliverable,assignee_id,assigned_at,due_at)
          SELECT ?,s.slot,?,?,?,?,? FROM (SELECT 1 AS slot UNION ALL SELECT 2 UNION ALL SELECT 3) s
          WHERE NOT EXISTS(SELECT 1 FROM work_subtasks w WHERE w.task_id=? AND w.slot=s.slot AND w.state NOT IN ('done','declined')) ORDER BY s.slot LIMIT 1`,taskId,title,deliverable,assignee,now(),due,taskId);
        if(!r.meta.changes) fail('同时最多 3 个未完成子任务',409);
        await run(db,'INSERT INTO work_subtask_events(task_id,subtask_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?,?)',taskId,r.meta.last_row_id,p.id,'assigned',JSON.stringify({title,assignee_id:assignee}),now());
        return answer({id:r.meta.last_row_id},201);
      }
      const s=w.subtasks.find(s=>s.id===recordId);if(!s) fail('子任务不存在',404);
      if(['done','declined'].includes(s.state)) fail('子任务已结束',409);
      let values={},detail='';
      if(['accept','decline','wait','submit'].includes(action)) {
        if(s.assignee_id!==p.id) fail('只有受派 Agent 可执行',403);
        if(action==='accept') {if(!['assigned','waiting'].includes(s.state)) fail('无需重复接单',409);values={state:'accepted',resume_at:null};}
        if(action==='decline') {if(s.state==='submitted') fail('已提交成果，等待核查',409);values={state:'declined'};detail=text(b.reason,2000);}
        if(action==='wait') {if(!['accepted','waiting'].includes(s.state)) fail('请先接单',409);values={state:'waiting',wait_reason:text(b.reason,2000),resume_at:future(b.resume_at)};detail=values.wait_reason;}
        if(action==='submit') {if(!['accepted','waiting'].includes(s.state)) fail('请先接单',409);values={state:'submitted',summary:text(b.summary),links:links(b.links),resume_at:null};detail=values.summary;}
      } else if(action==='check') {
        if(!agent(p)||p.id===s.assignee_id) fail('由其他 Agent 独立核查',403);
        if(s.state!=='submitted') fail('尚无交付内容',409);
        values={state:'done',reviewer_id:p.id,review_note:text(b.note,4000)};detail=values.review_note;
      } else if(action==='remind'||action==='reassign') {
        if(!hostAllowed(p,w)) fail('只有主持人可协调分工',403);
        if(action==='remind') {if(!s.overdue&&!s.ack_overdue) fail('尚未逾期',409);values={reminded_at:now()};detail=text(b.reason,2000);}
        else {
          const inactive=!s.assignee_active;
          const canMove=(s.state==='assigned'&&s.ack_overdue)||(s.overdue&&s.reminded_at&&Date.now()-Date.parse(s.reminded_at)>=7200000)||inactive;
          if(!canMove) fail('未接单须等 2 小时；已接单逾期须先询问进度并等待 2 小时',409);
          values={state:'assigned',assignee_id:await activeAgent(db,b.assignee_id),assigned_at:now(),resume_at:null,reminded_at:null,due_at:future(b.due_at||new Date(Date.now()+86400000).toISOString())};detail=text(b.reason,2000);
        }
      } else fail('未知操作',404);
      const keys=Object.keys(values);
      const r=await run(db,`UPDATE work_subtasks SET ${keys.map(k=>`${k}=?`).join(',')},revision=revision+1 WHERE id=? AND revision=?`,...Object.values(values),recordId,s.revision);
      if(!r.meta.changes) fail('子任务已更新，请刷新',409);
      await run(db,'INSERT INTO work_subtask_events(task_id,subtask_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?,?)',taskId,recordId,p.id,action,JSON.stringify({detail,...values}),now());
      return answer({id:recordId});
    }
    fail('接口不存在',404);
  } catch(e) {
    if(e instanceof WorkError) return new Response(JSON.stringify({ok:false,error:e.message}),{status:e.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}});
    throw e;
  }
}
