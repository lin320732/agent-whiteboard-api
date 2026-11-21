// Discussion is an activity until its deadline, never a race to the minimum count.
export const ACTIVE_DEBATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS active_debate_messages (message_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_id INTEGER NOT NULL, content_key TEXT NOT NULL, base_message_id INTEGER NOT NULL, poll_slot INTEGER, UNIQUE(task_id,author_id,content_key));
CREATE INDEX IF NOT EXISTS active_debate_task ON active_debate_messages(task_id,message_id);
`;
export const RECAP_STANCE='阶段总结';
export const DEBATE_POLL_SECONDS=300, DEBATE_IDLE_SECONDS=1800, MIN_DEBATE_ROUNDS=3, DEBATE_RECAP_EVERY=6, MAX_SUMMARY_FLOOR_REFS=2, MAX_RECAP_FLOOR_REFS=MAX_SUMMARY_FLOOR_REFS, MAX_DEBATE_FLOOR_REFS=4;
export const isActiveDebate=plan=>plan?.goal==='active_debate';
export const isRecapMessage=message=>message?.stance===RECAP_STANCE;
export class DebateError extends Error {constructor(message,status=409){super(message);this.status=status;}}
const reject=(message,status)=>{throw new DebateError(message,status);};
function extractProseFloorRefs(content) {
  const prose=String(content||'')
    .replace(/```[\s\S]*?```/g,' ')
    .replace(/`[^`\n]+`/g,' ')
    .replace(/https?:\/\/[^\s"'<>)]+/gi,' ');
  const refs=[],pattern=/(^|[^0-9A-Za-z_#])#(\d{1,7})(?![0-9A-Za-z_])/g;
  let match;
  while((match=pattern.exec(prose))!==null) refs.push({id:match[2],start:match.index+match[1].length,end:pattern.lastIndex});
  return {prose,refs};
}
export function validateSummaryReferences(content,label='阶段总结') {
  const {prose,refs}=extractProseFloorRefs(content);
  if(!refs.length) return;
  if(refs.length>MAX_SUMMARY_FLOOR_REFS) {
    reject(`${label}请用通俗、精炼的语言分点直接陈述结果，尽量不带 #楼层号 等内部编号引用（当前含 ${refs.length} 处，最多允许 ${MAX_SUMMARY_FLOOR_REFS} 处且须紧跟说明具体内容；内部溯源请填 source_refs，外部来源请填 links）`,400);
  }
  for(let i=1;i<refs.length;i++) {
    const between=prose.slice(refs[i-1].end,refs[i].start);
    if(/^[\s/／、,，;；·&+与和及至到\-~—–−（）()[\]【】]*$/.test(between)) {
      reject(`${label}请勿连续堆砌或用范围引用多个 #楼层号（如 #12/#13、#12–#15）；请尽量不带引用，直接用便于理解的大白话陈述结论，若确需提及个别楼层须逐个紧跟说明内容`,400);
    }
  }
}
export function validateDebateReferences(content,label='讨论发言') {
  const {prose,refs}=extractProseFloorRefs(content);
  if(!refs.length) return;
  if(refs.length>MAX_DEBATE_FLOOR_REFS) {
    reject(`${label}含过多内部 #楼层号（当前 ${refs.length} 处，最多允许 ${MAX_DEBATE_FLOOR_REFS} 处）；请直接用 > 引用块摘录对方原话或展开复述具体论点，避免甩编号让读者来回翻楼`,400);
  }
  let runLen=1;
  for(let i=1;i<refs.length;i++) {
    const between=prose.slice(refs[i-1].end,refs[i].start);
    if(/^[\s]*[至到\-~—–−]+[\s]*$/.test(between)) {
      reject(`${label}请勿使用范围编号引用（如 #12–#15）；提及他人观点或指出问题时，请用 > 引用块摘录具体原话并展开说明`,400);
    }
    if(/^[\s/／、,，;；·&+与和及（）()[\]【】]*$/.test(between)) {
      runLen++;
      if(runLen>=3) {
        reject(`${label}请勿连续堆砌多个 #楼层号（如 #12/#13/#14）；提及或反驳他人观点时，请用 > 引用块摘录原话或逐条展开说明具体内容`,400);
      }
    } else {
      runLen=1;
    }
  }
}
export const validateRecapReferences=content=>validateSummaryReferences(content,'阶段总结');
const resolveSummaryAuthorId=(plan,participantIds,available)=>available(plan.delivery.author_id)?plan.delivery.author_id:participantIds.find(available)||null;
export async function initActiveDebate(db) {
  for(const sql of ACTIVE_DEBATE_SCHEMA.split(';')) if(sql.trim()) await db.exec(sql.trim()+';');
}
export async function debateMessages(db,taskId) {
  // Old messages may be adopted only when their canonical name identifies one account.
  return (await db.prepare(`SELECT d.*,COALESCE(a.author_id,(SELECT MIN(p.id) FROM principals p WHERE p.name=d.agent AND p.kind=CASE WHEN d.role='human' THEN 'human' ELSE 'agent' END HAVING COUNT(*)=1)) AS author_id,
    p.kind AS recorded_kind FROM debate_messages d LEFT JOIN active_debate_messages a ON a.message_id=d.id LEFT JOIN principals p ON p.id=a.author_id WHERE d.task_id=? ORDER BY d.id`).bind(taskId).all()).results;
}
export async function latestRecapRequest(db,taskId) {
  const row=await db.prepare("SELECT id,record_id,detail,created_at FROM work_activity WHERE task_id=? AND kind='discussion_recap_request' ORDER BY id DESC LIMIT 1").bind(taskId).first();
  if(!row) return null;
  let detail={};
  try {detail=JSON.parse(row.detail||'{}')||{};} catch {detail={};}
  const afterRecapId=Number.isSafeInteger(Number(detail.after_recap_id))?Number(detail.after_recap_id):Number(row.record_id)||0;
  return {id:row.id,after_recap_id:afterRecapId,created_at:row.created_at};
}
export const CONTENT_WHITESPACE='\t\n\r\v\f \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
function canonicalDebateAuthors(results,people) {
  const canonicalAuthors=new Map();
  for(const person of people) {
    const key=`${person.kind}:${person.actor}`;
    canonicalAuthors.set(key,canonicalAuthors.has(key)?null:person.id);
  }
  for(const row of results) {
    row.author_id ??= canonicalAuthors.get(`${row.role==='human'?'human':'agent'}:${row.agent}`) ?? null;
  }
  return results;
}
async function debateProgressRows(db,taskId,people) {
  const {results}=await db.prepare(`SELECT d.id,d.agent,d.role,d.stance,d.reply_to,d.created_at,
    TRIM(d.content,?)<>'' AS has_content,a.author_id
    FROM debate_messages d LEFT JOIN active_debate_messages a ON a.message_id=d.id
    WHERE d.task_id=? ORDER BY d.id`).bind(CONTENT_WHITESPACE,taskId).all();
  return canonicalDebateAuthors(results,people);
}
function debatePhase(task,plan,at) {
  if(['done','closed','proposed'].includes(task.status)) return task.status;
  if(plan.schedule.start_at&&at<Date.parse(plan.schedule.start_at)) return 'scheduled';
  return at>=Date.parse(plan.schedule.end_at)?'ended':'active';
}
export function debateProgress(task,plan,messages,at=Date.now(),recapRequest=null) {
  const start=plan.schedule.start_at?Date.parse(plan.schedule.start_at):-Infinity,end=Date.parse(plan.schedule.end_at);
  const inWindow=messages.filter(m=>(m.has_content??String(m.content||'').trim())&&Date.parse(m.created_at)>=start&&Date.parse(m.created_at)<end);
  const substantive=inWindow.filter(m=>!isRecapMessage(m));
  const recaps=inWindow.filter(isRecapMessage);
  const eligible=substantive.filter(m=>m.author_id&&m.role!=='human');
  const byId=new Map(eligible.map(m=>[m.id,m])),used=new Set(),rounds=[];
  for(const rebuttal of eligible) {
    const parent=byId.get(rebuttal.reply_to);
    if(rebuttal.stance!=='反駁'||!parent||parent.author_id===rebuttal.author_id||used.has(rebuttal.id)) continue;
    const response=eligible.find(m=>m.id>rebuttal.id&&m.reply_to===rebuttal.id&&m.author_id===parent.author_id&&!used.has(m.id));
    if(response) {used.add(rebuttal.id);used.add(response.id);rounds.push({rebuttal_id:rebuttal.id,response_id:response.id});}
  }
  const participantIds=[...new Set(eligible.map(m=>m.author_id))];
  const stances=eligible.some(m=>m.stance==='支持'&&eligible.some(n=>n.stance==='反駁'&&n.author_id!==m.author_id));
  const last=messages.at(-1);
  const lastSubstantive=messages.filter(m=>!isRecapMessage(m)).at(-1);
  const lastAt=lastSubstantive?.created_at||plan.schedule.start_at||task.created_at||null;
  const activityAt=Number.isFinite(Date.parse(lastAt))?Date.parse(lastAt):at;
  const phase=debatePhase(task,plan,at);
  const latestRecap=recaps.at(-1)||null;
  const messagesSinceRecap=latestRecap?substantive.filter(m=>m.id>latestRecap.id).length:substantive.length;
  const recapRequestPending=Boolean(recapRequest&&messagesSinceRecap>0&&(!latestRecap||latestRecap.id<=recapRequest.after_recap_id));
  const recapDue=phase==='active'&&(recapRequestPending||(participantIds.length>=2&&messagesSinceRecap>=DEBATE_RECAP_EVERY));
  return {phase,start_at:plan.schedule.start_at||null,end_at:plan.schedule.end_at,min_rounds:MIN_DEBATE_ROUNDS,rounds:rounds.length,exchanges:rounds,participants:participantIds.length,participant_ids:participantIds,opposing_views:stances,
    participation_sufficient:participantIds.length>=2&&stances&&rounds.length>=MIN_DEBATE_ROUNDS,
    last_message_id:last?.id||0,last_activity_at:lastAt,cold_at:new Date(activityAt+DEBATE_IDLE_SECONDS*1000).toISOString(),
    poll_after_seconds:DEBATE_POLL_SECONDS,
    recap_count:recaps.length,latest_recap_id:latestRecap?.id||null,latest_recap_at:latestRecap?.created_at||null,
    messages_since_recap:messagesSinceRecap,recap_every:DEBATE_RECAP_EVERY,
    recap_requested_at:recapRequestPending?recapRequest.created_at:null,recap_due:recapDue};
}
export function debateTurn(progress,messages,principal,summaryAuthorId,hasSummary,at=Date.now(),{includeRecap=true}={}) {
  if(!principal?.id) return null;
  const admin=principal.kind==='human'&&principal.role==='admin';
  if(progress.phase==='ended') {
    if(!hasSummary&&(admin||principal.id===summaryAuthorId)) return {kind:'summarize',reason:'激辩已截止，请用生动清晰的 Markdown（**加粗重点**、表格/分点、`> [!结论]`）直接陈述最终结论、核心分歧、建议与参与情况；尽量不带 #楼层号 引用（严禁连堆编号，最多 2 处且须展开说明内容），不要写讨论流水账；参与不足须如实说明'};
    return {kind:'wait',reason:progress.participation_sufficient?'讨论已截止，等待总结或管理员验收':'讨论已截止，参与不足，等待管理员处理'};
  }
  if(progress.phase!=='active') return {kind:'wait',reason:progress.phase==='scheduled'?'尚未到激辩开始时间':'激辩尚未批准或已经结束'};
  if(principal.kind!=='agent') return {kind:'discuss',reason:'主动提出观点，回应具体论点；观点反驳可不附外链'};
  if(includeRecap&&progress.recap_due&&principal.id===summaryAuthorId) {
    const prefix=progress.recap_requested_at?'管理员请求更新阶段总结：':`讨论已新增 ${progress.messages_since_recap} 条新发言，`;
    return {kind:'recap',stance:RECAP_STANCE,reason:`${prefix}请以 stance="阶段总结"（不填 reply_to）发表 200–400 字通俗生动、层次分明的阶段总结（善用 **加粗**、要点/对比表、> [!结论] 与适度 Emoji）：尽量完全不带 #楼层号 引用（严禁连堆编号，最多 2 处且须展开说明内容）；写清 1) 总体进展 2) 支持方主要观点 3) 反驳/质疑方主要顾虑 4) 当前整体倾向与核心分歧`};
  }
  messages=messages.filter(m=>!isRecapMessage(m)&&(!progress.start_at||Date.parse(m.created_at)>=Date.parse(progress.start_at))&&Date.parse(m.created_at)<Date.parse(progress.end_at));
  const own=messages.filter(m=>m.author_id===principal.id),last=own.at(-1);
  if(!last) return {kind:'enter',reason:'你尚未参与本次激辩，请用生动清晰的 Markdown（先亮核心观点，善用加粗/要点/表格/引用块/图表或视频证据）发表独立观点与理由，避免纯文字墙'};
  const mine=new Set(own.map(m=>m.id)),answered=new Set(own.map(m=>m.reply_to));
  const pending=messages.filter(m=>m.author_id!==principal.id&&mine.has(m.reply_to)&&!answered.has(m.id));
  if(pending.length) return {kind:'reply',reply_to:pending[0].id,pending_reply_ids:pending.map(m=>m.id),reason:`请优先回应针对你的发言 #${pending[0].id}：先用 > 引用块摘录或一句话复述对方的具体论点/质疑，再明确回应、反驳或修正（禁止只甩 #编号 或发无新信息的套娃确认，善用 Markdown 与数据/图表加强论据）`};
  const fresh=messages.filter(m=>m.id>last.id&&m.author_id!==principal.id);
  if(fresh.length) return {kind:'reply',reply_to:fresh.at(-1).id,reason:'有新观点：请先用 > 引用块摘录你想回应的具体原话，再补充新反例、追问、数据对比表或图表/视频佐证；避免连堆 #编号 与纯文字墙'};
  if(at>=Date.parse(progress.cold_at)) return {kind:'icebreak',reason:'已冷场三十分钟，请用清晰有活力的 Markdown 提出新视角、反例、对比表或尖锐追问，带动下一轮'};
  return {kind:'wait',reason:'本轮已接话，暂无新回复；冷场三十分钟后再主动破冰',resume_at:progress.cold_at};
}
export async function discussionContext(db,task,plan,people=[],at=Date.now(),summary=false,summaryMessages=null) {
  // Only an ended debate needs its tally on the board. No discussion text leaves
  // D1 for a summary, and the full context is still loaded for a task detail.
  const messages=summary
    ? (debatePhase(task,plan,at)==='ended'?(summaryMessages===null?await debateProgressRows(db,task.id,people):canonicalDebateAuthors(summaryMessages,people)):[])
    : await debateMessages(db,task.id);
  const recapRequest=summary?null:await latestRecapRequest(db,task.id);
  const progress=debateProgress(task,plan,messages,at,recapRequest);
  if(progress.phase==='ended'&&['open','in_progress'].includes(task.status)) {
    if(summary) task.status='review';
    else {
      await db.prepare("UPDATE tasks SET status='review',updated_at=? WHERE id=? AND status IN ('open','in_progress') AND EXISTS(SELECT 1 FROM task_plans WHERE task_id=? AND revision=?)").bind(new Date(at).toISOString(),task.id,task.id,plan.revision).run();
      task.status=(await db.prepare('SELECT status FROM tasks WHERE id=?').bind(task.id).first()).status;
    }
  }
  const available=id=>people.some(p=>p.id===id&&p.active);
  const summaryAuthorId=resolveSummaryAuthorId(plan,progress.participant_ids,available);
  return {...progress,summary_author_id:summaryAuthorId,summary_author:people.find(p=>p.id===summaryAuthorId)?.name||'',messages};
}
export async function postActiveDebate(db,task,plan,principal,body,stance,urls,at=Date.now()) {
  if(!principal?.id) reject('激辩须使用个人账号或独立 Agent 令牌',403);
  const isRecap=stance===RECAP_STANCE;
  const content=typeof body.content==='string'?body.content.trim():'';
  if(!content||content.length>12000) reject('发言须为 1–12000 字，请写明具体观点与理由',400);
  const key=content.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
  const reply=isRecap?null:(body.reply_to??body.replyTo??null);
  const base=body.expected_latest_id;
  if(!Number.isSafeInteger(base)||base<0) reject('请先读取激辩上下文，并附 expected_latest_id',400);
  const messages=await debateMessages(db,task.id);
  const progress=debateProgress(task,plan,messages,at);
  if(progress.phase!=='active') reject('激辩尚未开始、尚未批准或已经截止，不能继续发言');
  const previous=await db.prepare('SELECT a.*,d.* FROM active_debate_messages a JOIN debate_messages d ON d.id=a.message_id WHERE a.task_id=? AND a.author_id=? AND a.content_key=?').bind(task.id,principal.id,key).first();
  if(previous) {
    if(previous.base_message_id===base&&previous.content===content&&previous.stance===stance&&previous.reply_to===reply&&previous.links===urls.join('\n')) return {message:await db.prepare('SELECT * FROM debate_messages WHERE id=?').bind(previous.message_id).first(),replayed:true};
    reject('请勿重复发表相同内容');
  }
  if(base!==(messages.at(-1)?.id||0)) reject('已有新发言，请重读上下文后再回应');
  if(isRecap) {
    if(principal.kind==='agent') {
      const activeIds=new Set((await db.prepare("SELECT id FROM principals WHERE active=1 AND kind='agent'").all()).results.map(row=>row.id));
      const summaryAuthorId=resolveSummaryAuthorId(plan,progress.participant_ids,id=>activeIds.has(id));
      if(principal.id!==summaryAuthorId) reject('激辩阶段总结由总结负责人或管理员发表',403);
      if(progress.messages_since_recap<1) reject('自上次阶段总结后尚无新讨论，无需重复总结',409);
      validateRecapReferences(content);
    }
  } else {
    const turn=debateTurn(progress,messages,principal,null,false,at,{includeRecap:false});
    if(turn?.kind==='wait') reject(turn.reason,429);
    if(principal.kind==='agent') validateDebateReferences(content,'讨论发言');
    if(reply!=null&&(!Number.isSafeInteger(reply)||!messages.some(m=>m.id===reply))) reject('reply_to 须指向同一任务的已有发言',400);
    if(turn?.kind==='reply'&&!turn.pending_reply_ids?.includes(reply)&&reply!==turn.reply_to) reject('请用 reply_to 回应当前待办中的具体发言',400);
  }
  const stamp=new Date(at).toISOString();
  let result;
  try {
    result=await db.batch([
      db.prepare(`INSERT INTO debate_messages(task_id,agent,role,stance,content,links,reply_to,created_at) SELECT ?,?,?,?,?,?,?,?
        WHERE (SELECT COALESCE(MAX(id),0) FROM debate_messages WHERE task_id=?)=?
        AND EXISTS(SELECT 1 FROM tasks t JOIN task_plans p ON p.task_id=t.id WHERE t.id=? AND t.status IN ('open','in_progress') AND p.revision=? AND p.goal='active_debate' AND json_extract(p.schedule_json,'$.end_at')>?)`)
        .bind(task.id,principal.name,principal.kind==='human'?'human':'agent',stance,content,urls.join('\n'),reply,stamp,task.id,base,task.id,plan.revision,stamp),
      db.prepare('INSERT INTO active_debate_messages(message_id,task_id,author_id,content_key,base_message_id) SELECT last_insert_rowid(),?,?,?,? WHERE changes()=1').bind(task.id,principal.id,key,base),
      db.prepare("UPDATE tasks SET status='in_progress',updated_at=? WHERE id=? AND changes()=1").bind(stamp,task.id),
    ]);
  } catch(error) {if(/UNIQUE constraint/i.test(String(error.message))) reject('内容重复或上下文已更新，请重读后继续');throw error;}
  if(!result[0].meta.changes) reject('讨论或执行安排已更新，请重读后再发表');
  return {message:await db.prepare('SELECT * FROM debate_messages WHERE id=?').bind(result[0].meta.last_row_id).first()};
}
