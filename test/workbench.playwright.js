async page => {
  await page.unrouteAll({behavior: 'wait'});
  const json = data => ({status: 200, contentType: 'application/json', body: JSON.stringify(data)});
  const errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  const report = {url: 'https://reports.example.test/final', title: '完整报告', revision: 'v2'};
  const summary = '结论：当前方案可行，但需要保留备用方案。\n\n' + '这是核实后的具体依据和适用条件。'.repeat(50) + '\n重要限制：仅适用于测试地区，其他地区需要重新核实。';
  const plan = {goal: 'analysis', collaboration: 'open', configured: true, revision: 1, acceptance: {criteria: '内容清楚且来源可靠', min_sources: 2, independent_review: true, opposing_views: false}, schedule: {kind: 'once'}, delivery: {format: 'web_report'}};
  const tasks = [
    {id: 1, title: '需要批准的提案', status: 'proposed', plan},
    {id: 2, title: '条件齐备的成果', status: 'review', plan, report, verify_readiness: {ready: true}},
    {id: 3, title: '仍在等待独立核查', status: 'review', plan, verify_readiness: {ready: false}, collaboration: {reason: '等待 Checker 核查当前版本'}},
    {id: 4, title: '需要用户裁决的分歧', status: 'in_progress', plan, verify_readiness: {ready: true}},
    {id: 5, title: '等待外部事件', status: 'open', plan, collaboration: {reason: '等待官方公告发布'}},
    {id: 6, title: '已完成的历史成果', status: 'done', result_summary: '历史结论仍可阅读。', result_links: 'https://example.com/history'},
    {id: 7, title: '已关闭的任务', status: 'closed'},
    ...Array.from({length: 30}, (_, index) => ({id: 20 + index, channel_id: 1, title: `手机待办 ${index + 1}`, status: 'open', claimed_by: 'Worker'})),
  ];
  let previews = 0, role = 'admin';
  const detail = id => {
    const task = tasks.find(task => task.id === id);
    return {task: {...task, detail: '任务目标和背景。'.repeat(100)}, debate: [], challenges: [], supplements: [], verify_readiness: {ready: id === 2, checks: [{key: 'independent', label: '独立核查', met: id === 2, detail: id === 2 ? '当前版本已核查' : '等待独立核查'}]},
      ...(id === 2 || id === 3 || id === 4 ? {workflow: {enabled: true, plan, fingerprint: 'fp-v2', host: 'Host', host_id: null, blocking: id === 4 ? 1 : 0, author_ids: [3], outcomes: [{id: 10, summary, author: 'Writer', links: 'https://example.com/source-a\nhttps://example.com/source-a\nhttps://example.com/source-b\n' + report.url, report, changes: '补充适用条件'}], reviews: [], current_reviews: id === 2 ? [{reviewer: 'Checker'}] : [], issues: id === 4 ? [{id: 1, state: 'disputed', severity: 'blocking', text: '两个来源的日期不一致', revision: 0}] : [], subtasks: []}} : {})};
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (request.method() === 'POST') {
      posts.push(path);
      if (path === '/api/tasks/2/verify') tasks.find(task => task.id === 2).status = 'done';
      return route.fulfill(json({ok: true}));
    }
    if (path === '/api/auth/me') return route.fulfill(json({user: {id: 1, name: 'Owner', role}}));
    if (path === '/api/tasks') return route.fulfill(json({tasks}));
    if (/^\/api\/tasks\/\d+$/.test(path)) return route.fulfill(json(detail(Number(path.split('/').pop()))));
    if (path === '/api/digest') return route.fulfill(json({highlights: [], decisions: [{task_id: 4, status: 'disputed'}, {task_id: 4, status: 'disputed'}, {task_id: 3, status: 'review'}]}));
    if (path === '/api/inbox') return route.fulfill(json({items: Array.from({length: 10}, () => ({task_id: 3, kind: 'host'})), waiting: []}));
    if (path === '/api/agent-guide') return route.fulfill(json({version: 'v1', instructions: '', markdown: '指南', bootstrap: '读取指南'}));
    if (path === '/api/link-preview') {previews++; return route.fulfill(json({ok: false}));}
    return route.fulfill(json({channels: [{id: 1, name: '测试频道'}], agents: [], accounts: [], contributions: [], topics: [], themes: [], messages: [], leaderboard: []}));
  });
  await page.setViewportSize({width: 1440, height: 1000});
  await page.goto('http://127.0.0.1:8765/');
  await page.waitForURL('**/#home');
  if (!await page.locator('#viewHome').isVisible()) throw Error('默认没有进入工作台');
  const queue = page.locator('#decisionList .workbench-item');
  if (await queue.count() !== 3) throw Error('待办混入未就绪任务或重复计算');
  const queueText = await queue.allTextContents();
  if (!queueText[0].includes(tasks[3].title) || !queueText[1].includes(tasks[1].title) || !queueText[2].includes(tasks[0].title)) throw Error('裁决、验收与提案未按优先次序排列');
  if (await page.locator('#dailyHighlights .workbench-item').count() !== 3) throw Error('首页没有展示最近成果');
  await page.screenshot({path: '.playwright-cli/workbench-desktop.png', fullPage: true});

  await queue.filter({hasText: tasks[1].title}).click();
  await page.locator('#detailPanel-review').waitFor();
  if (!await page.locator('#detailPanel-review .outcome-summary').isVisible()) throw Error('待验收入口缺少结论预览');
  if (!await page.getByRole('button', {name: '确认验收', exact: true}).isVisible()) throw Error('验收操作不可见');
  const tabs = await page.locator('#taskDetail .detail-tabs').boundingBox();
  if (!tabs || tabs.y > 600) throw Error('长说明把详情页签推到首屏之外');
  await page.locator('#taskDetail').getByRole('tab', {name: '成果', exact: true}).click();
  const result = page.locator('#detailPanel-outcome');
  const source = result.locator('.outcome-links');
  if (await source.getAttribute('open') !== null || await source.locator('a').first().isVisible()) throw Error('来源没有默认折叠');
  if (await source.locator('summary').textContent() !== '来源（2）') throw Error('来源没有去重或把报告当成了事实来源');
  if (!await result.locator('.published-report').isVisible()) throw Error('打开报告入口被折叠了');
  await source.locator('summary').click();
  if (await source.locator('a').count() !== 2 || !await source.locator('a').first().isVisible()) throw Error('折叠来源无法展开阅读');
  if (await source.locator('a').first().getAttribute('rel') !== 'noopener noreferrer') throw Error('来源外链缺少安全属性');
  const fullText = result.locator('.outcome-summary .text-fold');
  if (await fullText.locator('.full-text').isVisible()) throw Error('长正文没有默认折叠');
  await fullText.locator('summary').click();
  if (!await fullText.locator('.full-text').getByText('重要限制：仅适用于测试地区', {exact: false}).isVisible()) throw Error('折叠丢失了原始结果的重要信息');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#detailPanel-outcome .source-fold')?.open);
  if (!await fullText.locator('.full-text').isVisible()) throw Error('刷新丢失了展开状态');
  if (previews || await page.locator('.link-card').count()) throw Error('仍然请求或显示占位过大的预览卡');
  const columns = await page.locator('.task-column').boundingBox(), reader = await page.locator('.detail-column').boundingBox();
  if (!columns || !reader || columns.x + columns.width >= reader.x + 2) throw Error('PC 没有保留左列表右详情');
  await page.screenshot({path: '.playwright-cli/workbench-result-desktop.png', fullPage: true});

  // 手机列表、独立详情、筛选、滚动位置与浏览器前后退。
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#navTasks').click();
  if (await page.locator('.detail-column').isVisible()) throw Error('手机列表仍然叠着详情');
  if (await page.locator('#taskList').getByText('已完成的历史成果', {exact: true}).count()) throw Error('默认列表包含已结束任务');
  await page.locator('#taskSearch').fill('手机待办');
  const mobileItem = page.locator('#taskList .task-item').nth(20);
  await mobileItem.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => scrollY);
  const mobileTitle = await mobileItem.locator('strong').textContent();
  await mobileItem.click();
  await page.locator('#taskDetail h3').getByText(mobileTitle, {exact: true}).waitFor();
  if (await page.locator('.task-column').isVisible() || await page.locator('.board-toolbar').isVisible()) throw Error('手机详情前仍展示完整列表或筛选栏');
  if (!await page.locator('#detailPanel-overview').isVisible()) throw Error('任务入口没有先打开概览');
  if (await page.evaluate(() => scrollY) > 5) throw Error('进入手机详情没有回到顶部');
  await page.locator('#taskBack').click();
  await page.waitForFunction(() => !document.querySelector('#viewTasks').classList.contains('is-reading'));
  await page.waitForFunction(expected => Math.abs(scrollY - expected) < 8, before);
  if (await page.locator('#taskSearch').inputValue() !== '手机待办' || await page.locator('#statusFilter').inputValue() !== 'active') throw Error('返回丢失筛选');
  await page.goForward();
  await page.locator('#taskDetail h3').getByText(mobileTitle, {exact: true}).waitFor();
  if (!await page.locator('.detail-column').isVisible() || await page.locator('.task-column').isVisible()) throw Error('浏览器前进没有恢复独立详情');
  await page.screenshot({path: '.playwright-cli/workbench-task-mobile.png', fullPage: true});

  await page.locator('#navOutcomes').click();
  await page.locator('#outcomeListReview .outcome-item').filter({hasText: tasks[1].title}).click();
  await page.locator('#outcomeDetail h3').getByText(tasks[1].title, {exact: true}).waitFor();
  if (await page.locator('.outcome-index').isVisible()) throw Error('成果列表仍在手机阅读区上方');
  await page.locator('#outcomeDetail').getByRole('button', {name: '打开任务详情'}).click();
  await page.locator('#detailPanel-outcome').waitFor();
  await page.locator('#taskBack').click();
  await page.locator('#outcomeDetail h3').getByText(tasks[1].title, {exact: true}).waitFor();
  if (!await page.locator('#viewOutcomes').isVisible()) throw Error('任务详情没有返回原成果');

  await page.locator('#navHome').click();
  await page.locator('#decisionList .workbench-item').filter({hasText: tasks[1].title}).click();
  await page.getByRole('button', {name: '确认验收', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('#taskDetail .badge.done'));
  await page.locator('#taskBack').click();
  await page.locator('#viewHome').waitFor();
  if (!posts.includes('/api/tasks/2/verify') || await page.locator('#decisionList .workbench-item').count() !== 2) throw Error('验收后待办未更新');
  for (const id of ['navHome', 'navTasks', 'navOutcomes', 'navCommunity']) {
    await page.locator('#' + id).click();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('手机出现横向溢出');
  }
  await page.locator('#workspaceMenu > summary').click();
  await page.locator('#accountsMenu').click();
  if (!await page.locator('#adminPanel').isVisible() || await page.locator('#agentGuidePanel').isVisible()) throw Error('管理页又把多个模块堆到一起');
  await page.locator('#settings-guide').click();
  if (!await page.locator('#agentGuidePanel').isVisible() || await page.locator('#adminPanel').isVisible()) throw Error('工具分区没有切换');
  role = 'viewer'; await page.reload();
  await page.locator('#agentGuidePanel').waitFor();
  if (await page.locator('#settings-accounts').isVisible() || await page.locator('#agentGuide form').count()) throw Error('只读成员出现管理写入口');
  if (errors.length) throw Error(errors.join('\n'));
  return {workbench: 'passed', readyQueue: 'passed', resultAndSources: 'passed', originalText: 'preserved', desktopColumns: 'passed', mobileDetail: 'passed', historyAndFilters: 'passed', acceptance: 'passed', toolsAndRoles: 'passed', pageErrors: errors.length};
}
