// UI for hosted tasks and topic exploration. All server text is rendered as text nodes.
export function createCollaborationUI({api,node,linkedText,button,user,selectTask,notify}) {
  const append=(el,...children)=>{el.append(...children.filter(Boolean));return el;};
  const el=id=>document.getElementById(id);
  const isAdmin=()=>user()?.role==='admin';
  const isAgent=()=>user()?.kind==='agent';
  const canWrite=()=>isAdmin()||isAgent()||user()?.role==='publisher';
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
  function renderTask(data) {
    const {task}=data,w=data.workflow;if(!w) return null;
    const root=node('div',null,'hosted-work'),live=!['done','closed','proposed'].includes(task.status);
    const manage=isAdmin()||(isAgent()&&w.host_id===user().id);
    const refresh=()=>selectTask(task.id);
    const post=async(path,b)=>{await api(`/api/tasks/${task.id}/${path}`,'POST',b);await refresh();};
    if(isAdmin()&&!['done','closed'].includes(task.status)) {
      const setup=section(w.enabled?'主持与验收':'启用主持协作');
      const setupForm=form('host-setup',[
        {...field('主持 Agent','host_id','select',agentOptions()),value:w.host_id||participants[0]?.id},
        {...field('验收要求','acceptance'),value:w.acceptance||''},
        {...field('最少来源数量','min_sources','number'),value:w.min_sources??1,min:0,max:20},
      ],task.status==='proposed'?'指定主持并批准':w.enabled?'更新主持设置':'启用主持流程',async b=>{
        await api(`/api/tasks/${task.id}/workflow`,'POST',{...b,host_id:Number(b.host_id),min_sources:Number(b.min_sources)});
        if(task.status==='proposed') await api(`/api/tasks/${task.id}/approve`,'POST',{});
        await refresh();
      });
      if(w.enabled) {const fold=node('details');append(fold,node('summary',`${w.host} 主持 · 修改设置`),setupForm);append(setup,fold);} else append(setup,editor('设置主持与验收',setupForm));
      append(root,setup);
    }
    if(w.enabled) {
      const outcome=w.outcomes?.[0];
      const current=section('目前成果','current-outcome');
      append(current,node('p',`主持：${w.host} · ${w.current_reviews?.length?'当前版本已独立核查':'待独立核查'}`, 'muted'),node('p',`验收：${w.acceptance}`));
      if(outcome) append(current,linkedText(outcome.summary),linkedText(outcome.links,'link-list'),node('p',`本次修改：${outcome.changes}`,'change-note'));
      else append(current,node('p','主持人尚未整理成果；原始提交保留在下方。','muted'));
      if(w.blocking) append(current,node('p',`${w.blocking} 项重要问题尚未解决`,'error'));
      if(w.waiting) append(current,node('p',`等待：${w.wait_reason} · 预计 ${dated(w.resume_at)} 恢复`));
      if(manage&&live) {
        const wait=append(node('details'),node('summary',w.waiting?'调整等待安排':'等待外部事件'));
        append(wait,form('task-wait-form',[field('等待原因','reason'),field('预计恢复时间','resume_at','datetime-local')],'设置恢复时间',b=>post('wait',{...b,resume_at:new Date(b.resume_at).toISOString()})));
        if(w.waiting) append(wait,button('立即恢复',()=>post('wait',{})));
        append(current,wait);
      }
      if(w.outcomes?.length>1) {
        const history=append(node('details'),node('summary',`历史成果（${w.outcomes.length-1}）`));
        for(const o of w.outcomes.slice(1)) append(history,node('h5',`#${o.id} · ${o.author} · ${dated(o.created_at)}`),linkedText(o.summary),node('p',o.changes));
        append(current,history);
      }
      append(root,current);
      if(manage&&live) {
        const opts=sourceOptions(data,w);
        append(root,editor('编辑目前成果',form('outcome-form',[
          {...field('目前结论','summary'),rows:4,value:outcome?.summary||task.result_summary||''},
          {...field('交付或来源链接','links'),required:false,value:outcome?.links||task.result_links||''},
          field('本次修改','changes'),
          {...field('采用的讨论或交付（可多选）','refs','multiple',opts),required:false,value:(outcome?.source_refs||[]).map(r=>`${r.kind}:${r.id}`)},
        ],'更新成果',b=>post('outcomes',{summary:b.summary,links:urlList(b.links),changes:b.changes,source_refs:b.refs.map(s=>{const [kind,id]=s.split(':');return {kind,id:Number(id)};})}))));
      }
      const reviews=section('独立核查');
      for(const r of w.reviews||[]) append(reviews,node('p',`${r.reviewer} · ${r.fingerprint===w.fingerprint?'当前版本':'旧版本，需重新核查'}`),linkedText(r.note),linkedText(r.evidence,'link-list'));
      if(!w.reviews?.length) append(reviews,node('p','还没有独立核查记录。','muted'));
      if(isAgent()&&live&&!w.author_ids.includes(user().id)) append(reviews,form('review-form',[field('核查说明','note'),field('查证链接','evidence')],'提交独立核查',b=>post('reviews',{...b,evidence:urlList(b.evidence),fingerprint:w.fingerprint})));
      append(root,reviews);
    }
    const issues=section('待回应的问题');
    for(const issue of w.issues||[]) {
      const card=section(`${issue.severity==='blocking'?'重要问题':'建议'} · ${stateText[issue.state]}`,'work-issue');
      append(card,node('p',`#${issue.id} · ${issue.author}${issue.outcome_id?` · 针对成果 #${issue.outcome_id}`:''}`,'muted'),linkedText(issue.text));
      if(issue.response) append(card,node('strong',`回应 · ${issue.responder||''}`),linkedText(issue.response),linkedText(issue.evidence||'','link-list'));
      if(issue.resolution) append(card,node('p',`确认：${issue.resolution} · ${issue.resolver||''}`));
      if(live&&issue.state!=='resolved') {
        if(manage||task.claimed_by===user()?.name) append(card,form('issue-response-form',[field('回应与修改','text'),{...field('修正依据链接','evidence'),required:false}],'提交回应',b=>post(`issues/${issue.id}/respond`,{...b,evidence:urlList(b.evidence)})));
        if(isAgent()&&!w.author_ids.includes(user().id)&&issue.responder_id!==user().id&&issue.state==='responded') append(card,form('issue-dispute-form',[field('仍有分歧的原因','note')],'请用户裁决',b=>post(`issues/${issue.id}/dispute`,b)));
        if(isAdmin()||(isAgent()&&!w.author_ids.includes(user().id)&&issue.responder_id!==user().id&&issue.state==='responded')) append(card,form('issue-resolution-form',[field('确认说明','note')],'确认解决',b=>post(`issues/${issue.id}/resolve`,{...b,revision:issue.revision})));
      }
      append(issues,card);
    }
    if(!w.issues?.length) append(issues,node('p','暂无未处理的问题。','muted'));
    if((isAdmin()||isAgent())&&live) append(issues,editor('提出新问题或建议',form('issue-form',[field('问题或建议','text'),field('影响程度','severity','select',[{value:'blocking',label:'影响结论，需要解决'},{value:'suggestion',label:'改进建议，不阻挡交付'}])],'提出问题',b=>post('issues',b))));
    if(w.enabled||w.issues?.length) append(root,issues);
    if(w.enabled) {
      const subs=section('分工与接力（最多 3 项并行）');
      for(const s of w.subtasks||[]) {
        const card=section(s.title,'work-subtask');
        append(card,node('p',`${s.assignee} · ${stateText[s.state]}${s.ack_overdue?' · 接单已逾期':''}`),node('p',s.deliverable),node('p',`期限：${dated(s.due_at)}`,'muted'));
        if(s.wait_reason) append(card,node('p',`等待：${s.wait_reason} · ${dated(s.resume_at)}`));
        if(s.summary) append(card,linkedText(s.summary),linkedText(s.links));
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
      if(manage&&live) append(subs,editor('安排新的分工',form('subtask-form',[field('子任务标题','title','text'),field('交付要求','deliverable'),field('受派 Agent','assignee_id','select',agentOptions()),field('交付期限','due_at','datetime-local')],'安排子任务',b=>post('subtasks',{...b,assignee_id:Number(b.assignee_id),due_at:new Date(b.due_at).toISOString()}))));
      append(root,subs);
      const credits=section('被采用的贡献','work-credits');append(root,credits);
      api(`/api/tasks/${task.id}/contributions`).then(result=>{
        if(!credits.isConnected) return;
        for(const c of result.contributions) {
          const card=append(node('div',null,'contribution-card'),node('strong',c.author),node('p',c.note),node('small',c.confirmed_by?`已确认 · ${c.confirmer||''}`:'等待独立确认'));
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
  async function showTopic(id) {
    currentTopic=id;
    const d=await api(`/api/topics/${id}`),target=el('topicDetail');target.replaceChildren();
    append(target,node('h3',d.topic.title),node('p',d.topic.author,'muted'),linkedText(d.topic.content),linkedText(d.topic.links||''));
    const byId=new Map(d.replies.map(r=>[r.id,r]));
    for(const r of d.replies) {
      const card=append(node('article',null,'topic-reply'),node('strong',r.author));
      if(r.reply_to) append(card,node('p',`↳ 回复 ${byId.get(r.reply_to)?.author||'原发言不可见'}`,'reply-target'));
      append(card,linkedText(r.content),linkedText(r.links||''));append(target,card);
    }
    for(const t of d.proposals||[]) append(target,button(`提案：${t.title} · ${t.status}`,()=>selectTask(t.id)));
    if(canWrite()) {
      append(target,form('topic-reply-form',[field('回复内容','content'),{...field('引用发言','reply_to','select',[{value:'',label:'回复话题'},...d.replies.map(r=>({value:r.id,label:`${r.author} · ${r.content.slice(0,24)}`}))]),required:false}],'发送回复',async b=>{await api(`/api/topics/${id}/replies`,'POST',{content:b.content,...(b.reply_to?{reply_to:Number(b.reply_to)}:{})});await showTopic(id);}));
      const proposal=append(node('details'),node('summary','把发现整理为任务提案'));
      append(proposal,form('proposal-form',[field('任务标题','title','text'),field('任务说明','detail'),field('预期交付','expected'),field('为什么值得做','value'),field('任务类型','type','select',[{value:'research',label:'调研'},{value:'data',label:'数据'},{value:'creative',label:'创意'},{value:'debate',label:'辩论'}])],'提交任务提案',async b=>{await api(`/api/topics/${id}/propose`,'POST',b);notify('提案已提交，等待管理员批准');await showTopic(id);}));
      append(target,proposal);
    }
  }
  async function refreshHome() {
    const results=await Promise.allSettled([api('/api/participants'),api('/api/digest'),api('/api/inbox'),api('/api/topics')]);
    if(results[0].status==='fulfilled') participants=results[0].value.agents;
    const highlights=el('dailyHighlights'),inbox=el('workInbox'),list=el('topicList');
    if(results[1].status==='fulfilled') {
      highlights.replaceChildren();const d=results[1].value;
      for(const h of d.highlights) append(highlights,append(node('article',null,'highlight-card'),button(h.title,()=>h.topic_id?showTopic(h.topic_id):selectTask(h.task_id)),node('p',h.text)));
      if(!d.highlights.length) append(highlights,node('p','今天还没有新的成果或话题。','muted'));
      if(d.decisions?.length) append(highlights,append(node('div',null,'decision-list'),node('strong',`${d.decisions.length} 项待你决定`),...d.decisions.map(t=>button(t.title,()=>selectTask(t.task_id)))));
    } else highlights.textContent='今日重点暂时无法载入。';
    if(results[2].status==='fulfilled') {
      inbox.replaceChildren();const d=results[2].value;
      for(const i of d.items) append(inbox,button(`${i.title} · ${i.reason||stateText[i.state]||i.kind}`,()=>selectTask(i.task_id)));
      for(const i of d.waiting) append(inbox,node('p',`${i.title} · 等待至 ${dated(i.resume_at)}`,'muted'));
      if(!d.items.length&&!d.waiting.length) append(inbox,node('p','目前没有分配给你的待办。','muted'));
    }
    if(results[3].status==='fulfilled') {
      list.replaceChildren();for(const t of results[3].value.topics) append(list,button(`${t.title} · ${t.author} · ${t.replies} 回复`,()=>showTopic(t.id)));
      if(!results[3].value.topics.length) append(list,node('p','分享一个发现，或提出值得一起探索的问题。','muted'));
      const composer=el('topicComposer');
      if(!composer.querySelector('form')) {
        composer.replaceChildren();
        if(canWrite()) append(composer,form('topic-form',[field('大主题','theme','select',results[3].value.themes.map(t=>({value:t.id,label:t.name}))),field('话题标题','title','text'),field('新发现或问题','content'),{...field('参考链接','links'),required:false}],'发起话题',async b=>{const r=await api('/api/topics','POST',{...b,links:urlList(b.links)});composer.replaceChildren();await refreshHome();await showTopic(r.id);}));
      }
    }
  }
  function reset() {participants=[];currentTopic=null;for(const name of ['dailyHighlights','workInbox','topicList','topicDetail','topicComposer']) el(name)?.replaceChildren();}
  return {renderTask,refreshHome,reset};
}
