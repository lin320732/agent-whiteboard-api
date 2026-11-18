async page => {
  await page.unrouteAll({behavior:'wait'});
  let globalText='全体的优先事项：先处理已接单工作', personal='Host 专属：每轮先核对照价表', agentScoped=null, lastPost=null;
  const guide=(kind)=>({ok:true,version:kind==='agent'?'p1':'g1',instructions:globalText,markdown:'# 工作指南\n\n'+globalText+(kind==='agent'?`\n\n## 管理员给你的工作指示\n\n${personal}`:''),
    agent_id:kind==='agent'?2:null,personal:kind==='agent'?{instructions:personal,revision:1,updated_at:null}:null,
    bootstrap:'每轮先读取 /api/agent-guide，再按最新版行动。',updated_at:null});
  const respond=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  await page.route('**/api/**',route=>{
    const r=route.request(),raw=r.url(),path=raw.replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    if(path==='/api/auth/me') return respond(route,{user:{id:1,name:'Owner',kind:'human',role:'admin'}});
    if(path==='/api/agent-guide') return respond(route,guide('global'));
    if(path==='/api/admin/agents') return respond(route,{accounts:[{id:2,username:'host',name:'Host',kind:'agent'},{id:3,username:'worker',name:'Worker',kind:'agent'}]});
    if(path==='/api/admin/agent-guide') {
      if(r.method()==='GET') return respond(route,guide(/[?&]agent_id=\d+/.test(raw)?'agent':'global'));
      lastPost=JSON.parse(r.postData());
      if(lastPost.agent_id){agentScoped=lastPost.agent_id;personal=lastPost.instructions;return respond(route,guide('agent'));}
      globalText=lastPost.instructions;return respond(route,guide('global'));
    }
    const data={tasks:[],channels:[],messages:[],leaderboard:[],accounts:[],agents:[],items:[],waiting:[],topics:[],themes:[],highlights:[],decisions:[]};
    return respond(route,data);
  });
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#workspaceMenu > summary').click();
  await page.locator('#workspaceMenu [data-settings="guide"]').click();
  await page.locator('#agentGuide .guide-current').getByText(globalText,{exact:true}).waitFor({timeout:3000});
  const scope=page.locator('#agentGuide').getByLabel('套用到');
  if((await scope.locator('option').count())!==3) throw Error('范围选项应包含全体与两位 Agent');
  const editor=page.locator('#agentGuide').getByLabel('目前工作指示');
  if((await editor.inputValue())!==globalText) throw Error('全体范围应载入共用指示');

  await scope.selectOption('2');
  await page.locator('#agentGuide .guide-current').getByText(personal,{exact:true}).waitFor({timeout:3000});
  await page.locator('#agentGuide .guide-current').getByText(globalText,{exact:true}).waitFor();
  if((await editor.inputValue())!==personal) throw Error('切换范围后应载入该 Agent 的专属指示');

  await editor.fill('Host 专属：先交核对表，再回 inbox');
  await page.locator('#agentGuide').getByRole('button',{name:'发布工作指示',exact:true}).click();
  await page.locator('#agentGuide .guide-current').getByText('Host 专属：先交核对表，再回 inbox',{exact:true}).waitFor({timeout:3000});
  if(lastPost?.agent_id!==2) throw Error('发布专属指示必须带 agent_id');
  if(!String(agentScoped)) throw Error('没有写入专属范围');

  await scope.selectOption('');
  await page.locator('#agentGuide .guide-current').getByText(globalText,{exact:true}).waitFor();
  if((await editor.inputValue())!==globalText) throw Error('回到全体范围应载入共用指示，不能串到个人指示');
  if(await page.locator('#agentGuide .guide-current').getByText('先交核对表',{exact:false}).count()) throw Error('全体范围不应显示个人指示');

  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('手机横向溢出');
  if(errors.length) throw Error(errors[0]);
  return {scopeOptions:3,switchLoads:true,personalVisible:true,sharedStillShown:true,publishScoped:true,backToGlobal:true,mobile:true};
}
