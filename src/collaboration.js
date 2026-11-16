import { hashSecret, originAllowed, permit } from './auth.js';
import { GUIDE_DISCOVERY } from './agent-guide.js';

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
export const now = () => new Date().toISOString();
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
  const [profiles,issues,subtasks,outcomes,people,subtaskEvents,contributors,reviews]=await readBatch(db,[
    ['SELECT * FROM task_workflows WHERE task_id=?',task.id],
    ['SELECT * FROM work_issues WHERE task_id=? ORDER BY id',task.id],
    ['SELECT * FROM work_subtasks WHERE task_id=? ORDER BY id',task.id],
    ['SELECT * FROM work_outcomes WHERE task_id=? ORDER BY id DESC',task.id],
    [`SELECT p.id,p.name AS actor,COALESCE(l.display_name,p.name) AS name,p.active FROM principals p LEFT JOIN principal_labels l ON l.principal_id=p.id`],
    ['SELECT * FROM work_subtask_events WHERE task_id=? ORDER BY id',task.id],
    [`SELECT DISTINCT p.id FROM supplements s JOIN principals p ON p.name=s.agent WHERE s.task_id=?`,task.id],
    [`SELECT r.*,COALESCE(l.display_name,p.name) AS reviewer FROM work_reviews r JOIN principals p ON p.id=r.reviewer_id LEFT JOIN principal_labels l ON l.principal_id=p.id WHERE r.task_id=? ORDER BY r.id DESC`,task.id],
  ]);
  const profile=profiles[0]||null;
  const names=new Map(people.map(p=>[p.id,p.name]));
  for(const i of issues) { i.author=names.get(i.author_id)||'历史记录';i.responder=names.get(i.responder_id)||'';i.resolver=names.get(i.resolver_id)||''; }
  for(const s of subtasks) {s.history=subtaskEvents.filter(e=>e.subtask_id===s.id).map(e=>({...e,actor:names.get(e.actor_id)||'历史账号',detail:JSON.parse(e.detail||'{}')}));s.assignee=names.get(s.assignee_id)||'未知账号';s.assignee_active=!!people.find(p=>p.id===s.assignee_id)?.active;s.ack_overdue=s.state==='assigned'&&Date.now()-Date.parse(s.assigned_at)>=7200000;s.overdue=['accepted','waiting'].includes(s.state)&&Date.parse(s.resume_at||s.due_at)<=Date.now();}
  for(const o of outcomes) {o.author=names.get(o.author_id)||'未知账号';o.source_refs=JSON.parse(o.source_refs);}
  const outcome=outcomes[0]||null;
  const fingerprint=await hashSecret(JSON.stringify({summary:task.result_summary,links:task.result_links,claimant:task.claimed_by,profile:profile?{host_id:profile.host_id,acceptance:profile.acceptance,min_sources:profile.min_sources}:null,outcome:outcome?.id||null,issues:issues.map(i=>({id:i.id,text:i.text,response:i.response,evidence:i.evidence}))}));
  const authors=new Set([profile?.host_id,outcome?.author_id,...contributors.map(p=>p.id),...(outcome?.source_refs||[]).map(s=>s.author_id),...people.filter(p=>p.actor===task.claimed_by).map(p=>p.id)].filter(Boolean));
  const independent=reviews.filter(r=>r.fingerprint===fingerprint&&!authors.has(r.reviewer_id));
  return {enabled:!!profile,waiting:!!profile?.resume_at&&Date.parse(profile.resume_at)>Date.now(),resume_at:profile?.resume_at||null,wait_reason:profile?.wait_reason||'',host_id:profile?.host_id||null,host: names.get(profile?.host_id)||'',acceptance:profile?.acceptance||'',min_sources:profile?.min_sources??1,fingerprint,author_ids:[...authors],issues,subtasks,outcomes,reviews,current_reviews:independent,blocking:issues.filter(i=>i.severity==='blocking'&&i.state!=='resolved').length};
}
export async function decorateCollaboration(db, task, context, readiness, collaboration) {
  const work=await workflowContext(db,task);
  const check=(key,label,met,detail)=>({key,label,met,detail});
  if(work.enabled) {
    const current=work.outcomes[0];
    const summary=current?.summary||task.result_summary||'';
    const urls=new Set((current?.links||task.result_links||'').match(/https?:\/\/[^\s]+/g)||[]);
    const checks=[check('result','交付物已提交',!!summary.trim(),summary.trim()?'已有成果内容':'等待主持人整理成果'),
      check('waiting','等待事项已恢复',!work.waiting,work.waiting?`等待 ${work.wait_reason} 至 ${work.resume_at}`:'当前无需等待外部事件'),
      check('issues','重要问题已解决',!work.blocking,work.blocking?`还有 ${work.blocking} 项重要问题待处理`:'没有未解决的重要问题'),
      check('subtasks','分工已完成',!work.subtasks.some(s=>!['done','declined'].includes(s.state)),'未完成的分工须交付或明确退出')];
    if(task.type!=='creative') {
      checks.push(check('independent','独立核查通过',work.current_reviews.length>0,work.current_reviews.length?'当前版本有独立核查记录':'等待非作者核查当前版本'));
      checks.push(check('sources','符合来源要求',urls.size>=work.min_sources,`已附 ${urls.size} 条，要求至少 ${work.min_sources} 条`));
    }
    if(task.type==='debate') {const sides=readiness.checks.find(c=>c.key==='stances');if(sides) checks.push(sides);}
    readiness={ready:checks.every(c=>c.met),checks};
    const missing=checks.filter(c=>!c.met);
    collaboration={...collaboration,help_wanted:!['done','closed','proposed'].includes(task.status)&&(missing.length>0||task.status==='in_progress'),missing,reason:missing.map(c=>c.detail).join('；')||'等待主持人整理并提交核对',suggested_action:work.blocking?'respond':!summary.trim()?'outcome':work.current_reviews.length===0&&task.type!=='creative'?'review':'coordinate'};
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
    const base={task_id:t.id,title:t.title};
    if(w.host_id===p.id||admin(p)) (w.waiting?waiting:items).push({...base,kind:'host',state:w.waiting?'waiting':undefined,resume_at:w.resume_at,reason:w.waiting?w.wait_reason:w.blocking?`${w.blocking} 项重要问题待处理`:'整理成果、协调分工'});
    for(const s of w.subtasks) {
      if(s.assignee_id!==p.id||['done','declined','submitted'].includes(s.state)) continue;
      const item={...base,kind:'subtask',subtask_id:s.id,title:s.title,state:s.state,due_at:s.due_at,resume_at:s.resume_at};
      (s.state==='waiting'&&Date.parse(s.resume_at)>Date.now()?waiting:items).push(item);
    }
    for(const i of w.issues.filter(i=>i.state!=='resolved')) {
      if(w.host_id===p.id||i.author_id===p.id||t.claimed_by===p.name||admin(p)) items.push({...base,kind:'issue',issue_id:i.id,reason:i.text,state:i.state});
    }
    if(agent(p)&&w.enabled&&!w.author_ids.includes(p.id)&&!w.current_reviews.length&&(w.outcomes.length||t.result_summary)) items.push({...base,kind:'review',fingerprint:w.fingerprint,reason:'请独立核查当前成果'});
    if(agent(p)) for(const s of w.subtasks.filter(s=>s.state==='submitted'&&s.assignee_id!==p.id)) items.push({...base,kind:'subtask_review',subtask_id:s.id,title:s.title});
  }
  return {items,waiting,poll_after_seconds:900,agent_guide:GUIDE_DISCOVERY};
}

export async function collaborationRoute(request, env, principal, path) {
  const match=path.match(/^\/api\/tasks\/(\d+)\/(workflow|outcomes|reviews|issues|subtasks|wait)(?:\/(\d+)\/(respond|resolve|dispute|accept|decline|wait|submit|check|reassign|remind))?$/);
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
    const task=await requireTask(db,taskId), w=await workflowContext(db,task);
    if(request.method==='GET') return answer({workflow:w});
    if(!agent(p)&&!admin(p)) fail('需要 Agent 或管理员权限',403);
    const b=await request.json().catch(()=>null);if(!b||typeof b!=='object'||Array.isArray(b)) fail('无效 JSON');
    if(kind==='workflow') {
      if(['done','closed'].includes(task.status)) fail('已结束的任务不能更改主持设置',409);
      if(!admin(p)) fail('只有管理员能指定主持人和验收要求',403);
      const hostId=await activeAgent(db,b.host_id),acceptance=text(b.acceptance,3000),min=b.min_sources??1;
      if(!Number.isInteger(min)||min<0||min>20) fail('来源数量须为 0–20');
      await run(db,`INSERT INTO task_workflows(task_id,host_id,acceptance,min_sources,created_at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET host_id=excluded.host_id,acceptance=excluded.acceptance,min_sources=excluded.min_sources`,taskId,hostId,acceptance,min,now());
      await audit(db,taskId,p,'host',taskId,`指定主持，验收：${acceptance}`);
      return answer({host_id:hostId});
    }
    writable(task);
    if(kind==='wait') {
      if(!w.enabled||!hostAllowed(p,w)) fail('由主持人设置恢复时间',403);
      const reason=b.resume_at?text(b.reason,2000):'',resume=b.resume_at?future(b.resume_at):null;
      await run(db,'UPDATE task_workflows SET wait_reason=?,resume_at=? WHERE task_id=?',reason,resume,taskId);
      await audit(db,taskId,p,'wait',taskId,JSON.stringify({reason,resume_at:resume}));
      return answer({resume_at:resume});
    }
    if(kind==='outcomes') {
      if(!w.enabled||!hostAllowed(p,w)) fail('只有该任务主持人或管理员可整理成果',403);
      const summary=text(b.summary),urls=links(b.links),changes=text(b.changes,2000),refs=b.source_refs??[];
      if(!Array.isArray(refs)||refs.length>50) fail('来源引用最多 50 条');
      const sources=[];for(const ref of refs) sources.push(await sourceRef(db,taskId,ref));
      const r=await run(db,'INSERT INTO work_outcomes(task_id,author_id,summary,links,changes,source_refs,created_at) VALUES(?,?,?,?,?,?,?)',taskId,p.id,summary,urls,changes,JSON.stringify(sources),now());
      await run(db,"UPDATE tasks SET status='review',updated_at=? WHERE id=?",now(),taskId);
      await audit(db,taskId,p,'outcome',r.meta.last_row_id,changes);
      return answer({id:r.meta.last_row_id},201);
    }
    if(kind==='reviews') {
      if(!w.enabled||!agent(p)||w.author_ids.includes(p.id)) fail('核查须由当前成果作者以外的 Agent 执行',403);
      if(b.fingerprint!==w.fingerprint) fail('成果已更新，请重新读取并核查',409);
      if(!w.outcomes.length&&!String(task.result_summary||'').trim()) fail('尚无成果可核查',409);
      const note=text(b.note,4000),evidence=links(b.evidence);if(!evidence) fail('核查须附查证链接');
      await run(db,'INSERT OR IGNORE INTO work_reviews(task_id,reviewer_id,fingerprint,note,evidence,created_at) VALUES(?,?,?,?,?,?)',taskId,p.id,w.fingerprint,note,evidence,now());
      return answer({fingerprint:w.fingerprint},201);
    }
    if(kind==='issues') {
      if(!recordId) {
        const severity=b.severity||'blocking';if(!['blocking','suggestion'].includes(severity)) fail('无效问题级别');
        const content=text(b.text,6000);
        const r=await run(db,'INSERT INTO work_issues(task_id,author_id,outcome_id,opened_fingerprint,text,severity,created_at) VALUES(?,?,?,?,?,?,?)',taskId,p.id,w.outcomes[0]?.id||null,w.fingerprint,content,severity,now());
        if(severity==='blocking') await run(db,"UPDATE tasks SET status='in_progress',updated_at=? WHERE id=?",now(),taskId);
        await audit(db,taskId,p,'issue',r.meta.last_row_id,content);
        return answer({id:r.meta.last_row_id},201);
      }
      const issue=w.issues.find(i=>i.id===recordId);if(!issue) fail('问题不存在',404);
      if(action==='respond') {
        if(issue.state==='resolved') fail('问题已解决，请提出新问题',409);
        if(!hostAllowed(p,w)&&task.claimed_by!==p.name) fail('由主持人或成果提交者回应',403);
        const response=text(b.text,6000),evidence=links(b.evidence);
        const r=await run(db,"UPDATE work_issues SET response=?,evidence=?,responder_id=?,state='responded',revision=revision+1 WHERE id=? AND revision=?",response,evidence,p.id,recordId,issue.revision);
        if(!r.meta.changes) fail('问题已更新，请刷新',409);
        await audit(db,taskId,p,'issue_response',recordId,JSON.stringify({response,evidence}));
      } else if(action==='resolve'||action==='dispute') {
        if(!admin(p)&&(!agent(p)||p.id===issue.responder_id||w.author_ids.includes(p.id)||task.claimed_by===p.name)) fail('解决确认须由独立核查者执行',403);
        if(issue.state==='disputed'&&!admin(p)) fail('分歧已交给用户裁决',403);
        if(action==='resolve'&&b.revision!==issue.revision) fail('回应已更新，请重读后确认并附上 revision',409);
        if(!['responded','disputed'].includes(issue.state)&&!admin(p)) fail('请先等待问题回应',409);
        const note=text(b.note,4000),state=action==='dispute'?'disputed':'resolved';
        const r=await run(db,"UPDATE work_issues SET state=?,resolution=?,resolver_id=?,revision=revision+1 WHERE id=? AND revision=?",state,note,p.id,recordId,issue.revision);
        if(!r.meta.changes) fail('问题已更新，请刷新',409);
        await audit(db,taskId,p,action==='dispute'?'issue_dispute':'issue_resolution',recordId,note);
      } else fail('未知操作',404);
      return answer({id:recordId});
    }
    if(kind==='subtasks') {
      if(!w.enabled) fail('请先指定主持人',409);
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
