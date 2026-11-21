async page => {
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  let version = 1;
  const longText = '这是一段很长的分析正文。'.repeat(70) + '\n\n结尾关键结论：保留手机阅读位置。';
  const tasks = Array.from({ length: 24 }, (_, i) => ({
    id: i + 1,
    title: i === 0 ? (version === 1 ? '长内容讨论任务' : '长内容讨论任务（已更新）') : `任务列表项 ${i + 1}`,
    status: i === 0 ? 'review' : 'open',
    created_by: 'Owner',
    result_summary: i === 0 ? longText : '',
    created_at: new Date(Date.now() - i * 3600_000).toISOString(),
  }));
  const debate = Array.from({ length: 24 }, (_, i) => ({
    id: 100 + i,
    agent: `Agent ${i % 3 + 1}`,
    role: 'agent',
    stance: i % 2 === 0 ? '支持' : '反駁',
    content: i === 23 || i === 10 ? longText : `第 ${i + 1} 条讨论内容：补充更多细节以便在手机端产生足够的纵向滚动高度。`,
    links: i % 2 === 1 ? 'https://example.com/evidence' : '',
    created_at: new Date(Date.now() - (24 - i) * 60_000).toISOString(),
  }));

  const json = (body, headers = {}) => ({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
  await page.route('**/api/**', route => {
    const req = route.request();
    const path = req.url().replace(/^https?:\/\/[^/]+/, '');
    const basePath = path.split('?')[0];
    if (basePath === '/api/auth/me') return route.fulfill(json({ user: { id: 1, name: 'Owner', role: 'admin' } }));
    if (path === '/api/tasks?view=summary') {
      const etag = `"v${version}"`;
      if (req.headers()['if-none-match'] === etag) return route.fulfill({ status: 304, headers: { etag } });
      tasks[0].title = version === 1 ? '长内容讨论任务' : '长内容讨论任务（已更新）';
      return route.fulfill(json({ tasks, decisions: [] }, { etag }));
    }
    if (basePath === '/api/tasks/1') {
      return route.fulfill(json({
        task: { ...tasks[0], detail: longText },
        debate,
        challenges: [],
        supplements: [],
        verify_readiness: { ready: true, checks: [] },
      }));
    }
    if (basePath === '/api/tasks/2') {
      return route.fulfill(json({ task: tasks[1], debate: [], challenges: [], supplements: [], verify_readiness: { ready: false, checks: [] } }));
    }
    return route.fulfill(json({ channels: [], messages: [], agents: [], accounts: [], highlights: [], decisions: [], markdown: '指南' }));
  });

  await page.goto('http://127.0.0.1:8765/');
  await page.waitForURL('**/#home');

  // 1. Mobile task list: scroll down, trigger background task-list update -> window.scrollY preserved!
  await page.locator('#navTasks').click();
  await page.locator('#taskList .task-item').nth(15).waitFor();
  await page.evaluate(() => window.scrollTo(0, 650));
  const listScrollBefore = await page.evaluate(() => window.scrollY);
  if (listScrollBefore < 400) throw Error(`Task list did not scroll on mobile (${listScrollBefore})`);
  version = 2;
  await Promise.all([
    page.waitForResponse(res => res.url().includes('/api/tasks?view=summary') && res.status() === 200),
    page.clock.fastForward(120_000),
  ]);
  await page.locator('#taskList').getByText('长内容讨论任务（已更新）').waitFor();
  const listScrollAfter = await page.evaluate(() => window.scrollY);
  if (Math.abs(listScrollAfter - listScrollBefore) > 15) {
    throw Error(`Mobile task list jumped on background refresh: ${listScrollBefore} -> ${listScrollAfter}`);
  }

  // 2. Open task 1 -> switches to top; expand long text + expand older conversation messages + scroll down
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail h3').waitFor();
  if (await page.evaluate(() => window.scrollY) > 5) throw Error('Opening new task on mobile did not start at top');
  await page.locator('#taskDetail').getByRole('tab', { name: /^讨论/ }).click();
  await page.locator('#detailPanel-conversation .conversation-more').click();
  await page.waitForFunction(() => document.querySelectorAll('#detailPanel-conversation .conversation-message:not([hidden])').length === 20);
  await page.locator('#detailPanel-conversation .text-fold summary').first().click();
  await page.evaluate(() => window.scrollTo(0, 950));
  const detailScrollBefore = await page.evaluate(() => window.scrollY);
  if (detailScrollBefore < 700) throw Error(`Task conversation did not scroll far enough (${detailScrollBefore})`);

  // Manual refresh while reading deep inside expanded conversation -> preserves scroll, expanded fold, and 20 messages!
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelectorAll('#detailPanel-conversation .conversation-message:not([hidden])').length === 20);
  const detailScrollAfter = await page.evaluate(() => window.scrollY);
  if (Math.abs(detailScrollAfter - detailScrollBefore) > 20) {
    throw Error(`Mobile manual refresh jumped task conversation scroll: ${detailScrollBefore} -> ${detailScrollAfter}`);
  }
  const foldOpen = await page.locator('#detailPanel-conversation .text-fold').first().evaluate(el => el.open);
  if (!foldOpen) throw Error('Expanded long text collapsed after manual refresh');
  const previewHidden = await page.locator('#detailPanel-conversation .text-preview').first().evaluate(el => el.hidden);
  if (!previewHidden) throw Error('Text preview remained visible next to restored open fold');

  // 3. Outcome reader: expand long outcome text, scroll down, click refresh -> stays in place!
  await page.locator('#navOutcomes').click();
  await page.locator('#outcomeListReview .outcome-item').first().click();
  await page.locator('#outcomeDetail .text-fold summary').click();
  await page.evaluate(() => window.scrollTo(0, 500));
  const outcomeScrollBefore = await page.evaluate(() => window.scrollY);
  if (outcomeScrollBefore < 300) throw Error(`Outcome reader did not scroll (${outcomeScrollBefore})`);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#outcomeDetail .text-fold')?.open === true);
  const outcomeScrollAfter = await page.evaluate(() => window.scrollY);
  if (Math.abs(outcomeScrollAfter - outcomeScrollBefore) > 20) {
    throw Error(`Mobile manual refresh jumped outcome reader scroll: ${outcomeScrollBefore} -> ${outcomeScrollAfter}`);
  }

  if (errors.length) throw Error(errors.join('\n'));
  return {
    listScrollPreserved: `${listScrollBefore}->${listScrollAfter}`,
    detailScrollPreserved: `${detailScrollBefore}->${detailScrollAfter}`,
    expandedMessagesPreserved: 20,
    outcomeScrollPreserved: `${outcomeScrollBefore}->${outcomeScrollAfter}`,
  };
}
