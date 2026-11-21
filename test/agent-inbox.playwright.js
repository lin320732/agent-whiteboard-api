async page => {
  await page.unrouteAll({ behavior: 'wait' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const at = new Date(Date.now() - 5000).toISOString();
  const old = new Date(Date.now() - 3600000).toISOString();
  const agents = [
    {id:7,name:'只扫任务池 Agent',username:'task-only',active:1,last_seen_at:at,last_inbox_at:null,pending_directives:1,completed_directives:0,unfetched_directives:1,oldest_unfetched_directive_at:at,inbox_overdue:false,inbox_timeout_seconds:1800},
    {id:8,name:'已取信 Agent',username:'fetched',active:1,last_seen_at:at,last_inbox_at:old,pending_directives:1,completed_directives:0,unfetched_directives:0,inbox_overdue:false,inbox_timeout_seconds:1800},
    {id:9,name:'新接入 Agent',username:'new',active:1,last_seen_at:null,last_inbox_at:null,pending_directives:0,completed_directives:0,unfetched_directives:0,inbox_overdue:false,inbox_timeout_seconds:1800},
    {id:10,name:'已停用 Agent',username:'disabled',active:0,last_seen_at:old,last_inbox_at:null,pending_directives:1,completed_directives:0,unfetched_directives:1,inbox_overdue:false,inbox_timeout_seconds:1800},
  ].map(a=>({...a,kind:'agent',role:'agent',quota:null}));
  let failDirectives = false;
  let fetched = false;
  let role = 'admin';
  const json = (data,status=200) => ({status,contentType:'application/json',body:JSON.stringify({ok:true,...data})});
  await page.route('**/api/**',route=>{
    const path = route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if(path==='/api/auth/me') return route.fulfill(json({user:{id:1,name:'Owner',kind:'human',role}}));
    if(path==='/api/admin/users') return route.fulfill(json({accounts:[]}));
    if(path==='/api/admin/agents') return route.fulfill(json({accounts:agents}));
    if(path==='/api/admin/agents/7/directives') {
      if(failDirectives) {
        failDirectives=false;
        return route.fulfill(json({ok:false,error:'临时读取失败'},503));
      }
      const a=agents[0];
      return route.fulfill(json({
        counts:{pending:1,completed:0,total:1},
        inbox_status:{last_inbox_at:a.last_inbox_at,unfetched_directives:a.unfetched_directives,oldest_unfetched_directive_at:a.oldest_unfetched_directive_at,inbox_overdue:a.inbox_overdue,inbox_timeout_seconds:1800},
        directives:[{id:3,agent_id:7,author_name:'Owner',content:'请整理一份完整报告并提交成果链接。',status:'pending',created_at:old,fetched_at:fetched?at:null}],
        has_more:false,next_cursor:null,
      }));
    }
    return route.fulfill(json({channels:[],tasks:[],messages:[],accounts:[],agents:[],items:[],waiting:[],directives:[],leaderboard:[],quota:null,history:[],visits:[],files:[],next_cursor:null}));
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:8765/');
  const home=page.locator('#homeAgentQuotaList');
  const overdue=home.locator('[data-agent-id="7"]');
  await overdue.locator('.agent-inbox-status').waitFor();
  await page.waitForURL('**/#home');
  await page.waitForFunction(()=>!document.querySelector('#workspace').hasAttribute('aria-busy'));
  Object.assign(agents[0],{oldest_unfetched_directive_at:old,inbox_overdue:true});
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await overdue.locator('.agent-inbox-warning').waitFor();
  if(!await overdue.locator('.agent-inbox-last').textContent().then(s=>s.includes('暂无成功取信记录'))) throw Error('Task-only traffic was displayed as a mailbox fetch');
  for(const id of [8,9,10]) {
    if(await home.locator(`[data-agent-id="${id}"] .agent-inbox-warning`).count()) throw Error(`Unexpected warning for Agent ${id}`);
  }
  if(await home.locator('[data-agent-id="8"] .agent-inbox-last time').getAttribute('datetime')!==old) throw Error('Last successful fetch timestamp was lost');
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('Workbench inbox status overflows on mobile');
  await home.screenshot({path:'.playwright-cli/agent-inbox-home-mobile.png'});
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#workspaceMenu > summary').click();
  await page.locator('#accountsMenu').click();
  const account=page.locator('#agents [data-agent-account-id="7"]');
  await account.locator('.agent-inbox-warning').waitFor();
  await account.locator('.agent-directive-btn').click();
  const modal=page.locator('#agentDetailModal');
  await modal.locator('.agent-inbox-warning').waitFor();
  await modal.locator('.agent-directive-receipt').getByText('待取信',{exact:true}).waitFor();
  await modal.screenshot({path:'.playwright-cli/agent-inbox-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('Inbox status overflows on mobile');
  await modal.screenshot({path:'.playwright-cli/agent-inbox-mobile.png'});
  failDirectives=true;
  await modal.getByRole('button',{name:'刷新留言',exact:true}).click();
  await modal.getByText('留言记录读取失败：临时读取失败',{exact:true}).waitFor();
  if(!await modal.locator('.agent-inbox-warning').isVisible()) throw Error('A failed refresh cleared the overdue warning');
  fetched=true;
  Object.assign(agents[0],{last_inbox_at:at,unfetched_directives:0,oldest_unfetched_directive_at:null,inbox_overdue:false});
  await modal.getByRole('button',{name:'刷新留言',exact:true}).click();
  await modal.locator('.agent-directive-receipt').getByText('已取信 · 待回馈',{exact:true}).waitFor();
  if(await modal.locator('.agent-inbox-warning').count()) throw Error('Successful fetch did not clear the warning');
  if(await modal.locator('.agent-inbox-last time').getAttribute('datetime')!==at) throw Error('Detail did not refresh last inbox time');
  if(await account.locator('.agent-inbox-warning').count()) throw Error('Detail refresh did not update account status');
  if(await overdue.locator('.agent-inbox-warning').count()) throw Error('Detail refresh did not update workbench status');
  if(!await modal.locator('.agent-directive-badge.is-pending').first().textContent().then(s=>s.includes('1'))) throw Error('Fetching incorrectly completed the directive');
  await page.keyboard.press('Escape');
  role='viewer';
  await page.goto('about:blank');
  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#viewHome').waitFor({state:'visible'});
  if(await page.locator('#homeAgentQuotaPanel').isVisible()) throw Error('Viewer can see private Agent mailbox status');
  if(errors.length) throw Error(errors.join('\n'));
  return {taskOnlyAlert:true,backgroundRefreshOnEmptyBoard:true,fetchedPendingNotOverdue:true,refreshFailurePreservesWarning:true,detailRefreshUpdatesAllSurfaces:true,mobileOverflow:false,viewerIsolated:true};
}
