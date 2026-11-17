async page => {
  await page.unrouteAll({behavior:'wait'});
  let role='admin',revision='v1',planRevision=1,rejectPublish=true,posts=[];
  let plan={goal:'analysis',collaboration:'hosted',acceptance:{criteria:'结论有据，网页可读',min_sources:1,independent_review:true,opposing_views:false},schedule:{kind:'once',start_at:null},delivery:{format:'web_report',author_id:3},revision:planRevision,configured:true};
  const reportUrl='https://report.example.test/market';
  const task={id:1,title:'MUSE 市场报告',status:'review',type:'data',claimed_by:'Writer',created_by:'Owner',plan};
  const report=()=>({url:reportUrl,title:'市场报告 <img src=x>',revision,published_at:'2026-11-17T09:00:00Z'});
  const outcome=()=>({id:revision==='v1'?1:2,author_id:3,author:'Writer',summary:'市场变化与风险说明',links:'https://source.example.test/official',changes:`发布 ${revision}`,source_refs:[],report:report()});
  const workflow=()=>({enabled:true,plan,host_id:2,host:'Host',report_author_id:3,report_author:'Writer',acceptance:plan.acceptance.criteria,min_sources:plan.acceptance.min_sources,fingerprint:`fp-${revision}-${planRevision}`,author_ids:[2,3],blocking:0,issues:[],subtasks:[],outcomes:[outcome()],reviews:[],current_reviews:[]});
  const json=data=>({status:200,contentType:'application/json',body:JSON.stringify(data)});
  await page.context().route('https://report.example.test/**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><h1>已发布的市场报告</h1><p>当前发布版本 ${revision}</p>`}));
  await page.route('**/api/**',async route=>{
    const r=route.request(),path=r.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    if(r.method()==='POST') {
      const b=JSON.parse(r.postData());posts.push({path,body:b});
      if(path==='/api/tasks/1/plan') {plan={...plan,...b,revision:++planRevision};task.plan=plan;}
      if(path==='/api/tasks/1/outcomes') {
        if(rejectPublish) {rejectPublish=false;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'请确认发布版本后重试'})});}
        revision=b.report.revision;
      }
      return route.fulfill(json({ok:true,id:2}));
    }
    if(path==='/api/auth/me') return route.fulfill(json({user:{id:role==='writer'?3:role==='checker'?4:1,role:role==='admin'?'admin':'agent',kind:role==='admin'?'human':'agent',name:role==='writer'?'Writer':role==='checker'?'Checker':'Owner'}}));
    if(path==='/api/tasks') return route.fulfill(json({tasks:[task]}));
    if(path==='/api/tasks/1') return route.fulfill(json({task,plan,workflow:workflow(),debate:[],verify_readiness:{ready:false,checks:[]}}));
    if(path==='/api/participants') return route.fulfill(json({agents:[{id:2,name:'Host'},{id:3,name:'Writer'},{id:4,name:'Checker'}]}));
    if(path==='/api/channels') return route.fulfill(json({channels:[]}));
    if(path==='/api/messages') return route.fulfill(json({messages:[]}));
    if(path==='/api/leaderboard') return route.fulfill(json({leaderboard:[]}));
    if(path==='/api/admin/users'||path==='/api/admin/agents') return route.fulfill(json({accounts:[]}));
    if(path==='/api/inbox') return route.fulfill(json({items:[],waiting:[]}));
    if(path==='/api/digest') return route.fulfill(json({highlights:[],decisions:[]}));
    if(path==='/api/topics') return route.fulfill(json({themes:[],topics:[]}));
    if(path.endsWith('/contributions')) return route.fulfill(json({contributions:[]}));
    if(path==='/api/link-preview') return route.fulfill(json({ok:false}));
    return route.fulfill(json({ok:true}));
  });
  await page.goto('http://127.0.0.1:8765/');
  const create=page.locator('#taskForm');
  await create.getByLabel('任务目标',{exact:true}).selectOption('content');
  if(await create.getByLabel('需要独立核查',{exact:true}).isChecked()) throw Error('创作模板默认值错误');
  await create.getByLabel('需要独立核查',{exact:true}).check();
  await create.getByLabel('任务目标',{exact:true}).selectOption('build');
  if(!await create.getByLabel('需要独立核查',{exact:true}).isChecked()) throw Error('切换目标重置了自定义验收');
  await create.getByLabel('执行方式',{exact:true}).selectOption('event');
  await create.getByLabel('触发条件',{exact:true}).fill('官方公告发布');
  if(!await create.getByLabel('触发条件',{exact:true}).isVisible()||await create.getByLabel('每隔多少天执行').isVisible()) throw Error('执行安排条件字段错误');
  await page.locator('#taskList .task-item').first().click();
  const published=page.locator('.current-outcome .published-report');
  await published.waitFor();
  if(await published.locator('img').count()) throw Error('报告标题被当成 HTML');
  const popupPromise=page.waitForEvent('popup');await published.click();const popup=await popupPromise;
  await popup.getByRole('heading',{name:'已发布的市场报告'}).waitFor();await popup.close();
  await page.locator('.task-arrangements summary').click();
  const settings=page.locator('.plan-settings');
  if(await settings.getByLabel('主要作者（可选）',{exact:true}).inputValue()!=='3') throw Error('未保留指定的报告作者');
  await settings.getByLabel('最少来源数量',{exact:true}).fill('3');
  await settings.getByLabel('任务目标',{exact:true}).selectOption('content');
  if(await settings.getByLabel('最少来源数量',{exact:true}).inputValue()!=='3') throw Error('修改任务目标覆盖了验收要求');
  await settings.getByRole('button',{name:'保存任务安排'}).click();
  await page.locator('.task-arrangements').getByText('内容创作 · 主持分工 · 一次性',{exact:true}).waitFor();
  if(!posts.some(p=>p.path.endsWith('/plan')&&p.body.acceptance.min_sources===3&&p.body.delivery.author_id===3)) throw Error('任务安排未独立保存');
  role='writer';await page.reload();await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail summary').getByText('编辑目前成果',{exact:true}).click();
  const composer=page.locator('.outcome-form');
  await composer.getByLabel('报告发布版本（填写新版本）',{exact:true}).fill('v2');
  await composer.getByLabel('本次修改',{exact:true}).fill('修正图表单位并补充风险');
  await composer.getByRole('button',{name:'更新成果'}).click();
  await composer.getByText('请确认发布版本后重试').waitFor();
  if(await composer.getByLabel('报告发布版本（填写新版本）',{exact:true}).inputValue()!=='v2') throw Error('报告发布失败后草稿丢失');
  await composer.getByRole('button',{name:'更新成果'}).click();
  await page.locator('.published-report').filter({hasText:'v2'}).waitFor();
  role='checker';await page.reload();await page.locator('#taskList .task-item').first().click();
  const check=page.locator('.review-form');
  await check.getByLabel('核查说明',{exact:true}).fill('已实际打开 v2，对照来源，核实图表单位与页面展示');
  await check.getByRole('button',{name:'提交独立核查'}).click();
  await page.waitForFunction(()=>!document.querySelector('.review-form button')?.disabled);
  if(!posts.some(p=>p.path.endsWith('/reviews')&&p.body.report_revision==='v2'&&p.body.fingerprint.startsWith('fp-v2')&&p.body.evidence.includes(reportUrl))) throw Error('报告核查没有绑定发布版本及链接');
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('移动页面横向溢出');
  await page.screenshot({path:'.playwright-cli/task-plans-mobile.png',fullPage:true});
  return {goals:'passed',acceptance:'passed',schedules:'passed',publishedReport:'passed',author:'passed',revision:'passed',review:'passed',mobile:'passed'};
}
