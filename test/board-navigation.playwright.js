async page => {
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1280, height: 900 });
  const json = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  const report = revision => ({ url: `https://example.com/report-${revision}`, title: '发布报告', revision });
  const plan = { goal: 'content', collaboration: 'open', acceptance: { criteria: '可读即可', min_sources: 0, independent_review: false, opposing_views: false }, schedule: { kind: 'once' }, delivery: { format: 'web_report' }, configured: true, revision: 1 };
  const tasks = [
    { id: 1, channel_id: 1, title: '已整理的报告', status: 'review', plan, report: report('v2'), result_summary: '最初提交的材料', result_links: 'https://example.com/withdrawn-source', claimed_by: 'Writer' },
    { id: 2, channel_id: 2, title: '等待开始的任务', status: 'open' },
    { id: 3, channel_id: 1, title: '直接提交的文字成果', status: 'done', plan: { ...plan, delivery: { format: 'text' } }, result_summary: '已经完成的简短文字', claimed_by: 'Writer' },
  ];
  const base = { enabled: true, host_id: null, author_ids: [3], outcomes: [], reviews: [], current_reviews: [], issues: [], subtasks: [], fingerprint: 'current', blocking: 0 };
  const detail = id => ({
    task: tasks.find(task => task.id === id), debate: [], challenges: [], supplements: [],
    verify_readiness: { ready: id !== 2, checks: [] },
    ...(id === 1 ? { workflow: { ...base, plan, outcomes: [
      { id: 2, author: 'Writer', summary: '目前采用的结论', links: '', report: report('v2'), changes: '移除了过时来源' },
      { id: 1, author: 'Writer', summary: '第一版结论', links: 'https://example.com/first-source', report: report('v1'), changes: '最初发布' },
    ] } } : id === 3 ? { workflow: { ...base, plan: tasks[2].plan } } : {}),
  });
  const messageScopes = [];
  let holdFirst = false, releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  await page.route('**/api/**', async route => {
    const [path, query = ''] = route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?');
    const params = Object.fromEntries(query.split('&').filter(Boolean).map(pair => pair.split('=').map(decodeURIComponent)));
    if (path === '/api/auth/me') return route.fulfill(json({ user: { id: 1, name: '管理员', role: 'admin' } }));
    if (path === '/api/channels') return route.fulfill(json({ channels: [{ id: 1, name: '成果频道' }, { id: 2, name: '待办频道' }] }));
    if (path === '/api/tasks') {
      const status = params.status, channel = params.channelId;
      return route.fulfill(json({ tasks: tasks.filter(task => (!status || task.status === status) && (!channel || task.channel_id === Number(channel))) }));
    }
    const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
    if (taskMatch) {
      const id = Number(taskMatch[1]);
      if (id === 1 && holdFirst) {
        holdFirst = false;
        await new Promise(resolve => { releaseFirst = resolve; markFirstStarted(); });
      }
      return route.fulfill(json(detail(id)));
    }
    if (path.endsWith('/contributions')) return route.fulfill(json({ contributions: [] }));
    if (path === '/api/messages') {messageScopes.push(params.channelId || ''); return route.fulfill(json({ messages: [] }));}
    if (path === '/api/leaderboard') return route.fulfill(json({ leaderboard: [] }));
    if (path === '/api/participants') return route.fulfill(json({ agents: [] }));
    if (path === '/api/inbox') return route.fulfill(json({ items: [], waiting: [] }));
    if (path === '/api/digest') return route.fulfill(json({ highlights: [{ topic_id: 1, title: '值得继续的话题', text: '查看引用与讨论' }], decisions: [] }));
    if (path === '/api/topics') return route.fulfill(json({ themes: [], topics: [{ id: 1, title: '值得继续的话题', author: 'Writer', replies: 0 }] }));
    if (path === '/api/topics/1') return route.fulfill(json({ topic: { id: 1, title: '值得继续的话题', author: 'Writer', content: '讨论正文' }, replies: [], proposals: [] }));
    if (path === '/api/agent-guide') return route.fulfill(json({ version: 'v1', instructions: '', markdown: '', bootstrap: '' }));
    if (path === '/api/admin/users' || path === '/api/admin/agents') return route.fulfill(json({ accounts: [] }));
    if (path === '/api/link-preview') return route.fulfill(json({ ok: false }));
    return route.fulfill({ status: 404, body: `unmocked ${path}` });
  });
  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#navTasks').click();
  const item = title => page.locator('#taskList .task-item').filter({ hasText: title });
  const title = text => page.locator('#taskDetail h3').filter({ hasText: text });
  await item(tasks[0].title).click();
  await title(tasks[0].title).waitFor();
  await page.locator('#taskDetail').getByRole('tab',{name:'成果',exact:true}).click();
  const current = page.locator('#taskDetail .current-outcome');
  if (await current.locator('.outcome-links a[href="https://example.com/withdrawn-source"]').count()) throw Error('当前成果混入已移除的原始来源');
  if (await current.getByText('待独立核查', { exact: true }).count()) throw Error('未要求独立核查的报告被标为待核查');
  await current.getByText('原始提交与来源', { exact: true }).click();
  if (!await current.getByText('最初提交的材料', { exact: true }).isVisible()) throw Error('无法按需查看原始提交');

  await page.locator('#statusFilter').selectOption('open');
  await page.waitForFunction(() => document.querySelectorAll('#taskList .task-item').length === 1);
  if (await page.locator('#taskDetail h3').count()) throw Error('筛选后仍显示旧任务详情');
  await page.locator('#navOutcomes').click();
  await page.locator('#outcomeListReview .outcome-item').click();
  await page.locator('#outcomeDetail h3').filter({ hasText: tasks[0].title }).waitFor();
  const history = page.locator('#outcomeDetail details').filter({ has: page.getByText('历史成果（1）', { exact: true }) });
  await history.locator(':scope > summary').click();
  if (!await history.locator('a[href="https://example.com/report-v1"]').isVisible()) throw Error('成果历史缺少对应版本的报告');
  await page.locator('#outcomeDetail').getByRole('button', { name: '打开任务详情' }).click();
  await title(tasks[0].title).waitFor();
  if (await page.locator('#statusFilter').inputValue()) throw Error('跨页打开任务没有清理冲突的筛选');
  await page.locator('#refresh').click();
  await title(tasks[0].title).waitFor();
  if (!await item(tasks[0].title).getAttribute('aria-pressed').then(value => value === 'true')) throw Error('刷新后从成果打开的任务失去选中状态');

  await page.locator('#channelList').getByRole('button', { name: '待办频道', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#taskList .task-item').length === 1);
  if (await page.locator('#taskDetail h3').count()) throw Error('切换频道后仍显示其他频道的详情');
  await page.locator('#navOutcomes').click();
  await page.locator('#outcomeListReview .outcome-item').click();
  await page.locator('#outcomeDetail').getByRole('button', {name: '打开任务详情'}).click();
  await title(tasks[0].title).waitFor();
  const readsBeforeCommunity = messageScopes.length;
  await page.locator('#navCommunity').click();
  await page.waitForFunction(() => document.querySelector('#messageScope').textContent === '全部频道');
  if (messageScopes.length <= readsBeforeCommunity || messageScopes.at(-1) !== '') throw Error('跨页清理筛选后，频道讨论仍保留旧范围');
  await page.locator('#navTasks').click();
  await page.locator('#channelList').getByRole('button', { name: '全部频道', exact: true }).click();
  await item(tasks[2].title).click();
  await title(tasks[2].title).waitFor();
  if (await page.locator('#taskDetail .current-outcome').getByText('旧版提交', { exact: true }).count()) throw Error('新安排下的文字交付被错误标为旧版提交');

  await page.locator('#navCommunity').click();
  await page.locator('#topicList').getByRole('button', { name: /值得继续的话题/ }).click();
  await page.locator('#topicDetail h3').waitFor();
  if (!await page.locator('#viewCommunity').isVisible()) throw Error('今日重点的话题没有打开交流视图');
  await page.locator('#navHome').click();
  await page.locator('#refresh').click();
  if (!await page.locator('#viewHome').isVisible()) throw Error('刷新后台详情抢走了当前视图');

  await page.locator('#navTasks').click();
  holdFirst = true;
  await item(tasks[0].title).click();
  await firstStarted;
  await item(tasks[2].title).click();
  await title(tasks[2].title).waitFor();
  const staleResponse = page.waitForResponse(response => response.url().endsWith('/api/tasks/1'));
  releaseFirst();
  await staleResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await page.locator('#taskDetail h3').first().textContent() !== tasks[2].title) throw Error('较慢的旧请求覆盖了新选中的任务');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#navTasks').click();
  await page.locator('#statusFilter').selectOption('open');
  await page.locator('#navOutcomes').click();
  await page.locator('#outcomeListReview .outcome-item').click();
  await page.locator('#outcomeDetail').getByRole('button', { name: '打开任务详情' }).click();
  await title(tasks[0].title).waitFor();
  const position = await page.locator('#detailTitle').boundingBox();
  if (!position || position.y < -2 || position.y >= 844) throw Error('手机从成果打开任务后没有定位到阅读区');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('手机导航产生横向溢出');
  return { currentSources: 'passed', originalSubmission: 'passed', historicalReports: 'passed', filters: 'passed', crossView: 'passed', requestOrder: 'passed', mobileReader: 'passed' };
}
