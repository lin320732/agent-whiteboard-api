async page => {
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  const end_at = '2030-01-01T20:00:00+08:00';
  const plan = {
    goal: 'active_debate',
    collaboration: 'open',
    acceptance: { criteria: '持续讨论至截止并总结', min_sources: 0, independent_review: false, opposing_views: true },
    schedule: { kind: 'once', start_at: null, end_at },
    delivery: { format: 'text', author_id: 2 },
    revision: 1,
    configured: true,
  };
  let nextId = 55;
  let recapRequestedAt = null;
  const posts = [];
  const debate = [
    { id: 53, agent: 'Worker', role: 'agent', stance: '支持', content: '先做小范围试点能更快暴露真实使用问题。', created_at: '2026-11-18T10:00:00Z' },
    { id: 54, agent: 'Checker', role: 'agent', stance: '反駁', reply_to: 53, content: '小范围样本可能失真，需要明确评估指标和退出条件。', created_at: '2026-11-18T10:05:00Z' },
  ];

  const discussion = () => {
    const recaps = debate.filter(m => m.stance === '阶段总结');
    const latestRecap = recaps.at(-1) || null;
    const substantive = debate.filter(m => m.stance !== '阶段总结');
    const newer = latestRecap ? substantive.filter(m => m.id > latestRecap.id).length : substantive.length;
    return {
      phase: 'active',
      end_at,
      participants: 2,
      rounds: 1,
      min_rounds: 3,
      participation_sufficient: false,
      last_message_id: debate.at(-1).id,
      summary_author_id: 2,
      summary_author: 'Worker',
      has_summary: false,
      recap_count: recaps.length,
      latest_recap_id: latestRecap?.id || null,
      latest_recap_at: latestRecap?.created_at || null,
      messages_since_recap: newer,
      recap_every: 6,
      recap_requested_at: newer > 0 ? recapRequestedAt : null,
      recap_due: newer >= 6 || (Boolean(recapRequestedAt) && newer > 0),
    };
  };
  const task = () => ({ id: 1, title: '是否先做小范围试点', type: 'active_debate', status: 'in_progress', created_by: 'Owner', detail: '讨论是否应先小范围试点再全面推广。', plan, discussion: discussion() });
  const workflow = () => ({
    enabled: true, plan, scheduled: { ready: true }, waiting: false,
    host_id: null, host: '', report_author_id: null,
    fingerprint: `fp-${debate.at(-1).id}`,
    author_ids: [], issues: [], subtasks: [], reviews: [], current_reviews: [], blocking: 0,
    discussion: discussion(), outcomes: [{ id: 1, author_id: 2, author: 'Worker', summary: '历史成果样例：综合前期观点（#53/#54），建议有条件小范围试点。', changes: '样例', links: '', source_refs: [], created_at: '2026-11-18T10:15:00Z' }],
  });
  const json = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });

  await page.route('**/api/**', async route => {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (request.method() === 'POST') {
      const b = JSON.parse(request.postData() || '{}');
      posts.push({ path, body: b });
      if (path === '/api/tasks/1/recap-request') {
        recapRequestedAt = '2026-11-18T10:10:00Z';
        return route.fulfill(json({ ok: true, requested: true, already_pending: false, recap_requested_at: recapRequestedAt }));
      }
      if (path === '/api/tasks/1/debate') {
        const msg = {
          id: nextId++,
          agent: 'Owner',
          role: 'human',
          stance: b.stance,
          content: b.content,
          reply_to: b.stance === '阶段总结' ? null : (b.reply_to ?? null),
          links: (b.links || []).join('\n'),
          created_at: '2026-11-18T10:12:00Z',
        };
        debate.push(msg);
        if (b.stance === '阶段总结') recapRequestedAt = null;
        return route.fulfill(json({ ok: true, message: msg }));
      }
      return route.fulfill(json({ ok: true }));
    }
    if (path === '/api/auth/me') return route.fulfill(json({ user: { id: 1, role: 'admin', kind: 'human', name: 'Owner' } }));
    if (path === '/api/tasks') return route.fulfill(json({ tasks: [task()] }));
    if (path === '/api/tasks/1') return route.fulfill(json({ task: task(), plan, workflow: workflow(), debate, verify_readiness: { ready: false, checks: [] }, collaboration: { help_wanted: true, reason: '持续交锋中', suggested_action: 'debate' } }));
    if (path === '/api/channels') return route.fulfill(json({ channels: [] }));
    if (path === '/api/messages') return route.fulfill(json({ messages: [] }));
    if (path === '/api/leaderboard') return route.fulfill(json({ leaderboard: [] }));
    if (path === '/api/participants') return route.fulfill(json({ agents: [{ id: 2, name: 'Worker' }] }));
    if (path === '/api/admin/users' || path === '/api/admin/agents') return route.fulfill(json({ accounts: [] }));
    if (path === '/api/inbox') return route.fulfill(json({ items: [], waiting: [] }));
    if (path === '/api/digest') return route.fulfill(json({ highlights: [], decisions: [] }));
    if (path === '/api/topics') return route.fulfill(json({ themes: [], topics: [] }));
    if (path.endsWith('/contributions')) return route.fulfill(json({ contributions: [] }));
    return route.fulfill(json({ ok: true }));
  });

  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#navTasks').click();
  await page.locator('#taskList .task-item').first().click();
  await page.locator('.active-debate-progress').getByRole('button', { name: '请求阶段总结' }).waitFor();

  await page.locator('#taskDetail').getByRole('tab', { name: /^讨论/ }).click();
  const bar = page.locator('.conversation-recap-bar');
  await bar.waitFor();
  await page.locator('.conversation-filter-chip[data-filter="recap"]').click();
  await page.locator('.conversation-empty').getByText('暂无阶段总结', { exact: false }).waitFor();
  await page.locator('.conversation-filter-chip[data-filter="all"]').click();
  await bar.getByRole('button', { name: '请求阶段总结' }).click();
  await page.locator('.conversation-recap-bar').getByText('已请求 Worker 更新阶段总结', { exact: false }).waitFor();
  if (!posts.some(p => p.path === '/api/tasks/1/recap-request')) throw Error('未发送请求阶段总结接口');

  const form = page.locator('#debateForm');
  await form.getByRole('combobox', { name: '立场', exact: true }).selectOption('阶段总结');
  if (!await form.locator('select[name="reply_to"]').isDisabled()) throw Error('选择阶段总结时未禁用 reply_to');
  await form.getByLabel('发言内容', { exact: true }).fill('总体进展：目前围绕是否先小范围试点展开了首轮交锋。\n支持方认为试点能快速暴露真实问题；反驳方担心样本失真。\n当前整体偏向“有条件小范围试点”，核心分歧在于如何设定评估指标。');
  await form.getByRole('button', { name: '发表阶段总结' }).click();
  await page.locator('#notice').getByText('阶段总结已发布', { exact: true }).waitFor();

  const pinned = page.locator('.conversation-recap-card');
  await pinned.waitFor();
  await pinned.getByText('已覆盖当前讨论', { exact: true }).waitFor();
  await pinned.getByText('有条件小范围试点', { exact: false }).waitFor();
  if (await pinned.locator('.recap-ref-glossary').count()) throw Error('不含楼层引用的阶段总结不应渲染提及楼层速览');
  const postedRecap = posts.filter(p => p.path === '/api/tasks/1/debate').at(-1)?.body;
  if (postedRecap?.stance !== '阶段总结' || 'reply_to' in postedRecap) throw Error('阶段总结提交载荷异常');

  // Switch to overview and verify overview recap preview + jump into recap filter
  await page.locator('#taskDetail').getByRole('tab', { name: '概览', exact: true }).click();
  const overviewRecap = page.locator('.overview-recap-card');
  await overviewRecap.waitFor();
  await overviewRecap.getByRole('button', { name: '查看全部阶段总结（1）' }).click();
  const activeRecapChip = page.locator('.conversation-filter-chip[data-filter="recap"]');
  if (await activeRecapChip.getAttribute('aria-pressed') !== 'true') throw Error('概览快捷跳转未激活阶段总结筛选标签');
  if (await page.locator('#taskDetail .conversation-message').count() !== 1) throw Error('阶段总结筛选未过滤非总结发言');

  // Add one more substantive post and verify freshness badge + request update button
  await page.locator('.conversation-filter-chip[data-filter="all"]').click();
  await form.getByRole('combobox', { name: '立场', exact: true }).selectOption('补充');
  if (await form.locator('select[name="reply_to"]').isDisabled()) throw Error('切回普通立场时未恢复 reply_to');
  await form.getByLabel('发言内容', { exact: true }).fill('补充一个具体评估指标：观察两周留存与报错率。');
  await form.getByRole('button', { name: '发表观点' }).click();
  await pinned.getByText('之后新增 1 条讨论', { exact: true }).waitFor();
  await pinned.getByRole('button', { name: '请求更新总结' }).waitFor();

  // Post a recap containing floor refs (#53/#54) and verify automatic inline glossary explains both cited floors
  await form.getByRole('combobox', { name: '立场', exact: true }).selectOption('阶段总结');
  await form.getByLabel('发言内容', { exact: true }).fill('综合前期观点（#53/#54）：支持方主张先做小范围试点，反驳方关心样本失真。目前倾向小范围试点并补齐两周留存与报错率指标。');
  await form.getByRole('button', { name: '发表阶段总结' }).click();
  const glossary = pinned.locator('.recap-ref-glossary');
  await glossary.waitFor();
  await glossary.getByText('先做小范围试点能更快暴露真实使用问题', { exact: false }).waitFor();
  await glossary.getByText('小范围样本可能失真', { exact: false }).waitFor();
  await glossary.locator('.recap-ref-glossary-link', { hasText: '#53' }).click();
  await page.waitForFunction(() => document.getElementById('debate-53')?.classList.contains('flash'));

  // Verify legacy outcome containing #53/#54 automatically explains cited floors and jumps to conversation
  await page.locator('#taskDetail').getByRole('tab', { name: '成果', exact: true }).click();
  const outcomeGlossary = page.locator('#detailPanel-outcome .outcome-ref-glossary');
  await outcomeGlossary.waitFor();
  await outcomeGlossary.getByText('先做小范围试点能更快暴露真实使用问题', { exact: false }).waitFor();
  await outcomeGlossary.getByText('小范围样本可能失真', { exact: false }).waitFor();
  await outcomeGlossary.locator('.recap-ref-glossary-link', { hasText: '#53' }).click();
  await page.waitForFunction(() => document.getElementById('debate-53')?.classList.contains('flash'));

  // Mobile layout check (390px)
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('阶段总结页面手机版横向溢出');
  await page.locator('#taskDetail').getByRole('tab', { name: '概览', exact: true }).click();
  await page.locator('.overview-recap-card .recap-ref-glossary').waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('概览阶段总结预览手机版横向溢出');

  if (errors.length) throw Error(errors.join('\n'));
  return { recapRequest: true, pinnedCard: true, refGlossary: true, filterChips: true, overviewPreview: true, mobileClean: true, pageErrors: errors.length };
}
