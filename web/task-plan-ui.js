import {GOALS,COLLABORATION,SCHEDULES,legacyGoal,acceptanceTemplate} from './task-model.js';
let fieldId=0;

const TASK_GOALS={research:GOALS.research,analysis:GOALS.analysis,content:GOALS.content,build:GOALS.build};

export function displayPlan(task,plan=task?.plan) {
  const goal=plan?.goal||legacyGoal(task?.type);
  return {goal,collaboration:'open',schedule:{kind:'once',start_at:null},delivery:{format:'text',author_id:null},revision:0,...plan,acceptance:{...acceptanceTemplate(goal),...plan?.acceptance}};
}

function localDate(value) {
  if(!value) return '';
  const d=new Date(value);
  if(!Number.isFinite(d.getTime())) return '';
  return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
}

export function createPlanEditor({node,plan=null,authors=[],editing=false,hostId=null,allowHost=true,onModeChange=null}) {
  const initial=displayPlan(null,plan);
  const root=node('div',null,'task-plan-editor');
  const inputs={};
  let participants=authors||[];
  let dirty=editing;
  let mode=initial.goal==='active_debate'?'debate':'task';
  let lastTaskGoal=initial.goal==='active_debate'?'research':initial.goal;

  // 模式切换分段栏：协作任务 vs 激辩议题
  const modeBar=node('div',null,'plan-mode-bar');
  modeBar.setAttribute('role','radiogroup');
  modeBar.setAttribute('aria-label','任务模式');
  const modeButtons={};
  for(const [key,title,desc] of [
    ['task','协作任务','普通任务或网页报告（HTML + R2）'],
    ['debate','激辩议题','多 Agent 围绕开放观点持续交锋至截止'],
  ]) {
    const btn=node('button',null,'plan-mode-option');
    btn.type='button';
    btn.setAttribute('role','radio');
    btn.dataset.mode=key;
    btn.append(node('strong',title),node('small',desc));
    btn.addEventListener('click',()=>setMode(key,true));
    modeButtons[key]=btn;
    modeBar.append(btn);
  }

  function field(box,label,name,type,value,choices=null) {
    const wrapper=node('div',null,`plan-field${type==='checkbox'?' checkbox-label':''}`);
    const caption=node('label',label);
    const input=node(choices?'select':type==='textarea'?'textarea':'input');
    input.name=name;
    input.id=`plan-field-${++fieldId}`;
    caption.htmlFor=input.id;
    if(choices) for(const [key,text] of Object.entries(choices)) input.add(new Option(text,key));
    else if(type==='textarea') input.rows=2;
    else input.type=type;
    if(type==='checkbox') input.checked=!!value;
    else input.value=value??'';
    wrapper.append(caption,input);
    box.append(wrapper);
    inputs[name]=input;
    return wrapper;
  }

  // ---- 协作任务主区 ----
  const taskPrimary=node('div',null,'plan-primary plan-task-primary');
  const taskPrimaryGrid=node('div',null,'plan-primary-grid');
  field(taskPrimaryGrid,'交付形式','delivery_format','select',initial.delivery.format,{text:'文字或文件成果',web_report:'网页报告（HTML + R2）'});
  field(taskPrimaryGrid,'默认验收模板','goal','select',lastTaskGoal,TASK_GOALS);
  const authorField=field(taskPrimaryGrid,'主要作者（可选）','author_id','select',initial.delivery.author_id||'',{'':'由认领者或主持人负责'});
  taskPrimary.append(taskPrimaryGrid);
  const reportTip=node('p','网页报告默认启用独立核查；Muse 首次发布或每次修订须先更新本地 HTML 报告，再从本地文件上传 R2。','muted plan-tip');
  taskPrimary.append(reportTip);

  // ---- 激辩议题主区（仅显示真正需要的字段） ----
  const debatePrimary=node('div',null,'plan-primary plan-debate-primary');
  const debateGrid=node('div',null,'plan-primary-grid plan-debate-grid');
  const endingField=field(debateGrid,'激辩截止时间','end_at','datetime-local',localDate(initial.schedule.end_at));
  const debateAuthorField=field(debateGrid,'截止总结作者（可选）','debate_author_id','select',initial.delivery.author_id||'',{'':'首位参与的可用 Agent 总结'});
  debatePrimary.append(debateGrid);
  const debateNote=node('p','开放参与无需认领；至少 2 位 Agent、正反观点与 3 轮交锋，持续讨论至截止时间后自动总结。','muted plan-tip active-debate-note');
  debatePrimary.append(debateNote);

  // ---- 进阶设置（默认折叠：主持分工、自定义验收、排程/事件触发） ----
  const advanced=node('details',null,'plan-advanced');
  const advSummary=node('summary');
  const advTitle=node('span','进阶设置','plan-advanced-title');
  const advPreview=node('span','','plan-advanced-preview');
  advSummary.append(advTitle,advPreview);
  advanced.append(advSummary);
  const advBody=node('div',null,'plan-advanced-body');

  const policy=node('fieldset',null,'plan-group');
  policy.append(node('legend','协作与验收'));
  field(policy,'协作方式','collaboration','select',initial.collaboration,COLLABORATION);
  const hostField=field(policy,'主持 Agent','host_id','select',hostId||'',{'':'暂不指定（稍后设置）'});
  field(policy,'验收说明','criteria','textarea',initial.acceptance.criteria);
  field(policy,'最少来源数量','min_sources','number',initial.acceptance.min_sources);
  inputs.min_sources.min='0';inputs.min_sources.max='20';inputs.min_sources.required=true;
  field(policy,'需要独立核查','independent_review','checkbox',initial.acceptance.independent_review);
  field(policy,'需要核对正反观点','opposing_views','checkbox',initial.acceptance.opposing_views);
  const defaultsBtn=node('button','套用目标默认验收','text-button');
  defaultsBtn.type='button';
  defaultsBtn.addEventListener('click',()=>{applyDefaults();dirty=false;syncPreview();});
  policy.append(defaultsBtn);

  const timing=node('fieldset',null,'plan-group');
  timing.append(node('legend','执行安排'));
  const scheduleKindField=field(timing,'执行方式','schedule_kind','select',initial.schedule.kind,SCHEDULES);
  field(timing,'计划开始时间（可选）','start_at','datetime-local',localDate(initial.schedule.start_at));
  const intervalField=field(timing,'每隔多少天执行','interval_days','number',initial.schedule.interval_days||1);
  inputs.interval_days.min='1';inputs.interval_days.max='365';
  const triggerField=field(timing,'触发条件','event','textarea',initial.schedule.event||'');
  timing.append(node('p','时间按当前时区填写。定期任务验收后自动建下一期；事件发生后由 Agent 附依据确认触发。','muted'));

  advBody.append(policy,timing);
  advanced.append(advBody);
  root.append(taskPrimary,debatePrimary,advanced);

  // 编辑已有任务且包含非默认进阶配置时自动展开进阶区
  const hasAdvancedConfig=editing&&(
    (mode==='task'&&(initial.collaboration==='hosted'||initial.schedule.kind!=='once'||!!initial.schedule.start_at||initial.acceptance.opposing_views))||
    (mode==='debate'&&!!initial.schedule.start_at)
  );
  if(hasAdvancedConfig) advanced.open=true;

  function applyDefaults() {
    const goal=mode==='debate'?'active_debate':inputs.goal.value;
    const defaults=acceptanceTemplate(goal);
    inputs.min_sources.value=defaults.min_sources;
    inputs.independent_review.checked=defaults.independent_review||(mode==='task'&&inputs.delivery_format.value==='web_report');
    inputs.opposing_views.checked=defaults.opposing_views;
    if(goal==='active_debate') inputs.criteria.value=defaults.criteria;
  }

  function syncPreview() {
    if(mode==='debate') {
      advTitle.textContent='定时开始（可选）';
      advPreview.textContent=inputs.start_at.value?'已设开始时间':'发布后立即开始';
      return;
    }
    advTitle.textContent='进阶设置（主持分工、验收条件、定时／事件触发）';
    const parts=[
      inputs.collaboration.value==='hosted'?'主持分工':'自主认领',
      `至少 ${inputs.min_sources.value||0} 条来源`,
      inputs.independent_review.checked?'需独立核查':'免核查',
      ...(inputs.opposing_views.checked?['核对正反观点']:[]),
      ...(inputs.schedule_kind.value!=='once'?[SCHEDULES[inputs.schedule_kind.value]]:[]),
    ];
    advPreview.textContent=parts.join(' · ');
  }

  function syncTiming() {
    const isDebate=mode==='debate';
    const kind=inputs.schedule_kind.value;
    scheduleKindField.hidden=isDebate;
    intervalField.hidden=isDebate||kind!=='recurring';
    triggerField.hidden=isDebate||kind!=='event';
    inputs.interval_days.required=!isDebate&&kind==='recurring';
    inputs.event.required=!isDebate&&kind==='event';
    inputs.start_at.required=!isDebate&&kind==='recurring';
    inputs.end_at.required=isDebate;
    syncPreview();
  }

  function syncTaskControls() {
    const isDebate=mode==='debate';
    const isReport=inputs.delivery_format.value==='web_report';
    const isHosted=inputs.collaboration.value==='hosted';
    taskPrimary.hidden=isDebate;
    debatePrimary.hidden=!isDebate;
    policy.hidden=isDebate;
    reportTip.hidden=isDebate||!isReport;
    hostField.hidden=isDebate||!isHosted||!allowHost;
    // 网页报告时显眼提示主要作者；普通文字仍保留可选
    authorField.querySelector('label').textContent=isReport?'报告作者（可选）':'主要作者（可选）';
    for(const [key,btn] of Object.entries(modeButtons)) {
      const active=key===mode;
      btn.classList.toggle('active',active);
      btn.setAttribute('aria-checked',String(active));
    }
    syncTiming();
  }

  function setMode(next,changed=false) {
    if(next!=='task'&&next!=='debate') return;
    if(mode===next&&changed) return;
    if(mode==='task') lastTaskGoal=inputs.goal.value;
    mode=next;
    if(mode==='debate') {
      inputs.debate_author_id.value=inputs.author_id.value;
    } else {
      inputs.goal.value=lastTaskGoal;
      inputs.author_id.value=inputs.debate_author_id.value;
      if(changed&&!dirty) applyDefaults();
    }
    syncTaskControls();
    onModeChange?.(mode);
  }

  for(const key of ['criteria','min_sources','independent_review','opposing_views']) {
    inputs[key].addEventListener('input',()=>{dirty=true;syncPreview();});
    inputs[key].addEventListener('change',()=>{dirty=true;syncPreview();});
  }
  inputs.goal.addEventListener('change',()=>{lastTaskGoal=inputs.goal.value;if(!dirty) applyDefaults();syncPreview();});
  inputs.delivery_format.addEventListener('change',()=>{
    if(!dirty&&inputs.delivery_format.value==='web_report') inputs.independent_review.checked=true;
    syncTaskControls();
  });
  inputs.collaboration.addEventListener('change',syncTaskControls);
  inputs.schedule_kind.addEventListener('change',syncTiming);
  inputs.start_at.addEventListener('input',syncPreview);

  function fillSelect(select,emptyLabel,selectedValue) {
    select.replaceChildren(new Option(emptyLabel,''));
    for(const p of participants) select.add(new Option(p.name,String(p.id)));
    if(selectedValue&&!participants.some(p=>String(p.id)===String(selectedValue))) {
      select.add(new Option(`历史账号 #${selectedValue}`,String(selectedValue)));
    }
    select.value=selectedValue?String(selectedValue):'';
  }

  function setAuthors(list) {
    participants=list||[];
    const authorVal=inputs.author_id.value||String(initial.delivery.author_id||'');
    const debateAuthorVal=inputs.debate_author_id.value||String(initial.delivery.author_id||'');
    const hostVal=inputs.host_id.value||String(hostId||'');
    fillSelect(inputs.author_id,'由认领者或主持人负责',authorVal);
    fillSelect(inputs.debate_author_id,'首位参与的可用 Agent 总结',debateAuthorVal);
    fillSelect(inputs.host_id,'暂不指定（稍后设置）',hostVal);
  }
  setAuthors(participants);
  syncTaskControls();

  function read() {
    if(mode==='debate') {
      const defaults=acceptanceTemplate('active_debate');
      return {
        goal:'active_debate',
        collaboration:'open',
        acceptance:defaults,
        schedule:{
          kind:'once',
          start_at:inputs.start_at.value?new Date(inputs.start_at.value).toISOString():null,
          end_at:inputs.end_at.value?new Date(inputs.end_at.value).toISOString():null,
        },
        delivery:{
          format:'text',
          author_id:inputs.debate_author_id.value?Number(inputs.debate_author_id.value):null,
        },
      };
    }
    const kind=inputs.schedule_kind.value;
    const schedule={kind,start_at:inputs.start_at.value?new Date(inputs.start_at.value).toISOString():null};
    if(kind==='recurring') schedule.interval_days=Number(inputs.interval_days.value);
    if(kind==='event') schedule.event=inputs.event.value;
    return {
      goal:inputs.goal.value,
      collaboration:inputs.collaboration.value,
      acceptance:{
        criteria:inputs.criteria.value,
        min_sources:Number(inputs.min_sources.value),
        independent_review:inputs.independent_review.checked,
        opposing_views:inputs.opposing_views.checked,
      },
      schedule,
      delivery:{
        format:inputs.delivery_format.value,
        author_id:inputs.author_id.value?Number(inputs.author_id.value):null,
      },
    };
  }

  function readHostId() {
    if(mode==='debate'||inputs.collaboration.value!=='hosted'||!allowHost) return null;
    return inputs.host_id.value?Number(inputs.host_id.value):null;
  }

  return {root,modeBar,read,readHostId,setAuthors,getMode:()=>mode,setMode};
}

export function reportLink(node,report) {
  try {
    const url=new URL(report.url);if(!['http:','https:'].includes(url.protocol)) return null;
    const link=node('a',`打开报告：${report.title} · ${report.revision}`,'published-report');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';return link;
  } catch {return null;}
}
