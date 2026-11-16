async page => {
  let role='admin', issueState='open', enabled=false, outcome=null, submissions=[], rejectOutcome=true;
  const json=data=>({status:200,contentType:'application/json',body:JSON.stringify(data)});
  const task={id:1,title:'主持协作测试',type:'research',status:'review',claimed_by:'Worker',result_summary:'原始材料'};
  const workflow=()=>({enabled,host_id:2,host:'Host',acceptance:'官方来源对照',min_sources:1,fingerprint:'test-fingerprint',author_ids:[2,3],blocking:issueState==='resolved'?0:1,issues:[{id:1,text:'日期需要修正',severity:'blocking',state:issueState,revision:0,author:'Checker',response:issueState==='open'?'':'已修正日期'}],subtasks:[{id:1,title:'核实日期',deliverable:'官方日期链接',assignee:'Worker',assignee_id:3,state:'assigned',ack_overdue:true,due_at:'2030-01-01T00:00:00Z'}],outcomes:outcome?[outcome]:[],reviews:[],current_reviews:[]});
  await page.route('**/api/**',async route=>{
    const r=route.request(),path=r.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    if(path==='/api/auth/me') return route.fulfill(json({user:{id:role==='agent'?4:1,name:'测试用户',role,kind:role==='agent'?'agent':'human'}}));
    if(path==='/api/tasks/1'&&r.method()==='GET') return route.fulfill(json({task,workflow:workflow(),debate:[],verify_readiness:{ready:false,checks:[]}}));
    if(path==='/api/tasks') return route.fulfill(json({tasks:[task]}));
    if(path==='/api/channels') return route.fulfill(json({channels:[]}));
    if(path==='/api/messages') return route.fulfill(json({messages:[]}));
    if(path==='/api/leaderboard') return route.fulfill(json({leaderboard:[]}));
    if(path==='/api/admin/users'||path==='/api/admin/agents') return route.fulfill(json({accounts:[]}));
    if(path==='/api/participants') return route.fulfill(json({agents:[{id:2,name:'Host'},{id:3,name:'Worker'},{id:4,name:'Checker'}]}));
    if(path==='/api/inbox') return route.fulfill(json({items:[{task_id:1,kind:'issue',title:task.title,reason:'日期需要修正'}],waiting:[]}));
    if(path==='/api/digest') return route.fulfill(json({day:'2026-11-16',highlights:[{task_id:1,title:'成果更新',text:'核实日期',kind:'outcome'}],decisions:[{task_id:1,title:task.title,status:'review'}]}));
    if(path==='/api/topics'&&r.method()==='GET') return route.fulfill(json({themes:[{id:'tech',name:'科技与市场'},{id:'tools',name:'工具与优惠'},{id:'food',name:'美食与生活'}],topics:[{id:1,theme:'tools',author:'Host',title:'工具发现 <img src=x>',content:'试做报告工具',replies:1}]}));
    if(path==='/api/topics/1') return route.fulfill(json({topic:{id:1,title:'工具发现 <img src=x>',author:'Host',content:'试做报告工具'},replies:[{id:1,author:'Worker',content:'可以先做小样',reply_to:null}],proposals:[]}));
    if(path==='/api/tasks/1/contributions'&&r.method()==='GET') return route.fulfill(json({contributions:[]}));
    if(r.method()==='POST') {
      const b=JSON.parse(r.postData()); submissions.push({path,body:b});
      if(path==='/api/tasks/1/workflow') enabled=true;
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
  await page.locator('#dailyHighlights').getByText('成果更新').waitFor({timeout:3000});
  await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail summary').getByText('设置主持与验收',{exact:true}).click();
  const setup=page.locator('#taskDetail .host-setup');
  await setup.getByLabel('主持 Agent').selectOption('2');
  await setup.getByLabel('验收要求').fill('官方来源对照');
  await setup.getByRole('button',{name:'启用主持流程'}).click();
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
  await page.locator('.current-outcome').getByText('已核实的最新结论', {exact:false}).waitFor();
  if(await page.locator('.current-outcome script').count()) throw Error('成果不是安全文本');
  const issue=page.locator('.work-issue').first();
  await issue.getByLabel('回应与修改').fill('已修正日期');
  await issue.getByRole('button',{name:'提交回应'}).click();
  await page.locator('.work-issue').getByText('已修正日期',{exact:true}).waitFor();
  if(!await page.locator('.subtask-form').count()) throw Error('主持人不能安排子任务');
  await page.locator('#topicList button').first().click();
  await page.locator('#topicDetail').getByText('可以先做小样',{exact:true}).waitFor();
  await page.locator('#topicDetail .topic-reply-form').getByLabel('回复内容').fill('一起验证可行性');
  await page.locator('#topicDetail .topic-reply-form').getByRole('button',{name:'发送回复'}).click();
  await page.locator('#topicDetail summary').getByText('把发现整理为任务提案').click();
  await page.locator('#topicDetail .proposal-form').getByLabel('任务标题').fill('工具试做');
  await page.locator('#topicDetail .proposal-form').getByLabel('任务说明').fill('利用现有服务器');
  await page.locator('#topicDetail .proposal-form').getByLabel('预期交付').fill('一份演示');
  await page.locator('#topicDetail .proposal-form').getByLabel('为什么值得做').fill('节省整理时间');
  await page.locator('#topicDetail .proposal-form').getByRole('button',{name:'提交任务提案'}).click();
  await page.waitForTimeout(100);
  if(!submissions.some(s=>s.path==='/api/topics/1/propose')) throw Error('未提交提案');
  role='agent';await page.reload();await page.locator('#taskList .task-item').first().click();
  await page.locator('.review-form').getByLabel('核查说明').fill('已逐项对照官方来源');
  await page.locator('.review-form').getByLabel('查证链接').fill('https://example.com/report');
  await page.locator('.review-form').getByRole('button',{name:'提交独立核查'}).click();
  await page.waitForTimeout(100);
  if(!submissions.some(s=>s.path.endsWith('/reviews')&&s.body.fingerprint==='test-fingerprint')) throw Error('核查未绑定当前版本');
  role='viewer';await page.reload();await page.locator('#taskList .task-item').first().click();await page.locator('.current-outcome').waitFor();
  if(await page.locator('.host-setup,.outcome-form,.subtask-form,.review-form,.issue-form').count()) throw Error('只读用户看到写入入口');
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('移动版溢出');
  return {hostSetup:'passed',outcomes:'passed',issueResponse:'passed',topics:'passed',proposal:'passed',review:'passed',viewer:'passed',mobile:'passed'};
}
