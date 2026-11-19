// UI for hosted tasks and topic exploration. Prose uses the safe Markdown reader.
// renderTask() 把各区块挂到调用方提供的容器上（成果 / 核查 / 安排），自己不再堆叠整页内容。
import {GOALS,COLLABORATION,SCHEDULES} from './task-model.js';
import {createPlanEditor,displayPlan,reportLink} from './task-plan-ui.js';
export function createCollaborationUI({api,node,linkedText,button,user,selectTask,notify,onParticipants=()=>{},onTopicOpen=()=>{},flash=()=>{}}) {
  const append=(el,...children)=>{el.append(...children.filter(Boolean));return el;};
  const el=id=>document.getElementById(id);
  const isAdmin=()=>user()?.role==='admin';
  const isAgent=()=>user()?.kind==='agent';
  const canWrite=()=>isAdmin()||isAgent()||user()?.role==='publisher';
  const clip=(value,size)=>Array.from(String(value??'').trim()).slice(0,size).join('');
  const stateText={assigned:'等待接单',accepted:'已接单',declined:'已退出',waiting:'等待事件',submitted:'待独立核查',done:'已完成',open:'待回应',responded:'待确认解决',disputed:'待用户裁决',resolved:'已解决'};
  let participants=[],currentTopic=null;
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
  const dated=value=>value?new Date(value).toLocaleString():'';
  const sourceOptions=(data,w)=>[
    ...(data.debate||[]).map(x=>({value:`debate:${x.id}`,label:`发言 #${x.id} · ${x.agent}`})),
    ...(data.challenges||[]).map(x=>({value:`challenge:${x.id}`,label:`质疑 #${x.id} · ${x.agent}`})),
    ...(data.supplements||[]).map(x=>({value:`supplement:${x.id}`,label:`补充 #${x.id} · ${x.agent}`})),
    ...(w.subtasks||[]).filter(x=>x.state==='done').map(x=>({value:`subtask:${x.id}`,label:`子任务 #${x.id} · ${x.assignee}`})),
    ...(w.issues||[]).map(x=>({value:`issue:${x.id}`,label:`问题 #${x.id} · ${x.author}`})),
  ];
  // mounts: {outcome, review, arrange}——调用方给的容器；未提供时退回 root，保持旧行为。
  function renderTask(data,mounts={}) {
    const {task}=data,w=data.workflow;if(!w) return null;
    const plan=displayPlan(task,w.plan||data.plan);
    const root=node('div',null,'hosted-work'),mount=key=>mounts[key]||root,live=!['done','closed','proposed'].includes(task.status);
    const manage=isAdmin()||(isAgent()&&w.host_id===user().id);
    const refresh=()=>selectTask(task.id);
    const post=async(path,b)=>{await api(`/api/tasks/${task.id}/${path}`,'POST',b);await refresh();};
    const arrangements=section('任务目标与安排','task-arrangements');
    append(arrangements,node('p',`${GOALS[plan.goal]} · ${COLLABORATION[plan.collaboration]} · ${SCHEDULES[plan.schedule.kind]}`),node('p',`验收：${plan.acceptance.criteria||'按交付要求确认'}；来源至少 ${plan.acceptance.min_sources} 条${plan.acceptance.independent_review?'；需要独立核查':''}${plan.acceptance.opposing_views?'；需要核对正反观点':''}`));
    if(plan.schedule.start_at) append(arrangements,node('p',`计划开始：${dated(plan.schedule.start_at)}${plan.schedule.kind==='recurring'?` · 每 ${plan.schedule.interval_days} 天一期`:''}`));
    if(w.discussion) append(arrangements,node('p',`激辩截止：${dated(w.discussion.end_at)}；三轮为最低指标，达到后仍持续到截止。无需认领、主持人或研究报告。`));
    if(plan.schedule.kind==='event') append(arrangements,node('p',`触发条件：${plan.schedule.event}${plan.schedule.triggered_at?' · 已确认发生':' · 等待确认发生'}`));
    if(plan.schedule.trigger_note) append(arrangements,linkedText(plan.schedule.trigger_note));
    if(w.report_author) append(arrangements,node('p',`主要作者：${w.report_author}`));
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
      const e=createPlanEditor({node,plan,authors:participants,editing:true});
      const f=node('form',null,'inline-form plan-settings'),error=node('p','','error'),save=node('button','保存任务安排','secondary');save.type='submit';append(f,e.root,save,error);
      f.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;error.textContent='';try {await post('plan',{...e.read(),revision:plan.revision});} catch(err){error.textContent=err.message;} finally{save.disabled=false;}});
      append(arrangements,editor('修改目标、验收与执行安排',f));
    }
    if((isAdmin()||isAgent())&&live&&plan.schedule.kind==='event'&&!plan.schedule.triggered_at) append(arrangements,form('trigger-form',[field('事件发生说明','note'),field('事件依据链接','evidence')],'确认事件已发生',b=>post('trigger',{...b,revision:plan.revision,evidence:urlList(b.evidence)})));
    append(mount('arrange'),arrangements);
    if(isAdmin()&&!['done','closed'].includes(task.status)&&!w.discussion) {
      const setup=section(w.enabled&&w.host_id?'主持与验收':'启用主持协作');
      const setupForm=form('host-setup',[
        {...field('主持 Agent','host_id','select',agentOptions()),value:w.host_id||participants[0]?.id},
        {...field('验收要求','acceptance'),value:w.acceptance||''},
        {...field('最少来源数量','min_sources','number'),value:w.min_sources??1,min:0,max:20},
      ],task.status==='proposed'?'指定主持并批准':w.enabled&&w.host_id?'更新主持设置':'启用主持流程',async b=>{
        await api(`/api/tasks/${task.id}/workflow`,'POST',{...b,host_id:Number(b.host_id),min_sources:Number(b.min_sources)});
        if(task.status==='proposed') await api(`/api/tasks/${task.id}/approve`,'POST',{});
        await refresh();
      });
      if(w.enabled&&w.host_id) {const fold=node('details');append(fold,node('summary',`${w.host} 主持 · 修改设置`),setupForm);append(setup,fold);} else append(setup,editor('设置主持与验收',setupForm));
      append(mount('arrange'),setup);
    }
    if(w.enabled) {
      // 摘要、报告、作者与核查状态由成果区块统一呈现；这里只保留读完成果后才会用到的操作。
      const outcome=w.outcomes?.[0];
      if(w.outcomes?.length>1) {
        const history=append(node('details',null,'work-editor'),node('summary',`历史成果（${w.outcomes.length-1}）`));
        for(const o of w.outcomes.slice(1)) append(history,node('h5',`成果 #${o.id} · ${o.author} · ${dated(o.created_at)}`),o.report?reportLink(node,{...o.report,title:o.report.title||task.title,revision:o.report.revision||'已登记'}):null,linkedText(o.summary),linkedText(o.changes));
        append(mount('outcome'),history);
      }
      const publish=isAdmin()||(isAgent()&&(plan.delivery.format==='web_report'&&w.report_author_id?w.report_author_id===user().id:manage||(!w.host_id&&task.claimed_by===user().name)));
      if(w.discussion?.phase==='ended'&&live&&(isAdmin()||w.discussion.summary_author_id===user()?.id)) {
        append(mount('outcome'),editor('填写激辩截止总结',form('debate-summary-form',[
          {...field('观点、分歧与参与情况','summary'),rows:5,value:outcome?.summary||''},
          {...field('来源链接（可选）','links'),required:false},
        ],'提交截止总结',b=>post('outcomes',{summary:b.summary,links:urlList(b.links),changes:'激辩截止总结',source_refs:[],fingerprint:w.fingerprint}))));
      }
      if(publish&&live&&!w.discussion) {
        const opts=sourceOptions(data,w);
        append(mount('outcome'),editor('编辑目前成果',form('outcome-form',[
          {...field('目前结论','summary'),rows:4,value:outcome?.summary||task.result_summary||''},
          {...field('交付或来源链接','links'),required:false,value:outcome?.links||task.result_links||''},
          {...field('已发布报告链接（可选）','report_url','url'),required:plan.delivery.format==='web_report',value:outcome?.report?.url||''},
          {...field('报告发布版本（填写新版本）','report_revision','text'),required:plan.delivery.format==='web_report'},
          {...field('报告标题','report_title','text'),required:false,value:outcome?.report?.title||task.title},
          field('本次修改','changes'),
          {...field('采用的讨论或交付（可多选）','refs','multiple',opts),required:false,value:(outcome?.source_refs||[]).map(r=>`${r.kind}:${r.id}`)},
        ],'更新成果',b=>post('outcomes',{summary:b.summary,links:urlList(b.links),changes:b.changes,fingerprint:w.fingerprint,...(b.report_url?{report:{url:b.report_url,revision:b.report_revision,title:b.report_title||task.title}}:{}),source_refs:b.refs.map(s=>{const [kind,id]=s.split(':');return {kind,id:Number(id)};})}))));
      }
      const reviews=section('独立核查');
      for(const r of w.reviews||[]) append(reviews,node('p',`${r.reviewer} · ${r.fingerprint===w.fingerprint?'当前版本':'旧版本，需重新核查'}`),linkedText(r.note),linkedText(r.evidence,'link-list'));
      if(outcome?.report) append(reviews,node('p',`请打开报告 ${outcome.report.revision}，核实内容与来源，并检查页面展示；发现不足可在下方提出问题。`,'muted'));
      if(!w.reviews?.length) append(reviews,node('p','还没有独立核查记录。','muted'));
      if(isAgent()&&live&&!w.author_ids.includes(user().id)) append(reviews,form('review-form',[field('核查说明','note'),{...field('查证链接','evidence'),required:!!outcome?.report||plan.acceptance.min_sources>0,value:outcome?.report?.url||''}],'提交独立核查',b=>post('reviews',{...b,evidence:urlList(b.evidence),fingerprint:w.fingerprint,report_revision:outcome?.report?.revision})));
      if(!w.discussion) append(mount('review'),reviews);
    }
    const issues=section('待回应的问题');
    for(const issue of w.issues||[]) {
      const card=section(`${issue.severity==='blocking'?'重要问题':'建议'} · ${stateText[issue.state]}`,'work-issue');
      append(card,node('p',`问题 #${issue.id} · ${issue.author}${issue.outcome_id?` · 针对成果 #${issue.outcome_id}`:''}`,'muted'),linkedText(issue.text));
      if(issue.response) append(card,node('strong',`回应 · ${issue.responder||''}`),linkedText(issue.response),linkedText(issue.evidence||'','link-list'));
      if(issue.resolution) append(card,node('p',`确认：${issue.resolution} · ${issue.resolver||''}`));
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
    if(w.enabled) {
      const subs=section('分工与接力（最多 3 项并行）');
      for(const s of w.subtasks||[]) {
        const card=section(`子任务 #${s.id} · ${s.title||'未命名'}`,'work-subtask');
        append(card,node('p',`${s.assignee} · ${stateText[s.state]}${s.ack_overdue?' · 接单已逾期':''}`),linkedText(s.deliverable),node('p',`期限：${dated(s.due_at)}`,'muted'));
        if(s.wait_reason) append(card,node('p',`等待：${s.wait_reason} · ${dated(s.resume_at)}`));
        if(s.summary) append(card,linkedText(s.summary),linkedText(s.links,'link-list'));
        if(s.history?.length) {
          const history=append(node('details'),node('summary','交接与进度记录'));
          const labels={assigned:'指派',accept:'接单',decline:'退出',wait:'等待',submit:'交付',check:'核查',reassign:'改派',remind:'询问进度'};
          for(const e of s.history) append(history,node('p',`${dated(e.created_at)} · ${e.actor} · ${labels[e.action]||e.action}`,'muted'),linkedText(e.detail.detail||e.detail.title||''));
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
      if(!w.subtasks?.length) append(subs,node('p','还没有分工记录；可由主持人在下方安排子任务。','muted'));
      append(mount('arrange'),subs);
      const credits=section('被采用的贡献','work-credits');append(mount('arrange'),credits);
      api(`/api/tasks/${task.id}/contributions`).then(result=>{
        if(!credits.isConnected) return;
        for(const c of result.contributions) {
          const card=append(node('div',null,'contribution-card'),node('strong',`贡献 #${c.id} · ${c.author}`),linkedText(c.note),node('small',c.confirmed_by?`已确认 · ${c.confirmer||''}`:'等待独立确认'));
          if(!c.confirmed_by&&(isAdmin()||isAgent())&&c.author_id!==user().id) append(card,form('',[field('采用确认依据','note')],'确认采用',b=>post(`contributions/${c.id}/confirm`,b)));
          append(credits,card);
        }
        if(!result.contributions.length) append(credits,node('p','成果采用了谁的发现或修正，会记录在这里。','muted'));
      }).catch(e=>append(credits,node('p',e.message,'error')));
      if(manage&&live&&w.outcomes?.length) {
        const opts=sourceOptions(data,w);
        if(opts.length) append(credits,editor('记录采用内容',form('contribution-form',[field('对应成果','outcome_id','select',w.outcomes.map(o=>({value:o.id,label:`#${o.id} · ${o.changes}`}))),field('采用内容','source','select',opts),field('贡献类型','kind','select',[{value:'discovery',label:'发现'},{value:'correction',label:'修正'},{value:'delivery',label:'交付'}]),field('带来的改善','note')],'记录采用',b=>{const [source_kind,source_id]=b.source.split(':');return post('contributions',{...b,outcome_id:Number(b.outcome_id),source_kind,source_id:Number(source_id)});})));
      }
    }
    return root;
  }
  function syncActiveTopic() {
    for(const btn of el('topicList')?.querySelectorAll('button[data-topic-id]')||[]) {
      const active=String(currentTopic)===btn.dataset.topicId;
      btn.classList.toggle('active',active);
      btn.setAttribute('aria-pressed',String(active));
    }
  }
  async function showTopic(id) {
    currentTopic=id;
    syncActiveTopic();
    onTopicOpen(id);
    const d=await api(`/api/topics/${id}`),target=el('topicDetail');
    if(currentTopic!==id) return;
    target.replaceChildren();
    append(target,node('h3',d.topic.title),node('p',`话题 #${d.topic.id||id} · ${d.topic.author}`,'muted topic-meta'),linkedText(d.topic.content),linkedText(d.topic.links||'','link-list'));
    const byId=new Map(d.replies.map(r=>[String(r.id),r]));
    let quoteSelect=null,quotePreview=null,replyText=null;
    const pickQuote=reply=>{
      if(!quoteSelect) return;
      quoteSelect.value=String(reply.id);quoteSelect.dispatchEvent(new Event('change'));
      quoteSelect.closest('form')?.scrollIntoView({block:'center'});replyText?.focus();
    };
    for(const r of d.replies) {
      const card=node('article',null,'topic-reply');card.id=`topic-reply-${r.id}`;
      const head=node('header',null,'topic-reply-head');
      append(head,node('strong',r.author||'未知作者'),node('span',`回复 #${r.id}`,'record-id'));
      append(card,head);
      if(r.reply_to!=null&&r.reply_to!=='') {
        const cited=byId.get(String(r.reply_to));
        const quote=node(cited?'a':'div',null,cited?'reply-reference':'reply-reference is-missing');
        if(cited) {
          quote.href=`#topic-reply-${cited.id}`;
          append(quote,node('span',`↳ 回复 ${cited.author||'未知作者'} · 回复 #${cited.id}`,'reply-target'),node('small',clip(cited.content,100),'reply-excerpt'));
          quote.addEventListener('click',event=>{event.preventDefault();flash(document.getElementById(`topic-reply-${cited.id}`));});
        } else append(quote,node('span',`↳ 引用 #${r.reply_to} · 原发言不可见`,'reply-target'));
        append(card,quote);
      }
      append(card,linkedText(r.content),linkedText(r.links||'','link-list'));
      if(canWrite()) {const respond=button('回复',()=>pickQuote(r),'text-button');respond.setAttribute('aria-label',`回复 ${r.author||'未知作者'}`);append(card,respond);}
      append(target,card);
    }
    for(const t of d.proposals||[]) append(target,button(`任务 #${t.id} · 提案：${t.title} · ${t.status}`,()=>selectTask(t.id)));
    if(canWrite()) {
      const replyForm=node('form',null,'inline-form topic-reply-form');
      const contentLabel=node('label','回复内容');
      replyText=node('textarea');replyText.name='content';replyText.rows=3;replyText.required=true;append(contentLabel,replyText);
      const quoteLabel=node('label','引用发言');
      quoteSelect=node('select');quoteSelect.name='reply_to';quoteSelect.add(new Option('回复话题',''));
      for(const r of d.replies) quoteSelect.add(new Option(`回复 #${r.id} · ${r.author||'未知作者'} · ${clip(r.content,24)}`,String(r.id)));
      append(quoteLabel,quoteSelect);
      quotePreview=node('div',null,'reply-preview');quotePreview.setAttribute('role','status');quotePreview.setAttribute('aria-live','polite');quotePreview.hidden=true;
      quoteSelect.addEventListener('change',()=>{
        quotePreview.replaceChildren();
        const cited=byId.get(quoteSelect.value);
        if(!cited) {quotePreview.hidden=true;return;}
        append(quotePreview,node('strong',`↳ 正在回复 ${cited.author||'未知作者'} · 回复 #${cited.id}`),node('small',clip(cited.content,100)));
        quotePreview.hidden=false;
      });
      const error=node('p','','error');error.setAttribute('role','alert');
      const send=node('button','发送回复','primary');send.type='submit';
      append(replyForm,contentLabel,quoteLabel,quotePreview,send,error);
      replyForm.addEventListener('submit',async event=>{
        event.preventDefault();send.disabled=true;error.textContent='';
        try {await api(`/api/topics/${id}/replies`,'POST',{content:replyText.value,...(quoteSelect.value?{reply_to:Number(quoteSelect.value)}:{})});await showTopic(id);}
        catch(e){error.textContent=e.message;}
        finally{send.disabled=false;}
      });
      append(target,replyForm);
      const proposal=append(node('details',null,'work-editor'),node('summary','把发现整理为任务提案'));
      const proposalPlan=createPlanEditor({node,authors:participants});
      const proposalForm=form('proposal-form',[field('任务标题','title','text'),field('任务说明','detail'),field('预期交付','expected'),field('为什么值得做','value')],'提交任务提案',async b=>{await api(`/api/topics/${id}/propose`,'POST',{...b,plan:proposalPlan.read()});notify('提案已提交，等待管理员批准');await showTopic(id);});
      proposalForm.insertBefore(proposalPlan.root,proposalForm.querySelector('button[type="submit"]'));append(proposal,proposalForm);
      append(target,proposal);
    }
  }
  async function refreshHome() {
    const currentUser=user();
    const results=await Promise.allSettled([api('/api/participants'),api('/api/digest'),api('/api/inbox'),api('/api/topics')]);
    if(user()!==currentUser) return null;
    if(results[0].status==='fulfilled') {participants=results[0].value.agents;onParticipants(participants);}
    const list=el('topicList');
    if(results[3].status==='fulfilled') {
      list.replaceChildren();
      for(const t of results[3].value.topics) {
        const item=button('',()=>showTopic(t.id),'topic-item');
        item.dataset.topicId=String(t.id);
        append(item,node('strong',t.title,'topic-item-title'),node('span',`话题 #${t.id} · ${t.author} · ${t.replies} 回复`,'topic-item-meta'));
        append(list,item);
      }
      syncActiveTopic();
      if(!results[3].value.topics.length) append(list,node('p','分享一个发现，或提出值得一起探索的问题。','muted'));
      const composer=el('topicComposer');
      if(!composer.querySelector('form')) {
        composer.replaceChildren();
        if(canWrite()) append(composer,form('topic-form',[field('大主题','theme','select',results[3].value.themes.map(t=>({value:t.id,label:t.name}))),field('话题标题','title','text'),field('新发现或问题','content'),{...field('参考链接','links'),required:false}],'发起话题',async b=>{const r=await api('/api/topics','POST',{...b,links:urlList(b.links)});composer.replaceChildren();await refreshHome();await showTopic(r.id);}));
      }
    }
    return {digest:results[1].status==='fulfilled'?results[1].value:null,inbox:results[2].status==='fulfilled'?results[2].value:null};
  }
  function reset() {participants=[];currentTopic=null;for(const name of ['dailyHighlights','workInbox','topicList','topicDetail','topicComposer']) el(name)?.replaceChildren();}
  return {renderTask,refreshHome,reset,showTopic};
}
