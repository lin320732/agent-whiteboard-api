async page => {
  await page.unrouteAll({behavior:'wait'});
  await page.setViewportSize({width:1280,height:900});
  let role='admin', issueState='open', enabled=false, hostId=null, outcome=null, submissions=[], rejectOutcome=true;
  const json=data=>({status:200,contentType:'application/json',body:JSON.stringify(data)});
  const task={id:1,title:'主持协作测试',type:'research',status:'review',claimed_by:'Worker',result_summary:'原始材料'};
  const plan=()=>({goal:'research',collaboration:enabled?'hosted':'open',acceptance:{criteria:'官方来源对照',min_sources:1,independent_review:true,opposing_views:false},schedule:{kind:'once',start_at:null},delivery:{format:'text',author_id:null},revision:enabled?1:0,configured:enabled});
  const workflow=()=>({enabled,plan:plan(),host_id:hostId,host:hostId?'Host':'',acceptance:'官方来源对照',min_sources:1,fingerprint:'test-fingerprint',author_ids:[2,3],blocking:issueState==='resolved'?0:1,issues:[{id:1,text:'日期需要修正',severity:'blocking',state:issueState,revision:0,author:'Checker',response:issueState==='open'?'':'已修正日期'}],subtasks:enabled?[{id:1,title:'核实日期',deliverable:'官方日期链接',assignee:'Worker',assignee_id:3,state:'assigned',ack_overdue:true,due_at:'2030-01-01T00:00:00Z'}]:[],outcomes:outcome?[outcome]:[],reviews:[],current_reviews:[]});
  await page.route('**/api/**',async route=>{
    const r=route.request(),path=r.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    if(path==='/api/auth/me') return route.fulfill(json({user:{id:role==='agent'?4:1,name:'测试用户',role,kind:role==='agent'?'agent':'human'}}));
    if(path==='/api/tasks/1'&&r.method()==='GET') return route.fulfill(json({task,plan:plan(),workflow:workflow(),debate:[],verify_readiness:{ready:false,checks:[]}}));
    if(path==='/api/tasks') return route.fulfill(json({tasks:[task]}));
    if(path==='/api/channels') return route.fulfill(json({channels:[{id:1,name:'白板反馈',topic:'记录使用问题'}]}));
    if(path==='/api/messages'&&r.method()==='GET') return route.fulfill(json({messages:[{id:1,channel_id:1,author:'Worker',role:'agent',text:'白板工作正常'}]}));
    if(path==='/api/admin/users'||path==='/api/admin/agents') return route.fulfill(json({accounts:[]}));
    if(path==='/api/participants') return route.fulfill(json({agents:[{id:2,name:'Host'},{id:3,name:'Worker'},{id:4,name:'Checker'}]}));
    if(path==='/api/inbox') return route.fulfill(json({items:[{task_id:1,kind:'issue',title:task.title,reason:'日期需要修正'}],waiting:[]}));
    if(path==='/api/digest') return route.fulfill(json({day:'2026-11-16',highlights:[{task_id:1,title:'成果更新',text:'核实日期',kind:'outcome'}],decisions:[{task_id:1,title:task.title,status:'review'}]}));
    if(r.method()==='POST') {
      const b=JSON.parse(r.postData()); submissions.push({path,body:b});
      if(path==='/api/tasks/1/plan') {enabled=true;if(b.host_id) hostId=b.host_id;}
      if(path==='/api/tasks/1/outcomes') {
        if(rejectOutcome){rejectOutcome=false;return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'请补充证据'})});}
        outcome={id:1,author:'Host',summary:b.summary,links:b.links.join('\n'),changes:b.changes,source_refs:[]};
      }
      if(path.endsWith('/respond')) issueState='responded';
      if(path.endsWith('/resolve')) issueState='resolved';
      return route.fulfill(json({ok:true,id:2,status:'proposed'}));
    }
    return route.fulfill({status:404,body:'missing fixture'});
  });
  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#dailyHighlights').getByText(task.title,{exact:true}).waitFor({timeout:3000});
  await page.locator('.primary-nav').getByRole('tab',{name:'任务'}).click();
  await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail .arrangements-fold > summary').click();
  // 未启用主持前不显示空子任务表单，也没有重复的 host-setup 表单
  if(await page.locator('.host-setup,.subtask-form,.work-credits').count()) throw Error('仍存在重复的主持表单、无主持子任务表单或已下线的贡献区');
  await page.locator('#taskDetail summary').getByText('修改任务设置（目标、验收、主持与排程）',{exact:true}).click();
  const setup=page.locator('#taskDetail .plan-settings');
  await setup.locator('.plan-advanced > summary').click();
  await setup.getByLabel('协作方式',{exact:true}).selectOption('hosted');
  await setup.getByLabel('主持 Agent',{exact:true}).selectOption('2');
  await setup.getByLabel('验收说明',{exact:true}).fill('官方来源对照');
  await setup.getByRole('button',{name:'保存任务设置'}).click();
  await page.locator('#taskDetail summary').getByText('安排新的分工',{exact:true}).waitFor();
  if(!await page.locator('#taskDetail .subtask-form').count()) throw Error('启用主持后未出现子任务表单');
  await page.locator('#taskDetail').getByRole('tab',{name:'成果',exact:true}).click();
  await page.locator('#taskDetail .current-outcome').waitFor();
  await page.locator('#taskDetail summary').getByText('编辑目前成果',{exact:true}).click();
  const composer=page.locator('#taskDetail .outcome-form');
  await composer.getByLabel('目前结论').fill('已核实的最新结论 <script>坏内容</script>');
  await composer.getByLabel('交付或来源链接').fill('https://example.com/report');
  await composer.getByLabel('本次修改').fill('修正日期');
  await composer.getByRole('button',{name:'更新成果'}).click();
  await composer.getByText('请补充证据').waitFor();
  if(!(await composer.getByLabel('目前结论').inputValue()).includes('最新结论')) throw Error('错误后草稿丢失');
  await composer.getByRole('button',{name:'更新成果'}).click();
  await page.locator('#detailPanel-outcome .current-outcome').getByText('已核实的最新结论', {exact:false}).waitFor();
  if(await page.locator('.current-outcome script').count()) throw Error('成果不是安全文本');
  await page.locator('#taskDetail').getByRole('tab',{name:/^核查/}).click();
  const issue=page.locator('.work-issue').first();
  await issue.getByLabel('回应与修改').fill('已修正日期');
  await issue.getByRole('button',{name:'提交回应'}).click();
  await page.locator('.work-issue').getByText('已修正日期',{exact:true}).waitFor();
  await page.locator('.primary-nav').getByRole('tab',{name:'讨论区'}).click();
  await page.locator('#messages').getByText('白板工作正常',{exact:true}).waitFor();
  await page.locator('#messageForm textarea[name="text"]').fill('记一条新的白板观察');
  await page.locator('#messageForm').getByRole('button',{name:'发送'}).click();
  await page.waitForTimeout(100);
  if(!submissions.some(s=>s.path==='/api/messages'&&s.body.text==='记一条新的白板观察')) throw Error('讨论区留言未发送');
  role='agent';await page.reload();await page.locator('#navTasks').click();await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail').getByRole('tab',{name:/^核查/}).click();
  await page.locator('.review-form').getByLabel('核查说明').fill('已逐项对照官方来源');
  await page.locator('.review-form').getByLabel('查证链接').fill('https://example.com/report');
  await page.locator('.review-form').getByRole('button',{name:'提交独立核查'}).click();
  await page.waitForTimeout(100);
  if(!submissions.some(s=>s.path.endsWith('/reviews')&&s.body.fingerprint==='test-fingerprint')) throw Error('核查未绑定当前版本');
  role='viewer';await page.reload();await page.locator('#navTasks').click();await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail').getByRole('tab',{name:'成果',exact:true}).click();await page.locator('.current-outcome').waitFor();
  if(await page.locator('.plan-settings,.outcome-form,.subtask-form,.review-form,.issue-form').count()) throw Error('只读用户看到写入入口');
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('移动版溢出');
  return {hostSetup:'passed',outcomes:'passed',issueResponse:'passed',discussion:'passed',review:'passed',viewer:'passed',mobile:'passed'};
}
