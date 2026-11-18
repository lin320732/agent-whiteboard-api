async page => {
  await page.unrouteAll({behavior:'wait'});
  const at=new Date(Date.now()-5000).toISOString(), cutoff=new Date(Date.now()-30*86400000).toISOString();
  let visits=Array.from({length:55},(_,i)=>({id:100-i,visited_at:new Date(Date.parse(at)-i*1000).toISOString()}));
  const agents=[{id:7,name:'Muse One',username:'muse-one',kind:'agent',role:'agent',active:1,last_seen_at:at,visit_count_30d:55},
    {id:8,name:'New Muse',username:'muse-two',kind:'agent',role:'agent',active:1,last_seen_at:null,visit_count_30d:0},
    {id:9,name:'Disabled Muse',username:'muse-three',kind:'agent',role:'agent',active:0,last_seen_at:at,visit_count_30d:1}];
  let reads=0, failOlder=true, failRefresh=false;
  const json=(data,status=200)=>({status,contentType:'application/json',body:JSON.stringify(data)});
  await page.route('**/api/**',route=>{
    const request=route.request(),path=request.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    if(path==='/api/auth/me')return route.fulfill(json({user:{id:1,name:'Owner',role:'admin',kind:'human'}}));
    if(path==='/api/admin/users')return route.fulfill(json({accounts:[{id:1,name:'Owner',username:'owner',role:'admin',active:1}]}));
    if(path==='/api/admin/agents')return route.fulfill(json({accounts:agents}));
    if(path==='/api/admin/agents/7/visits'){
      reads++;
      const older=request.url().includes('before=');
      if(older&&failOlder){failOlder=false;return route.fulfill(json({error:'临时读取失败'},503));}
      if(!older&&failRefresh){failRefresh=false;return route.fulfill(json({error:'暂时不可用'},503));}
      const records=older?visits.slice(50):visits.slice(0,50);
      return route.fulfill(json({agent_id:7,retention_days:30,timezone:'Asia/Shanghai',cutoff_at:cutoff,total_requests:older?null:visits.length,visits:records,next_cursor:older?null:records.at(-1).visited_at+','+records.at(-1).id}));
    }
    if(path==='/api/admin/agents/8/visits')return route.fulfill(json({agent_id:8,cutoff_at:cutoff,visits:[],next_cursor:null}));
    if(path==='/api/admin/agents/9/visits')return route.fulfill(json({agent_id:9,cutoff_at:cutoff,visits:[{id:2,visited_at:at}],next_cursor:null}));
    if(path==='/api/auth/logout')return route.fulfill(json({ok:true}));
    return route.fulfill(json({channels:[],tasks:[],messages:[],leaderboard:[],accounts:[],agents:[],items:[],waiting:[],topics:[],themes:[],highlights:[],decisions:[],contributions:[],markdown:'',version:'v1'}));
  });
  await page.setViewportSize({width:1440,height:1100});
  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#workspaceMenu > summary').click();await page.locator('#accountsMenu').click();
  const first=page.locator('.agent-visit-history[data-agent-id="7"]');
  await first.waitFor();
  if(reads)throw Error('History loaded before expansion');
  const expected=await page.evaluate(value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}),at);
  if(!(await first.locator('..').locator('.agent-presence').textContent()).includes(expected))throw Error('Recent arrival uses the wrong timezone');
  await first.locator(':scope > summary').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-agent-id="7"] .agent-visit-list li').length===50);
  if(await first.locator('time').first().getAttribute('datetime')!==at)throw Error('Original arrival timestamp lost');
  await first.getByRole('button',{name:'查看更早记录'}).click();
  await first.getByText('到访时间读取失败：临时读取失败',{exact:false}).waitFor();
  if(await first.locator('li').count()!==50)throw Error('Paging failure discarded loaded records');
  await first.getByRole('button',{name:'查看更早记录'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-agent-id="7"] .agent-visit-list li').length===55);
  if(await first.getByRole('button',{name:'查看更早记录'}).isVisible())throw Error('No-more-records state is wrong');
  const beforeRefresh=reads;
  await page.locator('#refresh').click();
  await first.getByText('已显示 55 条到访时间（近 30 天共 55 次访问请求）。',{exact:true}).waitFor();
  if(!await first.evaluate(element=>element.open)||await first.locator('li').count()!==55||reads!==beforeRefresh)throw Error('Account refresh lost the expanded history or loaded pages');
  agents[0].last_seen_at=new Date(Date.parse(at)+1000).toISOString();agents[0].visit_count_30d++;
  visits=[{id:101,visited_at:agents[0].last_seen_at},...visits];
  await page.locator('#refresh').click();
  await first.getByText('有新的到访，点击“刷新记录”查看。',{exact:true}).waitFor();
  failRefresh=true;
  await first.getByRole('button',{name:'刷新记录'}).click();
  await first.getByText('到访时间读取失败：暂时不可用',{exact:false}).waitFor();
  await page.locator('#refresh').click();
  await first.getByText('到访时间读取失败：暂时不可用',{exact:false}).waitFor();
  await first.getByRole('button',{name:'刷新记录'}).click();
  await first.getByText('已显示 50 条到访时间',{exact:false}).waitFor();
  if(await first.locator('time').first().getAttribute('datetime')!==agents[0].last_seen_at)throw Error('Refresh missed a newer arrival');
  const empty=page.locator('[data-agent-id="8"]');
  if((await empty.locator('..').locator('.agent-presence').textContent())!=='近 '+30+' 天无到访记录')throw Error('Empty arrival statistics are incorrect');
  await empty.locator(':scope > summary').click();
  await empty.getByText('近 30 天没有已记录的到访。',{exact:true}).waitFor();
  const disabled=page.locator('[data-agent-id="9"]');await disabled.locator(':scope > summary').click();await disabled.locator('time').waitFor();
  await page.locator('#adminPanel').screenshot({path:'.playwright-cli/agent-visits-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await first.scrollIntoViewIfNeeded();
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Visit history overflows on mobile');
  await first.screenshot({path:'.playwright-cli/agent-visits-mobile.png'});
  return {lazyRead:true,beijingTime:true,pagination:55,failedReadPreservesRecords:true,retry:true,expandedStateAndPagesPreserved:true,newArrivalRefresh:true,emptyState:true,disabledHistory:true,mobileOverflow:false};
}
