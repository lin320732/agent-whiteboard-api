import { GOALS, COLLABORATION, SCHEDULES, legacyGoal, legacyType, acceptanceTemplate } from '../web/task-model.js';
export {legacyType} from '../web/task-model.js';

// Additive tables; existing tasks opt in when an administrator saves their plan/workflow.
export const TASK_PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_plans (task_id INTEGER PRIMARY KEY, goal TEXT NOT NULL, collaboration TEXT NOT NULL, acceptance_json TEXT NOT NULL, schedule_json TEXT NOT NULL, delivery_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_deliveries (outcome_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, base_outcome_id INTEGER NOT NULL, report_json TEXT NOT NULL DEFAULT 'null', UNIQUE(task_id,base_outcome_id));
CREATE TABLE IF NOT EXISTS task_recurrences (previous_task_id INTEGER PRIMARY KEY, next_task_id INTEGER NOT NULL UNIQUE);
CREATE INDEX IF NOT EXISTS work_deliveries_task ON work_deliveries(task_id);
`;
export async function initTaskPlans(db) {
  for(const sql of TASK_PLAN_SCHEMA.split(';')) if(sql.trim()) await db.exec(sql.trim()+';');
}
export class PlanError extends Error { constructor(message,status=400) {super(message);this.status=status;} }
const invalid=(message,status=400)=>{throw new PlanError(message,status);};
const object=(v,label)=>{if(!v||typeof v!=='object'||Array.isArray(v)) invalid(`${label}须为对象`);return v;};
const string=(v,max,label,required=false)=>{if(typeof v!=='string'||v.length>max||(required&&!v.trim())) invalid(`${label}须为${required?'非空、':''}最多 ${max} 字的文本`);return v.trim();};
const integer=(v,min,max,label)=>{if(!Number.isSafeInteger(v)||v<min||v>max) invalid(`${label}须为 ${min}–${max} 的整数`);return v;};
const boolean=(v,label)=>{if(typeof v!=='boolean') invalid(`${label}须为布尔值`);return v;};
function date(v,label) {
  if(v==null||v==='') return null;
  if(typeof v!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v))) invalid(`${label}须为带时区的 ISO 日期时间`);
  return new Date(v).toISOString();
}
export function defaultPlan(type='research') {
  const goal=legacyGoal(type),acceptance=acceptanceTemplate(goal);
  if(type==='debate') acceptance.opposing_views=true;
  return {goal,collaboration:'open',acceptance,schedule:{kind:'once',start_at:null},delivery:{format:'text',author_id:null},revision:0,configured:false};
}
export function normalizePlan(input={},base=defaultPlan()) {
  object(input,'任务安排');
  const goal=input.goal??base.goal;
  if(!Object.hasOwn(GOALS,goal)) invalid('任务目标须为 research / analysis / content / build / active_debate');
  const collaboration=input.collaboration??base.collaboration;
  if(!Object.hasOwn(COLLABORATION,collaboration)) invalid('无效协作方式');
  // A goal selects defaults only for a new plan. Editing a goal never resets saved requirements.
  const acceptance={...base.acceptance,...(input.acceptance==null?{}:object(input.acceptance,'验收要求'))};
  acceptance.criteria=string(acceptance.criteria,3000,'验收说明');
  integer(acceptance.min_sources,0,20,'最少来源数量');
  boolean(acceptance.independent_review,'独立核查');boolean(acceptance.opposing_views,'正反观点');
  const schedule={...base.schedule,...(input.schedule==null?{}:object(input.schedule,'执行安排'))};
  if(!Object.hasOwn(SCHEDULES,schedule.kind)) invalid('无效执行安排');
  schedule.start_at=date(schedule.start_at,'开始时间');
  if(goal==='active_debate') {
    schedule.end_at=date(schedule.end_at,'激辩截止时间');
    if(!schedule.end_at) invalid('激辩须指定带时区的截止时间 schedule.end_at');
    if(schedule.kind!=='once') invalid('激辩首版仅支持一次性执行');
    if(schedule.start_at&&schedule.end_at<=schedule.start_at) invalid('激辩截止时间须晚于开始时间');
    if(acceptance.min_sources!==0||acceptance.independent_review||!acceptance.opposing_views) invalid('激辩须使用零来源、无需独立核查、核对正反观点的验收设置；请套用目标默认验收');
  } else delete schedule.end_at;
  delete schedule.triggered_at;delete schedule.trigger_note;
  if(schedule.kind==='recurring') {
    if(!schedule.start_at) invalid('定期执行须指定首次开始时间');
    integer(schedule.interval_days,1,365,'执行间隔天数');
  } else delete schedule.interval_days;
  if(schedule.kind==='event') schedule.event=string(schedule.event||'',1000,'触发条件',true);
  else delete schedule.event;
  // Preserve an already recorded event only while its condition and schedule remain unchanged.
  if(schedule.kind==='event'&&base.schedule.kind==='event'&&schedule.event===base.schedule.event&&schedule.start_at===base.schedule.start_at) {
    if(base.schedule.triggered_at) {schedule.triggered_at=base.schedule.triggered_at;schedule.trigger_note=base.schedule.trigger_note;}
  }
  const delivery={...base.delivery,...(input.delivery==null?{}:object(input.delivery,'交付方式'))};
  if(!['text','web_report'].includes(delivery.format)) invalid('交付方式须为 text / web_report');
  if(delivery.author_id!=null) integer(delivery.author_id,1,Number.MAX_SAFE_INTEGER,'主要作者');
  if(goal==='active_debate'&&(delivery.format!=='text'||collaboration!=='open')) invalid('激辩使用开放协作与文字总结，无需主持人或网页报告');
  return {goal,collaboration,acceptance,schedule,delivery,revision:base.revision,configured:true};
}
export function newPlan(input={},type='research') {
  const base=defaultPlan(type);
  if(input?.goal) base.acceptance=acceptanceTemplate(input.goal);
  if(input?.delivery?.format==='web_report') base.acceptance.independent_review=true;
  return normalizePlan(input,base);
}
export async function validatePlanAgents(db,plan) {
  if(plan.delivery.author_id!=null&&!await db.prepare("SELECT id FROM principals WHERE id=? AND kind='agent' AND active=1").bind(plan.delivery.author_id).first()) invalid('主要作者不存在或已停用');
}
export function planInsert(db,taskId,plan) {
  const target=taskId==null?'last_insert_rowid()':'?';
  return db.prepare(`INSERT INTO task_plans(task_id,goal,collaboration,acceptance_json,schedule_json,delivery_json,updated_at) VALUES(${target},?,?,?,?,?,?)`).bind(...(taskId==null?[]:[taskId]),plan.goal,plan.collaboration,JSON.stringify(plan.acceptance),JSON.stringify(plan.schedule),JSON.stringify(plan.delivery),new Date().toISOString());
}
export async function readPlan(db,task,profile=null) {
  const row=await db.prepare('SELECT * FROM task_plans WHERE task_id=?').bind(task.id).first();
  if(row) return {goal:row.goal,collaboration:row.collaboration,acceptance:JSON.parse(row.acceptance_json),schedule:JSON.parse(row.schedule_json),delivery:JSON.parse(row.delivery_json),revision:row.revision,configured:true};
  const plan=defaultPlan(task.type);
  if(profile) {plan.collaboration='hosted';plan.acceptance.criteria=profile.acceptance;if(task.type!=='creative') plan.acceptance.min_sources=profile.min_sources;}
  return plan;
}
export async function savePlan(db,task,plan,expected) {
  await validatePlanAgents(db,plan);
  const stamp=new Date().toISOString();
  let result;
  if(expected===0) result=await db.prepare('INSERT OR IGNORE INTO task_plans(task_id,goal,collaboration,acceptance_json,schedule_json,delivery_json,updated_at) VALUES(?,?,?,?,?,?,?)').bind(task.id,plan.goal,plan.collaboration,JSON.stringify(plan.acceptance),JSON.stringify(plan.schedule),JSON.stringify(plan.delivery),stamp).run();
  else result=await db.prepare('UPDATE task_plans SET goal=?,collaboration=?,acceptance_json=?,schedule_json=?,delivery_json=?,revision=revision+1,updated_at=? WHERE task_id=? AND revision=?').bind(plan.goal,plan.collaboration,JSON.stringify(plan.acceptance),JSON.stringify(plan.schedule),JSON.stringify(plan.delivery),stamp,task.id,expected).run();
  if(!result.meta.changes) invalid('任务安排已更新，请刷新后再保存',409);
  return {...plan,revision:expected+1};
}
export function scheduleState(plan,at=Date.now()) {
  if(plan.schedule.start_at&&Date.parse(plan.schedule.start_at)>at) return {ready:false,resume_at:plan.schedule.start_at,reason:`计划于 ${plan.schedule.start_at} 开始`};
  if(plan.schedule.kind==='event'&&!plan.schedule.triggered_at) return {ready:false,resume_at:null,reason:`等待事件：${plan.schedule.event}`};
  return {ready:true,resume_at:null,reason:''};
}
export function normalizeReport(value) {
  object(value,'网页报告');
  let url;
  try {url=new URL(value.url);} catch {invalid('报告链接无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password) invalid('报告须为不含凭据的 HTTP(S) 链接');
  if(url.href.length>2048) invalid('报告链接过长');
  return {url:url.href,revision:string(value.revision,120,'报告发布版本',true),title:string(value.title||'网页报告',200,'报告标题',true),published_at:date(value.published_at||new Date().toISOString(),'发布时间')};
}
// Each accepted period is a separate task, preserving its report/reviews. No Agent is awakened here.
export function nextOccurrenceStatements(db,task,plan,at=Date.now()) {
  if(!plan.configured||plan.schedule.kind!=='recurring') return [];
  const interval=plan.schedule.interval_days*86400000,anchor=Date.parse(plan.schedule.start_at);
  const next=new Date(anchor+Math.max(1,Math.floor((at-anchor)/interval)+1)*interval).toISOString();
  const nextPlan={...plan,schedule:{...plan.schedule,start_at:next}};
  const stamp=new Date(at).toISOString(),guard="NOT EXISTS(SELECT 1 FROM task_recurrences WHERE previous_task_id=?) AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND status='done')";
  return [
    db.prepare(`INSERT INTO tasks(channel_id,title,detail,deadline,created_by,proposed_by,status,type,created_at,updated_at) SELECT ?,?,?,'',?,?,'open',?,?,? WHERE ${guard}`).bind(task.channel_id,task.title,task.detail||'',task.created_by,task.proposed_by||'',legacyType(plan.goal),stamp,stamp,task.id,task.id),
    db.prepare(`INSERT INTO task_plans(task_id,goal,collaboration,acceptance_json,schedule_json,delivery_json,updated_at) SELECT last_insert_rowid(),?,?,?,?,?,? WHERE ${guard}`).bind(plan.goal,plan.collaboration,JSON.stringify(plan.acceptance),JSON.stringify(nextPlan.schedule),JSON.stringify(plan.delivery),stamp,task.id,task.id),
    db.prepare(`INSERT INTO task_workflows(task_id,host_id,acceptance,min_sources,created_at) SELECT last_insert_rowid(),host_id,?,?,? FROM task_workflows WHERE task_id=? AND ${guard}`).bind(plan.acceptance.criteria,plan.acceptance.min_sources,stamp,task.id,task.id,task.id),
    db.prepare(`INSERT INTO task_recurrences(previous_task_id,next_task_id) SELECT ?,last_insert_rowid() WHERE ${guard}`).bind(task.id,task.id,task.id),
  ];
}
export async function createNextOccurrence(db,task,plan,at=Date.now()) {
  const statements=nextOccurrenceStatements(db,task,plan,at);
  if(!statements.length) return null;
  await db.batch(statements);
  return (await db.prepare('SELECT next_task_id FROM task_recurrences WHERE previous_task_id=?').bind(task.id).first())?.next_task_id||null;
}
