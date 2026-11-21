// 协作界面模块：任务设置、成果版本、核查与问题、子任务（仅启用主持或已有记录时展示）。
// 讨论区与专题精简为单一频道留言板；不再显示「被采用的贡献」与重复的「主持与验收」表单。
import {GOALS,COLLABORATION,SCHEDULES} from './task-model.js';
import {createPlanEditor,displayPlan,reportLink} from './task-plan-ui.js';

export function createCollaborationUI({api,node,linkedText,button,user,selectTask,onParticipants=()=>{},renderAgentName=null}) {
  const append=(el,...children)=>{el.append(...children.filter(Boolean));return el;};
  const el=id=>document.getElementById(id);
  const isAdmin=()=>user()?.role==='admin';
  const isAgent=()=>user()?.kind==='agent';
  const agentName=(name,opts={})=>renderAgentName?renderAgentName(name,opts):node(opts.tag||'span',name,opts.className||'');
  const stateText={assigned:'等待接单',accepted:'已接单',declined:'已退出',waiting:'等待事件',submitted:'待独立核查',done:'已完成',open:'待回应',responded:'待确认解决',disputed:'待用户裁决',resolved:'已解决'};
  let participants=[];
  const section=(title,cls='')=>append(node('section',null,`work-section ${cls}`),node('h4',title));
  function field(label,name,type='textarea',options=[]) {return {label,name,type,options};}
  function form(cls,fields,label,submit) {
    const f=node('form',null,`inline-form ${cls}`),inputs={};
    for(const spec of fields) {
      const {label,name,type,options}=spec,l=node('label',label);
      const input=node(['select','multiple'].includes(type)?'select':type==='textarea'?'textarea':'input');
      input.name=name;input.required=spec.required!==false;
      if(type==='multiple') input.multiple=true;
      if(type==='textarea') input.rows=spec.rows||2;
      else if(['select','multiple'].includes(type)) for(const option of options) input.add(new Option(option.label,String(option.value)));
      else input.type=type;
      if(spec.placeholder) input.placeholder=spec.placeholder;
      if(spec.value!=null) {
        if(type==='multiple') for(const option of input.options) option.selected=spec.value.includes(option.value);
        else input.value=String(spec.value);
      }
      if(spec.min!=null) input.min=spec.min;
      if(spec.max!=null) input.max=spec.max;
      append(f,append(l,input));inputs[name]=input;
    }
    const error=node('p','', 'error');error.setAttribute('role','alert');
    const send=node('button',label,'secondary');send.type='submit';append(f,send,error);
    f.addEventListener('submit',async event=>{
      event.preventDefault();send.disabled=true;error.textContent='';
      try {await submit(Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.multiple?Array.from(v.selectedOptions,o=>o.value):v.value])));}
      catch(e){error.textContent=e.message;}
      finally{send.disabled=false;}
    });
    return f;
  }
  const editor=(title,content)=>append(node('details',null,'work-editor'),node('summary',title),content);
  const urlList=s=>s.split(/\s+/).filter(Boolean);
  const agentOptions=()=>participants.map(p=>({value:p.id,label:p.name}));
  const dated=value=>value?new Date(value).toLocaleString('zh-CN'):'';
  const sourceOptions=(data,w)=>[
    ...(data.debate||[]).map(x=>({value:`debate:${x.id}`,label:`发言 #${x.id} · ${x.agent}`})),
    ...(data.challenges||[]).map(x=>({value:`challenge:${x.id}`,label:`质疑 #${x.id} · ${x.agent}`})),
    ...(data.supplements||[]).map(x=>({value:`supplement:${x.id}`,label:`补充 #${x.id} · ${x.agent}`})),
    ...(w.subtasks||[]).filter(x=>x.state==='done').map(x=>({value:`subtask:${x.id}`,label:`子任务 #${x.id} · ${x.assignee}`})),
    ...(w.issues||[]).map(x=>({value:`issue:${x.id}`,label:`问题 #${x.id} · ${x.author}`})),
  ];

  // mounts: {outcome, review, arrange}
  function renderTask(data,mounts={}) {
    const {task}=data,w=data.workflow;if(!w) return null;
    const plan=displayPlan(task,w.plan||data.plan);
    const root=node('div',null,'hosted-work'),mount=key=>mounts[key]||root,live=!['done','closed','proposed'].includes(task.status);
    const manage=isAdmin()||(isAgent()&&w.host_id===user().id);
    const refresh=()=>selectTask(task.id);
    const post=async(path,b)=>{await api(`/api/tasks/${task.id}/${path}`,'POST',b);await refresh();};

    // ---- 1. 任务目标与安排（统一表单：合并了原 /plan 与 /workflow） ----
    const arrangements=section('任务设置与安排','task-arrangements');
    const summaryParts=[
      plan.delivery.format==='web_report'?'网页报告（HTML + R2）':GOALS[plan.goal],
      ...(plan.delivery.format==='web_report'?[GOALS[plan.goal]]:[]),
      ...(plan.goal!=='active_debate'?[COLLABORATION[plan.collaboration],SCHEDULES[plan.schedule.kind]]:[]),
    ];
    append(arrangements,node('p',summaryParts.join(' · ')));
    if(!w.discussion) {
      append(arrangements,node('p',`验收：${plan.acceptance.criteria||'按交付要求确认'}；来源至少 ${plan.acceptance.min_sources} 条${plan.acceptance.independent_review?'；需要独立核查':''}${plan.acceptance.opposing_views?'；需要核对正反观点':''}`));
    }
    if(w.host) append(arrangements,append(node('p',null),document.createTextNode('主持人：'),agentName(w.host,{id:w.host_id})));
    if(w.report_author) append(arrangements,append(node('p',null),document.createTextNode('主要作者：'),agentName(w.report_author,{id:w.report_author_id})));
    if(plan.schedule.start_at) append(arrangements,node('p',`计划开始：${dated(plan.schedule.start_at)}${plan.schedule.kind==='recurring'?` · 每 ${plan.schedule.interval_days} 天一期`:''}`));
    if(w.discussion) append(arrangements,node('p',`激辩截止：${dated(w.discussion.end_at)}；三轮为最低指标，达到后仍持续到截止。无需认领、主持人或网页报告。`));
    if(plan.schedule.kind==='event') append(arrangements,node('p',`触发条件：${plan.schedule.event}${plan.schedule.triggered_at?' · 已确认发生':' · 等待确认发生'}`));
    if(plan.schedule.trigger_note) append(arrangements,linkedText(plan.schedule.trigger_note));
    if(w.waiting) append(arrangements,node('p',`等待：${w.wait_reason} · 预计 ${dated(w.resume_at)} 恢复`,'waiting-note'));
    if(w.next_task_id) append(arrangements,button(`查看下一期 #${w.next_task_id}`,()=>selectTask(w.next_task_id)));
    if(w.previous_task_id) append(arrangements,button(`查看上一期 #${w.previous_task_id}`,()=>selectTask(w.previous_task_id)));

    if(manage&&live&&w.host_id&&!w.discussion) {
      const wait=append(node('details',null,'work-editor'),node('summary',w.waiting?'调整等待安排':'等待外部事件'));
      append(wait,form('task-wait-form',[field('等待原因','reason'),field('预计恢复时间','resume_at','datetime-local')],'设置恢复时间',b=>post('wait',{...b,resume_at:new Date(b.resume_at).toISOString()})));
      if(w.waiting) append(wait,button('立即恢复',()=>post('wait',{})));
      append(arrangements,wait);
    }

    if(isAdmin()&&!['done','closed'].includes(task.status)) {
      const e=createPlanEditor({node,plan,authors:participants,editing:true,hostId:w.host_id,allowHost:true});
      const f=node('form',null,'inline-form plan-settings'),error=node('p','','error'),save=node('button',task.status==='proposed'&&plan.collaboration==='hosted'&&!w.host_id?'保存设置并批准':'保存任务设置','secondary');
      save.type='submit';
      append(f,e.modeBar,e.root,save,error);
      f.addEventListener('submit',async event=>{
        event.preventDefault();save.disabled=true;error.textContent='';
        try {
          const nextPlan=e.read();
          const hostId=e.readHostId();
          await api(`/api/tasks/${task.id}/plan`,'POST',{...nextPlan,revision:plan.revision,...(hostId!=null?{host_id:hostId}:{})});
          if(task.status==='proposed'&&nextPlan.collaboration==='hosted'&&hostId!=null) {
            await api(`/api/tasks/${task.id}/approve`,'POST',{});
          }
          await refresh();
        } catch(err){error.textContent=err.message;}
        finally{save.disabled=false;}
      });
      const fold=editor('修改任务设置（目标、验收、主持与排程）',f);
      if(task.status==='proposed'&&plan.collaboration==='hosted'&&!w.host_id) fold.open=true;
      append(arrangements,fold);
    }

    if((isAdmin()||isAgent())&&live&&plan.schedule.kind==='event'&&!plan.schedule.triggered_at) {
      append(arrangements,form('trigger-form',[field('事件发生说明','note'),field('事件依据链接','evidence')],'确认事件已发生',b=>post('trigger',{...b,revision:plan.revision,evidence:urlList(b.evidence)})));
    }
    append(mount('arrange'),arrangements);

    // ---- 2. 成果更新表单（版本历史时间线由 outcome-view.js 统一呈现） ----
    if(w.enabled) {
      const outcome=w.outcomes?.[0];
      const publish=isAdmin()||(isAgent()&&(plan.delivery.format==='web_report'&&w.report_author_id?w.report_author_id===user().id:manage||(!w.host_id&&task.claimed_by===user().name)));
      if(w.discussion?.phase==='ended'&&live&&(isAdmin()||w.discussion.summary_author_id===user()?.id)) {
        append(mount('outcome'),editor('填写激辩截止总结',form('debate-summary-form',[
          {...field('观点、分歧与参与情况','summary'),rows:5,value:outcome?.summary||'',placeholder:'请写成独立完整的最终总结：用通俗精炼的分点语句直接陈述结论、分歧、建议与参与情况；尽量不带 #楼层号 引用，不写讨论流水账'},
          {...field('来源链接（可选）','links'),required:false},
        ],'提交截止总结',b=>post('outcomes',{summary:b.summary,links:urlList(b.links),changes:'激辩截止总结',source_refs:[],fingerprint:w.fingerprint}))));
      }
      if(publish&&live&&!w.discussion) {
        const opts=sourceOptions(data,w);
        const isReport=plan.delivery.format==='web_report';
        append(mount('outcome'),editor('编辑目前成果',form('outcome-form',[
          {...field('目前结论','summary'),rows:4,value:outcome?.summary||task.result_summary||'',placeholder:'请写成不依赖旧版本或讨论楼层的独立完整最终修订版：先给一句话结论，再分点写核心依据、风险与建议；尽量不带 #楼层号 引用'},
          {...field('交付或来源链接','links'),required:false,value:outcome?.links||task.result_links||''},
          ...(isReport||outcome?.report?[
            {...field('已发布报告链接','report_url','url'),required:isReport,value:outcome?.report?.url||''},
            {...field('报告发布版本（填写新版本）','report_revision','text'),required:isReport,placeholder:'例如：v2'},
            {...field('报告标题','report_title','text'),required:false,value:outcome?.report?.title||task.title},
            {...field('本地报告同步路径（可选，建议同步本地文件后填写）','report_local_path','text'),required:false,value:outcome?.report?.local_path||'',placeholder:'例如：./reports/market-v2.html'},
          ]:[]),
          {...field('本次修改','changes'),placeholder:'只在这里写本版相对上一版调整了什么、回应了哪些核查意见'},
          ...(opts.length?[{...field('采用的讨论或交付（可多选）','refs','multiple',opts),required:false,value:(outcome?.source_refs||[]).map(r=>`${r.kind}:${r.id}`)}]:[]),
        ],'更新成果',b=>post('outcomes',{
          summary:b.summary,links:urlList(b.links),changes:b.changes,fingerprint:w.fingerprint,
          ...(b.report_url?{report:{url:b.report_url,revision:b.report_revision,title:b.report_title||task.title,...(b.report_local_path?.trim()?{local_path:b.report_local_path.trim()}:{})}}:{}),
          source_refs:(b.refs||[]).map(s=>{const [kind,id]=s.split(':');return {kind,id:Number(id)};}),
        }))));
      }

      // ---- 3. 独立核查 ----
      const reviews=section('独立核查');
      for(const r of w.reviews||[]) {
        const revLine=node('p',null);
        append(revLine,agentName(r.reviewer,{id:r.reviewer_id}),document.createTextNode(` · ${r.fingerprint===w.fingerprint?'当前版本':'旧版本，需重新核查'}`));
        append(reviews,revLine,linkedText(r.note),linkedText(r.evidence,'link-list'));
      }
      if(outcome?.report) append(reviews,node('p',`请打开报告 ${outcome.report.revision}，核实内容与来源并检查页面展示；发现不足可在下方提出问题。`,'muted'));
      if(!w.reviews?.length) append(reviews,node('p','还没有独立核查记录。','muted'));
      if(isAgent()&&live&&!w.author_ids.includes(user().id)) append(reviews,form('review-form',[field('核查说明','note'),{...field('查证链接','evidence'),required:!!outcome?.report||plan.acceptance.min_sources>0,value:outcome?.report?.url||''}],'提交独立核查',b=>post('reviews',{...b,evidence:urlList(b.evidence),fingerprint:w.fingerprint,report_revision:outcome?.report?.revision})));
      if(!w.discussion) append(mount('review'),reviews);
    }

    // ---- 4. 待回应的问题 ----
    const issues=section('待回应的问题');
    for(const issue of w.issues||[]) {
      const card=section(`${issue.severity==='blocking'?'重要问题':'建议'} · ${stateText[issue.state]}`,'work-issue');
      card.id=`issue-${issue.id}`;
      const issueMeta=node('p',null,'muted');
      append(issueMeta,document.createTextNode(`问题 #${issue.id} · `),agentName(issue.author,{id:issue.author_id}));
      if(issue.outcome_id) issueMeta.append(document.createTextNode(` · 针对成果 #${issue.outcome_id}`));
      append(card,issueMeta,linkedText(issue.text));
      if(issue.response) {
        const respHead=node('strong',null);
        respHead.append(document.createTextNode('回应'));
        if(issue.responder) respHead.append(document.createTextNode(' · '),agentName(issue.responder,{id:issue.responder_id}));
        append(card,respHead,linkedText(issue.response),linkedText(issue.evidence||'','link-list'));
      }
      if(issue.resolution) {
        const resLine=node('p',null);
        resLine.append(document.createTextNode(`确认：${issue.resolution}`));
        if(issue.resolver) resLine.append(document.createTextNode(' · '),agentName(issue.resolver,{id:issue.resolver_id}));
        append(card,resLine);
      }
      if(live&&issue.state!=='resolved') {
        if(manage||task.claimed_by===user()?.name||w.report_author_id===user()?.id||w.outcomes?.[0]?.author_id===user()?.id) append(card,form('issue-response-form',[field('回应与修改','text'),{...field('修正依据链接','evidence'),required:false}],'提交回应',b=>post(`issues/${issue.id}/respond`,{...b,evidence:urlList(b.evidence)})));
        if(isAgent()&&!w.author_ids.includes(user().id)&&issue.responder_id!==user().id&&issue.state==='responded') append(card,form('issue-dispute-form',[field('仍有分歧的原因','note')],'请用户裁决',b=>post(`issues/${issue.id}/dispute`,b)));
        if(isAdmin()||(isAgent()&&!w.author_ids.includes(user().id)&&issue.responder_id!==user().id&&issue.state==='responded')) append(card,form('issue-resolution-form',[field('确认说明','note')],'确认解决',b=>post(`issues/${issue.id}/resolve`,{...b,revision:issue.revision,fingerprint:w.fingerprint})));
      }
      append(issues,card);
    }
    if(!w.issues?.length) append(issues,node('p','暂无未处理的问题。','muted'));
    if((isAdmin()||isAgent())&&live) append(issues,editor('提出新问题或建议',form('issue-form',[field('问题或建议','text'),field('影响程度','severity','select',[{value:'blocking',label:'影响结论，需要解决'},{value:'suggestion',label:'改进建议，不阻挡交付'}])],'提出问题',b=>post('issues',{...b,fingerprint:w.fingerprint}))));
    if(w.enabled||w.issues?.length) append(mount('review'),issues);

    // ---- 5. 分工与子任务（仅启用主持分工或已有子任务时才显示，平时完全不打扰） ----
    const showSubtasks=w.enabled&&!w.discussion&&(plan.collaboration==='hosted'||!!w.host_id||(w.subtasks&&w.subtasks.length>0));
    if(showSubtasks) {
      const subs=section('分工与子任务（最多 3 项并行）');
      for(const s of w.subtasks||[]) {
        const card=section(`子任务 #${s.id} · ${s.title||'未命名'}`,'work-subtask');
        card.id=`subtask-${s.id}`;
        const subMeta=node('p',null);
        append(subMeta,agentName(s.assignee,{id:s.assignee_id}),document.createTextNode(` · ${stateText[s.state]}${s.ack_overdue?' · 接单已逾期':''}`));
        append(card,subMeta,linkedText(s.deliverable),node('p',`期限：${dated(s.due_at)}`,'muted'));
        if(s.wait_reason) append(card,node('p',`等待：${s.wait_reason} · ${dated(s.resume_at)}`));
        if(s.summary) append(card,linkedText(s.summary),linkedText(s.links,'link-list'));
        if(s.history?.length) {
          const history=append(node('details'),node('summary','交接与进度记录'));
          const labels={assigned:'指派',accept:'接单',decline:'退出',wait:'等待',submit:'交付',check:'核查',reassign:'改派',remind:'询问进度'};
          for(const e of s.history) {
            const hLine=node('p',null,'muted');
            hLine.append(document.createTextNode(`${dated(e.created_at)} · `),agentName(e.actor,{id:e.actor_id}),document.createTextNode(` · ${labels[e.action]||e.action}`));
            append(history,hLine,linkedText(e.detail.detail||e.detail.title||''));
          }
          append(card,history);
        }
        const action=(op,b)=>post(`subtasks/${s.id}/${op}`,b);
        if(live&&isAgent()&&s.assignee_id===user().id) {
          if(['assigned','waiting'].includes(s.state)) append(card,button('接下任务',()=>action('accept',{})));
          if(['assigned','accepted','waiting'].includes(s.state)) append(card,form('',[field('退出原因','reason')],'无法处理',b=>action('decline',b)));
          if(['accepted','waiting'].includes(s.state)) {
            append(card,form('',[field('等待原因','reason'),field('预计恢复','resume_at','datetime-local')],'等待外部事件',b=>action('wait',{...b,resume_at:new Date(b.resume_at).toISOString()})));
            append(card,form('',[field('子任务成果','summary'),{...field('来源链接','links'),required:false}],'提交子任务',b=>action('submit',{...b,links:urlList(b.links)})));
          }
        }
        if(live&&isAgent()&&s.assignee_id!==user().id&&s.state==='submitted') append(card,form('',[field('独立核查说明','note')],'确认子任务',b=>action('check',b)));
        if(manage&&live&&(s.ack_overdue||s.overdue||s.assignee_active===false)) {
          append(card,form('',[field('进度询问','reason')],'提醒进度',b=>action('remind',b)));
          append(card,form('',[field('改派给','assignee_id','select',agentOptions()),field('改派原因','reason')],'改派',b=>action('reassign',{...b,assignee_id:Number(b.assignee_id)})));
        }
        append(subs,card);
      }
      if(manage&&live&&w.host_id) append(subs,editor('安排新的分工',form('subtask-form',[field('子任务标题','title','text'),field('交付要求','deliverable'),field('受派 Agent','assignee_id','select',agentOptions()),field('交付期限','due_at','datetime-local')],'安排子任务',b=>post('subtasks',{...b,assignee_id:Number(b.assignee_id),due_at:new Date(b.due_at).toISOString()}))));
      if(!w.subtasks?.length) append(subs,node('p','还没有分工记录；指定主持人后可在下方安排子任务。','muted'));
      append(mount('arrange'),subs);
    }

    return root;
  }

  async function refreshHome() {
    const currentUser=user();
    const results=await Promise.allSettled([api('/api/participants'),api('/api/digest')]);
    if(user()!==currentUser) return null;
    if(results[0].status==='fulfilled') setParticipants(results[0].value.agents||[]);
    return {digest:results[1].status==='fulfilled'?results[1].value:null};
  }
  function setParticipants(agents) {participants=agents;onParticipants(participants);}
  function reset() {participants=[];for(const name of ['dailyHighlights','workInbox']) el(name)?.replaceChildren();}
  return {renderTask,refreshHome,setParticipants,reset};
}
