async page => {
  let role='admin',version='v1',instructions='目前的优先事项 <img src=x>',reject=true;
  const posted=[];
  const guide=()=>({ok:true,version,instructions,markdown:'# 工作指南\n'+instructions,bootstrap:'每轮先读取 /api/agent-guide，再按最新版行动。',updated_at:null});
  const respond=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.guideCopied=text;}}});});
  await page.route('**/api/**',route=>{
    const r=route.request(),path=r.url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    if(path==='/api/auth/me') return respond(route,{user:{id:1,name:'Owner',kind:'human',role}});
    if(path==='/api/agent-guide') return respond(route,guide());
    if(path==='/api/admin/agent-guide') {
      const b=JSON.parse(r.postData());posted.push(b);
      if(reject){reject=false;version='v2';instructions='另一位管理员已调整优先事项';return respond(route,{error:'指南已更新，请先读取最新版'},409);}
      if(b.version!==version) return respond(route,{error:'版本不符'},409);
      version='v3';instructions=b.instructions;return respond(route,guide());
    }
    const data={tasks:[],channels:[],messages:[],leaderboard:[],accounts:[],agents:[],items:[],waiting:[],topics:[],themes:[],highlights:[],decisions:[]};
    return respond(route,data);
  });
  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#agentGuide').getByText('目前的优先事项 <img src=x>',{exact:true}).waitFor({timeout:3000});
  if(await page.locator('#agentGuide img').count()) throw Error('指南被当作 HTML 执行');
  await page.locator('#agentGuide').getByRole('button',{name:'复制接入指令'}).click();
  if(!(await page.evaluate(()=>window.guideCopied)).includes('/api/agent-guide')) throw Error('没有复制固定入口');
  const editor=page.locator('#agentGuide').getByLabel('目前工作指示');
  await editor.fill('先处理已接单工作，再讨论新题目');
  await page.locator('#refresh').click();
  await page.waitForTimeout(100);
  if(await editor.inputValue()!=='先处理已接单工作，再讨论新题目') throw Error('刷新丢失草稿');
  await page.locator('#agentGuide').getByRole('button',{name:'发布工作指示',exact:true}).click();
  await page.locator('#agentGuide [role=alert]').getByText('指南已更新，请先读取最新版',{exact:true}).waitFor();
  if(await editor.inputValue()!=='先处理已接单工作，再讨论新题目') throw Error('发布失败丢失草稿');
  await page.locator('#agentGuide').getByRole('button',{name:'读取最新指南',exact:true}).click();
  await page.locator('#agentGuide').getByText('另一位管理员已调整优先事项',{exact:true}).waitFor();
  await page.locator('#agentGuide').getByRole('button',{name:'保留草稿并使用最新版'}).click();
  await page.locator('#agentGuide').getByRole('button',{name:'发布工作指示',exact:true}).click();
  await page.locator('#agentGuide .guide-current').getByText('先处理已接单工作，再讨论新题目',{exact:true}).waitFor();
  if(posted[1]?.version!=='v2') throw Error('没有明确使用最新版本发布');
  role='viewer';await page.reload();await page.locator('#agentGuide .guide-current').waitFor();
  if(await page.locator('#agentGuide form').count()) throw Error('只读成员看到编辑入口');
  await page.locator('#agentGuide summary').getByText('查看完整指南',{exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw Error('手机横向溢出');
  return {copy:true,safeText:true,refreshDraft:true,conflictDraft:true,publish:true,viewer:true,mobile:true};
}
