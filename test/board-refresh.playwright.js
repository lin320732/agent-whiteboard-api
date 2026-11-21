async page => {
  await page.unrouteAll({behavior:'wait'});
  await page.setViewportSize({width:1440,height:1000});
  await page.clock.install();
  const paths = [];
  let version = 1;
  const task = () => ({id:1,title:version===1?'议题一':'议题一已更新',status:'open',created_by:'Owner'});
  const json = (body, headers = {}) => ({status:200,contentType:'application/json',headers,body:JSON.stringify(body)});
  await page.route('**/api/**', route => {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, '');
    paths.push(path);
    if (path === '/api/auth/me') return route.fulfill(json({user:{id:1,name:'Owner',role:'admin'}}));
    if (path === '/api/tasks?view=summary') {
      const etag = '"' + version + '"';
      if (request.headers()['if-none-match'] === etag) return route.fulfill({status:304,headers:{etag}});
      return route.fulfill(json({tasks:[task()],decisions:[]},{etag}));
    }
    if (path === '/api/tasks/1') return route.fulfill(json({
      task:{...task(),detail:'任务背景'},
      debate:[{id:1,agent:'发言者',role:'agent',stance:'支持',content:version===1?'第一次讨论内容':'更新后的完整讨论'}],
    }));
    return route.fulfill(json({channels:[],messages:[],agents:[],accounts:[],highlights:[],decisions:[],markdown:'工作指南'}));
  });
  await page.goto('http://127.0.0.1:8765/');
  await page.waitForURL('**/#home');
  if (paths.includes('/api/inbox') || paths.includes('/api/tasks/1') || paths.includes('/api/tasks')) throw Error('打开工作台时读取了任务详情或重型列表');
  const tick = async status => {
    const start = paths.length;
    await Promise.all([
      page.waitForResponse(res => res.url().includes('/api/tasks?view=summary') && res.status() === status),
      page.clock.fastForward(120_000),
    ]);
    const calls = paths.slice(start);
    const expected = ['/api/tasks?view=summary'];
    if (page.url().endsWith('#home')) expected.push('/api/admin/agents');
    if (calls.length !== expected.length || calls.some(path=>!expected.includes(path))) throw Error('后台刷新调用与当前可见状态不符：' + calls.join(','));
  };
  await tick(304);
  await page.locator('#navTasks').click();
  await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail').getByRole('tab',{name:/^讨论/}).click();
  await page.getByText('第一次讨论内容',{exact:true}).waitFor();
  const draft = page.locator('#debateForm textarea[name="content"]');
  await draft.fill('这是一段未提交的草稿');
  version = 2;
  await tick(200);
  await page.locator('#taskList').getByText('议题一已更新',{exact:true}).waitFor();
  if (await draft.inputValue() !== '这是一段未提交的草稿') throw Error('后台刷新覆盖了详情草稿');
  if (!await page.getByText('第一次讨论内容',{exact:true}).isVisible()) throw Error('后台刷新重载了讨论');
  await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail').getByRole('tab',{name:/^讨论/}).click();
  await page.getByText('更新后的完整讨论',{exact:true}).waitFor();
  return {unchangedPoll:304,changedPoll:200,detailLoads:paths.filter(path=>path==='/api/tasks/1').length};
}
