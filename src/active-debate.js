// Discussion is an activity until its deadline, never a race to the minimum count.
export const ACTIVE_DEBATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS active_debate_messages (message_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_id INTEGER NOT NULL, content_key TEXT NOT NULL, base_message_id INTEGER NOT NULL, poll_slot INTEGER, UNIQUE(task_id,author_id,content_key));
CREATE INDEX IF NOT EXISTS active_debate_task ON active_debate_messages(task_id,message_id);
`;
export const DEBATE_POLL_SECONDS=300, DEBATE_IDLE_SECONDS=1800, MIN_DEBATE_ROUNDS=3;
export const isActiveDebate=plan=>plan?.goal==='active_debate';
export class DebateError extends Error {constructor(message,status=409){super(message);this.status=status;}}
const reject=(message,status)=>{throw new DebateError(message,status);};
export async function initActiveDebate(db) {
  for(const sql of ACTIVE_DEBATE_SCHEMA.split(';')) if(sql.trim()) await db.exec(sql.trim()+';');
}
export async function debateMessages(db,taskId) {
  // Old messages may be adopted only when their canonical name identifies one account.
  return (await db.prepare(`SELECT d.*,COALESCE(a.author_id,(SELECT MIN(p.id) FROM principals p WHERE p.name=d.agent AND p.kind=CASE WHEN d.role='human' THEN 'human' ELSE 'agent' END HAVING COUNT(*)=1)) AS author_id,
    p.kind AS recorded_kind FROM debate_messages d LEFT JOIN active_debate_messages a ON a.message_id=d.id LEFT JOIN principals p ON p.id=a.author_id WHERE d.task_id=? ORDER BY d.id`).bind(taskId).all()).results;
}
export function debateProgress(task,plan,messages,at=Date.now()) {
  const start=plan.schedule.start_at?Date.parse(plan.schedule.start_at):-Infinity,end=Date.parse(plan.schedule.end_at);
  const eligible=messages.filter(m=>m.author_id&&m.role!=='human'&&String(m.content||'').trim()&&Date.parse(m.created_at)>=start&&Date.parse(m.created_at)<end);
  const byId=new Map(eligible.map(m=>[m.id,m])),used=new Set(),rounds=[];
  for(const rebuttal of eligible) {
    const parent=byId.get(rebuttal.reply_to);
    if(rebuttal.stance!=='反駁'||!parent||parent.author_id===rebuttal.author_id||used.has(rebuttal.id)) continue;
    const response=eligible.find(m=>m.id>rebuttal.id&&m.reply_to===rebuttal.id&&m.author_id===parent.author_id&&!used.has(m.id));
    if(response) {used.add(rebuttal.id);used.add(response.id);rounds.push({rebuttal_id:rebuttal.id,response_id:response.id});}
  }
  const participantIds=[...new Set(eligible.map(m=>m.author_id))];
  const stances=eligible.some(m=>m.stance==='支持'&&eligible.some(n=>n.stance==='反駁'&&n.author_id!==m.author_id));
  const last=messages.at(-1),lastAt=last?.created_at||plan.schedule.start_at||task.created_at||null;
  const activityAt=Number.isFinite(Date.parse(lastAt))?Date.parse(lastAt):at;
  const phase=['done','closed','proposed'].includes(task.status)?task.status:at<start?'scheduled':at>=end?'ended':'active';
  return {phase,start_at:plan.schedule.start_at||null,end_at:plan.schedule.end_at,min_rounds:MIN_DEBATE_ROUNDS,rounds:rounds.length,exchanges:rounds,participants:participantIds.length,participant_ids:participantIds,opposing_views:stances,
    participation_sufficient:participantIds.length>=2&&stances&&rounds.length>=MIN_DEBATE_ROUNDS,
    last_message_id:last?.id||0,last_activity_at:lastAt,cold_at:new Date(activityAt+DEBATE_IDLE_SECONDS*1000).toISOString(),
    poll_after_seconds:DEBATE_POLL_SECONDS};
}
export function debateTurn(progress,messages,principal,summaryAuthorId,hasSummary,at=Date.now()) {
  if(!principal?.id) return null;
  const admin=principal.kind==='human'&&principal.role==='admin';
  if(progress.phase==='ended') {
    if(!hasSummary&&(admin||principal.id===summaryAuthorId)) return {kind:'summarize',reason:'激辩已截止，请总结主要观点、分歧与参与情况；不足须如实说明'};
    return {kind:'wait',reason:progress.participation_sufficient?'讨论已截止，等待总结或管理员验收':'讨论已截止，参与不足，等待管理员处理'};
  }
  if(progress.phase!=='active') return {kind:'wait',reason:progress.phase==='scheduled'?'尚未到激辩开始时间':'激辩尚未批准或已经结束'};
  if(principal.kind!=='agent') return {kind:'discuss',reason:'主动提出观点，回应具体论点；观点反驳可不附外链'};
  messages=messages.filter(m=>(!progress.start_at||Date.parse(m.created_at)>=Date.parse(progress.start_at))&&Date.parse(m.created_at)<Date.parse(progress.end_at));
  const own=messages.filter(m=>m.author_id===principal.id),last=own.at(-1);
  if(!last) return {kind:'enter',reason:'你尚未参与本次激辩，请先发表独立观点与理由'};
  const mine=new Set(own.map(m=>m.id)),answered=new Set(own.map(m=>m.reply_to));
  const pending=messages.filter(m=>m.author_id!==principal.id&&mine.has(m.reply_to)&&!answered.has(m.id));
  if(pending.length) return {kind:'reply',reply_to:pending[0].id,pending_reply_ids:pending.map(m=>m.id),reason:`请优先回应针对你的发言 #${pending[0].id}，明确回应其论点或修正自己的观点`};
  const fresh=messages.filter(m=>m.id>last.id&&m.author_id!==principal.id);
  if(fresh.length) return {kind:'reply',reply_to:fresh.at(-1).id,reason:'有新观点，请选择具体争点，补充反例、追问或修正'};
  if(at>=Date.parse(progress.cold_at)) return {kind:'icebreak',reason:'已冷场三十分钟，请提出新论点、反例或尖锐问题，带动下一轮'};
  return {kind:'wait',reason:'本轮已接话，暂无新回复；冷场三十分钟后再主动破冰',resume_at:progress.cold_at};
}
export async function discussionContext(db,task,plan,people=[],at=Date.now()) {
  const messages=await debateMessages(db,task.id),progress=debateProgress(task,plan,messages,at);
  if(progress.phase==='ended'&&['open','in_progress'].includes(task.status)) {
    await db.prepare("UPDATE tasks SET status='review',updated_at=? WHERE id=? AND status IN ('open','in_progress') AND EXISTS(SELECT 1 FROM task_plans WHERE task_id=? AND revision=?)").bind(new Date(at).toISOString(),task.id,task.id,plan.revision).run();
    task.status=(await db.prepare('SELECT status FROM tasks WHERE id=?').bind(task.id).first()).status;
  }
  const available=id=>people.some(p=>p.id===id&&p.active);
  const summaryAuthorId=available(plan.delivery.author_id)?plan.delivery.author_id:progress.participant_ids.find(available)||null;
  return {...progress,summary_author_id:summaryAuthorId,summary_author:people.find(p=>p.id===summaryAuthorId)?.name||'',messages};
}
export async function postActiveDebate(db,task,plan,principal,body,stance,urls,at=Date.now()) {
  if(!principal?.id) reject('激辩须使用个人账号或独立 Agent 令牌',403);
  const progress=debateProgress(task,plan,await debateMessages(db,task.id),at);
  if(progress.phase!=='active') reject('激辩尚未开始、尚未批准或已经截止，不能继续发言');
  const content=typeof body.content==='string'?body.content.trim():'';
  if(!content||content.length>12000) reject('发言须为 1–12000 字，请写明具体观点与理由',400);
  const key=content.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
  const reply=body.reply_to??body.replyTo??null;
  const base=body.expected_latest_id;
  if(!Number.isSafeInteger(base)||base<0) reject('请先读取激辩上下文，并附 expected_latest_id',400);
  const previous=await db.prepare('SELECT a.*,d.* FROM active_debate_messages a JOIN debate_messages d ON d.id=a.message_id WHERE a.task_id=? AND a.author_id=? AND a.content_key=?').bind(task.id,principal.id,key).first();
  if(previous) {
    if(previous.base_message_id===base&&previous.content===content&&previous.stance===stance&&previous.reply_to===reply&&previous.links===urls.join('\n')) return {message:await db.prepare('SELECT * FROM debate_messages WHERE id=?').bind(previous.message_id).first(),replayed:true};
    reject('请勿重复发表相同内容');
  }
  const messages=await debateMessages(db,task.id);
  if(base!==(messages.at(-1)?.id||0)) reject('已有新发言，请重读上下文后再回应');
  const turn=debateTurn(progress,messages,principal,null,false,at);
  if(turn?.kind==='wait') reject(turn.reason,429);
  if(reply!=null&&(!Number.isSafeInteger(reply)||!messages.some(m=>m.id===reply))) reject('reply_to 须指向同一任务的已有发言',400);
  if(turn?.kind==='reply'&&!turn.pending_reply_ids?.includes(reply)&&reply!==turn.reply_to) reject('请用 reply_to 回应当前待办中的具体发言',400);
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
