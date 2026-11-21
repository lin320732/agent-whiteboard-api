async page => {
  await page.unrouteAll({ behavior: 'wait' });
  const errors = [], calls = [], resources = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => resources.push(request.url()));
  const json = value => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  let releaseApp, releaseAgents, releaseGuide, releaseMessages, releaseUsers;
  const appGate = new Promise(resolve => { releaseApp = resolve; });
  const agentsGate = new Promise(resolve => { releaseAgents = resolve; });
  const guideGate = new Promise(resolve => { releaseGuide = resolve; });
  const messagesGate = new Promise(resolve => { releaseMessages = resolve; });
  const usersGate = new Promise(resolve => { releaseUsers = resolve; });
  const task = { id: 1, title: '首页优先显示的提案', status: 'proposed', created_by: 'Agent A' };
  const agents = [{ id: 7, name: 'Agent A', username: 'agent-a', kind: 'agent', role: 'agent', active: 1 }];
  await page.route('**/assets/app-*.js', async route => { await appGate; await route.continue(); });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    calls.push(path);
    if (path === '/api/auth/me') return route.fulfill(json({ user: { id: 1, name: 'Owner', role: 'admin' } }));
    if (path === '/api/tasks') return route.fulfill(json({ tasks: [task], decisions: [] }));
    if (path === '/api/admin/agents') { await agentsGate; return route.fulfill(json({ accounts: agents })); }
    if (path === '/api/participants') return route.fulfill(json({ agents }));
    if (path === '/api/channels') return route.fulfill(json({ channels: [{ id: 1, name: '慢网测试' }] }));
    if (path === '/api/messages') { await messagesGate; return route.fulfill(json({ messages: [{ author: 'Agent A', role: 'agent', text: '按需加载的留言' }] })); }
    if (path === '/api/admin/users') { await usersGate; return route.fulfill(json({ accounts: [] })); }
    if (path === '/api/agent-guide') {
      await guideGate;
      return route.fulfill(json({ version: 'test-version', instructions: '按需加载的指示', markdown: '# 按需加载的指南', bootstrap: '指南入口' }));
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `unexpected ${path}` }) });
  });
  try {
    const sessionResponse = page.waitForResponse(response => response.url().endsWith('/api/auth/me'));
    await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
    // Session checking starts even while the application bundle is stalled.
    await sessionResponse;
    if (calls.includes('/api/tasks')) throw Error('任务请求不应在应用代码加载前执行');
    releaseApp();
    await page.waitForURL('**/#home');
    await page.locator('#decisionList').getByText(task.title, { exact: true }).waitFor();
    if (await page.locator('#workspace').evaluate(element => element.inert)) throw Error('慢速额度请求锁住了首页');
    if (await page.locator('#viewHome').getAttribute('aria-busy') === 'true') throw Error('首页仍被次要数据标记为不可读');
    for (const path of ['/api/channels', '/api/participants', '/api/digest', '/api/messages', '/api/agent-guide', '/api/admin/users']) {
      if (calls.includes(path)) throw Error(`首页提前读取了 ${path}`);
    }
    if (resources.some(url => /\/(?:reading|agent-guide|files-ui|floor-refs|collaboration)-[A-Z0-9]+\.js/.test(url))) throw Error('首页预先下载了可选功能代码');
    await page.locator('#navTasks').click();
    await page.locator('#taskList').getByText(task.title, { exact: true }).waitFor();

    // A guide request may remain pending while the user keeps navigating.
    await page.locator('#workspaceMenu > summary').click();
    await Promise.all([page.waitForRequest('**/api/agent-guide'), page.locator('#workspaceMenu [data-settings="guide"]').click()]);
    await page.locator('#navHome').click();
    if (!await page.locator('#decisionList').getByText(task.title, { exact: true }).isVisible()) throw Error('指南请求阻塞了导航');
    releaseGuide();
    await page.locator('#agentGuide .guide-current').waitFor({ state: 'attached' });

    // Discussion and account data start only when their pages open.
    await Promise.all([page.waitForRequest('**/api/messages'), page.locator('#navCommunity').click()]);
    await page.locator('#channelList').getByText('慢网测试', { exact: true }).waitFor();
    await page.locator('#navHome').click();
    releaseMessages();
    await page.locator('#messages').getByText('按需加载的留言', { exact: true }).waitFor({ state: 'attached' });
    await page.locator('#workspaceMenu > summary').click();
    await Promise.all([page.waitForRequest('**/api/admin/users'), page.locator('#accountsMenu').click()]);
    if (calls.filter(path => path === '/api/admin/agents').length !== 1) throw Error('并发读取没有复用 Agent 列表请求');
    await page.locator('#navHome').click();
    releaseAgents(); releaseUsers();
    await page.locator('.home-agent-card[data-agent-id="7"]').waitFor();
    await page.locator('#agents .account-item').waitFor({ state: 'attached' });
    if (errors.length) throw Error(errors.join('\n'));
    return { sessionBeforeApp: true, homeBeforeSecondary: true, optionalDataOnDemand: true, navigationDuringLoading: true };
  } finally {
    releaseApp(); releaseAgents(); releaseGuide(); releaseMessages(); releaseUsers();
  }
}
