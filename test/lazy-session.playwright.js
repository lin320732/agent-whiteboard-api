async page => {
  await page.unrouteAll({ behavior: 'wait' });
  const json = (value, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(value) });
  let releaseAgents, markAgents;
  const agentsPending = new Promise(resolve => { releaseAgents = resolve; });
  const agentsStarted = new Promise(resolve => { markAgents = resolve; });
  await page.route('**/api/**', async route => {
    const path = route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path === '/api/auth/me') return route.fulfill(json({ user: { id: 1, name: 'Owner', role: 'admin' } }));
    if (path === '/api/auth/logout') return route.fulfill(json({ ok: true }));
    if (path === '/api/auth/login') return route.fulfill(json({ user: { id: 2, name: 'New Viewer', role: 'viewer' } }));
    if (path === '/api/tasks') return route.fulfill(json({ tasks: [{ id: 1, title: '当前账号可读的任务', status: 'open' }], decisions: [] }));
    if (path === '/api/admin/agents') {
      markAgents();
      await agentsPending;
      return route.fulfill(json({ error: '旧会话已过期' }, 401));
    }
    return route.fulfill(json({}));
  });
  try {
    await page.goto('http://127.0.0.1:8765/');
    await page.waitForURL('**/#home');
    await agentsStarted;
    await page.locator('#logout').click();
    await page.locator('#loginForm').waitFor({ state: 'visible' });
    await page.locator('#loginForm input[name="username"]').fill('viewer');
    await page.locator('#loginForm input[name="password"]').fill('test-password');
    await page.locator('#loginForm button[type="submit"]').click();
    await page.locator('#signedInAs').getByText('New Viewer · 只读成员', { exact: true }).waitFor();
    await page.locator('#workInbox').getByText('当前账号可读的任务', { exact: true }).waitFor();
    const lateResponse = page.waitForResponse(response => response.url().endsWith('/api/admin/agents') && response.status() === 401);
    releaseAgents();
    await lateResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (await page.locator('#loginView').isVisible()) throw Error('旧账号的延迟 401 注销了新账号');
    if (await page.locator('#homeAgentQuotaPanel').isVisible()) throw Error('新账号看到了旧管理员的额度概览');
    if (await page.locator('#workspace').evaluate(element => element.inert)) throw Error('旧请求遗留了全局操作锁');
    return { oldRequestsDoNotLogOutNewUser: true, adminDataCleared: true };
  } finally { releaseAgents(); }
}
