import {GOALS,COLLABORATION,SCHEDULES,legacyGoal,acceptanceTemplate} from './task-model.js';
let fieldId=0;

export function displayPlan(task,plan=task?.plan) {
  const goal=plan?.goal||legacyGoal(task?.type);
  return {goal,collaboration:'open',schedule:{kind:'once',start_at:null},delivery:{format:'text',author_id:null},revision:0,...plan,acceptance:{...acceptanceTemplate(goal),...plan?.acceptance}};
}
export function createPlanEditor({node,plan=null,authors=[],editing=false}) {
  const root=node('div',null,'task-plan-editor'),inputs={};let participants=authors,dirty=editing;
  const group=title=>{const box=node('fieldset',null,'plan-group');box.append(node('legend',title));root.append(box);return box;};
  function field(box,label,name,type,value,choices=null) {
    const wrapper=node('div',null,`plan-field${type==='checkbox'?' checkbox-label':''}`),caption=node('label',label);
    const input=node(choices?'select':type==='textarea'?'textarea':'input');input.name=name;
    input.id=`plan-field-${++fieldId}`;caption.htmlFor=input.id;
    if(choices) for(const [key,text] of Object.entries(choices)) input.add(new Option(text,key));
    else if(type==='textarea') input.rows=2;
    else input.type=type;
    if(type==='checkbox') input.checked=!!value;else input.value=value??'';
    wrapper.append(caption,input);box.append(wrapper);inputs[name]=input;
    return wrapper;
  }
  const initial=displayPlan(null,plan),goals=group('任务目标');
  field(goals,'任务目标','goal','select',initial.goal,GOALS);
  field(goals,'交付形式','delivery_format','select',initial.delivery.format,{text:'文字或文件成果',web_report:'已发布的网页报告（MUSE 等）'});
  field(goals,'主要作者（可选）','author_id','select',initial.delivery.author_id||'',{'':'由认领者或主持人负责'});
  const policy=group('协作验收');
  field(policy,'协作方式','collaboration','select',initial.collaboration,COLLABORATION);
  field(policy,'验收说明','criteria','textarea',initial.acceptance.criteria);
  field(policy,'最少来源数量','min_sources','number',initial.acceptance.min_sources);inputs.min_sources.min='0';inputs.min_sources.max='20';inputs.min_sources.required=true;
  field(policy,'需要独立核查','independent_review','checkbox',initial.acceptance.independent_review);
  field(policy,'需要核对正反观点','opposing_views','checkbox',initial.acceptance.opposing_views);
  policy.append(node('p','任务目标只提供默认模板；核查与来源要求可分别调整。最终由管理员确认交付。','muted'));
  function applyDefaults() {const defaults=acceptanceTemplate(inputs.goal.value);inputs.min_sources.value=defaults.min_sources;inputs.independent_review.checked=defaults.independent_review||inputs.delivery_format.value==='web_report';inputs.opposing_views.checked=false;}
  const defaults=node('button','套用目标默认验收','text-button');defaults.type='button';defaults.addEventListener('click',()=>{applyDefaults();dirty=false;});policy.append(defaults);
  for(const key of ['criteria','min_sources','independent_review','opposing_views']) inputs[key].addEventListener('input',()=>{dirty=true;});
  inputs.goal.addEventListener('change',()=>{if(!dirty) applyDefaults();});
  inputs.delivery_format.addEventListener('change',()=>{if(!dirty&&inputs.delivery_format.value==='web_report') inputs.independent_review.checked=true;});
  const timing=group('执行安排');
  field(timing,'执行方式','schedule_kind','select',initial.schedule.kind,SCHEDULES);
  function localDate(value) {if(!value) return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
  field(timing,'计划开始时间','start_at','datetime-local',localDate(initial.schedule.start_at));
  const interval=field(timing,'每隔多少天执行','interval_days','number',initial.schedule.interval_days||1);inputs.interval_days.min='1';inputs.interval_days.max='365';
  const trigger=field(timing,'触发条件','event','textarea',initial.schedule.event||'');
  function syncTiming() {const kind=inputs.schedule_kind.value;interval.hidden=kind!=='recurring';trigger.hidden=kind!=='event';inputs.interval_days.required=kind==='recurring';inputs.event.required=kind==='event';inputs.start_at.required=kind==='recurring';}
  inputs.schedule_kind.addEventListener('change',syncTiming);syncTiming();
  timing.append(node('p','时间按当前时区填写。定期任务验收后建立下一期；事件发生后由 Agent 附依据确认触发。','muted'));
  function setAuthors(list) {participants=list||[];const selected=inputs.author_id.value||String(initial.delivery.author_id||'');inputs.author_id.replaceChildren(new Option('由认领者或主持人负责',''));for(const p of participants) inputs.author_id.add(new Option(p.name,String(p.id)));if(selected&&!participants.some(p=>String(p.id)===selected)) inputs.author_id.add(new Option(`历史作者 #${selected}`,selected));inputs.author_id.value=selected;}
  setAuthors(participants);
  function read() {
    const kind=inputs.schedule_kind.value,schedule={kind,start_at:inputs.start_at.value?new Date(inputs.start_at.value).toISOString():null};
    if(kind==='recurring') schedule.interval_days=Number(inputs.interval_days.value);
    if(kind==='event') schedule.event=inputs.event.value;
    return {goal:inputs.goal.value,collaboration:inputs.collaboration.value,acceptance:{criteria:inputs.criteria.value,min_sources:Number(inputs.min_sources.value),independent_review:inputs.independent_review.checked,opposing_views:inputs.opposing_views.checked},schedule,delivery:{format:inputs.delivery_format.value,author_id:inputs.author_id.value?Number(inputs.author_id.value):null}};
  }
  return {root,read,setAuthors};
}
export function reportLink(node,report) {
  try {
    const url=new URL(report.url);if(!['http:','https:'].includes(url.protocol)) return null;
    const link=node('a',`打开报告：${report.title} · ${report.revision}`,'published-report');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';return link;
  } catch {return null;}
}
