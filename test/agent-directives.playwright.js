async page => {
  await page.unrouteAll({ behavior: 'wait' });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  const now = Date.now();
  const at = new Date(now - 30_000).toISOString();
  const earlier = new Date(now - 3600_000).toISOString();
  const cutoff = new Date(now - 30 * 86400000).toISOString();

  let role = 'admin';
  let nextDirectiveId = 102;
  let adminDirectiveRequests = 0;

  const agents = [
    {
      id: 7, name: 'Muse Alpha', username: 'muse-alpha', kind: 'agent', role: 'agent', active: 1, last_seen_at: at,
      pending_directives: 1, completed_directives: 1,
      quota: {
        unit: 'tokens', overall_percent: 78, status_level: 'green', basis: 'free', note: '运行正常', updated_at: at,
        free: { remaining: null, total: null, percent: 78, status_level: 'green', unit: 'tokens', items_count: 0 },
        permanent: { remaining: 200000, total: null, percent: null, status_level: 'green', unit: 'tokens', items_count: 0 },
      },
    },
    {
      id: 8, name: 'Muse Beta', username: 'muse-beta', kind: 'agent', role: 'agent', active: 1, last_seen_at: at,
      pending_directives: 0, completed_directives: 0,
      quota: null,
    },
    {
      id: 9, name: 'Muse Retired', username: 'muse-retired', kind: 'agent', role: 'agent', active: 0, last_seen_at: null,
      pending_directives: 0, completed_directives: 1,
      quota: null,
    },
  ];

  const directivesByAgent = {
    7: [
      {
        id: 101, agent_id: 7, agent_name: 'Muse Alpha', author_id: 1, author_name: 'Owner',
        content: '请检查今日市场周报的数据来源并补充完整统计口径。',
        status: 'pending', result: '', links: [], created_at: at, completed_at: null,
      },
      {
        id: 100, agent_id: 7, agent_name: 'Muse Alpha', author_id: 1, author_name: 'Owner',
        content: '请核对昨日抓取任务是否遗漏港股板块，完成后回馈结果。',
        status: 'completed',
        result: '已完成核查：港股板块因收盘时区漏跑一次，已补抓并校验全部 42 条数据。',
        links: ['https://example.com/hk-audit-log'],
        created_at: earlier, completed_at: at,
      },
    ],
    8: [],
    9: [
      {
        id: 90, agent_id: 9, agent_name: 'Muse Retired', author_id: 1, author_name: 'Owner',
        content: '归档旧项目文档索引。',
        status: 'completed',
        result: '已归档全部旧索引。',
        links: [],
        created_at: earlier, completed_at: at,
      },
    ],
  };

  const countFor = agentId => {
    const list = directivesByAgent[agentId] || [];
    const pending = list.filter(d => d.status === 'pending').length;
    const completed = list.filter(d => d.status === 'completed').length;
    return { pending, completed, total: list.length };
  };

  const sampleTaskSummary = {
    id: 50,
    title: '港股科技周报核查',
    detail: '由 Muse Alpha 负责交付，Muse Beta 独立核查。',
    status: 'review',
    claimed_by: 'Muse Alpha',
    host: 'Muse Alpha',
    created_by: 'Owner',
    created_at: earlier,
    plan: { goal: 'research', collaboration: 'single', delivery: { format: 'text' }, acceptance: { independent_review: true, min_sources: 1 }, schedule: { kind: 'immediate' } },
  };

  const sampleTaskDetail = {
    task: sampleTaskSummary,
    plan: sampleTaskSummary.plan,
    workflow: {
      enabled: true,
      fingerprint: 'fp-50',
      host_id: 7,
      host: 'Muse Alpha',
      report_author_id: 7,
      report_author: 'Muse Alpha',
      author_ids: [7],
      outcomes: [
        { id: 302, author_id: 7, author: 'Muse Alpha', summary: '最新核查结论：所有数据已核验一致。', links: 'https://example.com/report', changes: '修订数据口径', created_at: at },
        { id: 301, author_id: 8, author: 'Muse Beta', summary: '初版草案。', links: '', changes: '首次提交', created_at: earlier },
      ],
      reviews: [
        { id: 401, reviewer_id: 8, reviewer: 'Muse Beta', fingerprint: 'fp-50', note: '已独立复核全部数据。', evidence: 'https://example.com/report', created_at: at },
      ],
      current_reviews: [
        { id: 401, reviewer_id: 8, reviewer: 'Muse Beta', fingerprint: 'fp-50', note: '已独立复核全部数据。', evidence: 'https://example.com/report', created_at: at },
      ],
      issues: [
        { id: 501, author_id: 8, author: 'Muse Beta', severity: 'suggestion', state: 'responded', text: '建议补充样本时间范围', response: '已在 v2 补充', responder_id: 7, responder: 'Muse Alpha', revision: 2 },
      ],
      subtasks: [],
    },
    debate: [
      { id: 1, agent: 'Muse Alpha', role: 'agent', stance: '支持', content: '样本口径已统一为北京时间。', created_at: earlier },
      { id: 2, agent: 'Owner', role: 'human', stance: '补充', content: '人类管理员补充一条说明。', created_at: at },
    ],
    challenges: [],
    supplements: [],
    verify_readiness: { ready: true, checks: [] },
  };

  const sampleMessages = [
    { id: 11, channel_id: 1, author: 'Muse Alpha', role: 'agent', text: '巡检报告：接口状态正常。', created_at: at },
    { id: 12, channel_id: 1, author: 'Owner', role: 'human', text: '收到，继续保持。', created_at: at },
  ];

  const sampleFiles = [
    {
      id: 'f_aaaaaaaaaaaaaaaaaaaa',
      title: '港股周报附件',
      filename: 'hk-weekly.html',
      content_type: 'text/html',
      scope: 'report',
      size: 2048,
      uploader: 'Muse Alpha',
      uploader_id: 7,
      task_id: 50,
      task_title: '港股科技周报核查',
      url: 'http://127.0.0.1:8765/api/files/f_aaaaaaaaaaaaaaaaaaaa/hk-weekly.html',
      path: '/api/files/f_aaaaaaaaaaaaaaaaaaaa/hk-weekly.html',
      created_at: at,
    },
  ];

  const json = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });

  await page.route('**/api/**', async route => {
    const req = route.request();
    const method = req.method();
    const raw = req.url().replace(/^https?:\/\/[^/]+/, '');
    const [path, qs = ''] = raw.split('?');
    const queryParam = key => {
      const m = qs.match(new RegExp(`(?:^|&)${key}=([^&]*)`));
      return m ? decodeURIComponent(m[1]) : null;
    };

    if (path === '/api/auth/me') return route.fulfill(json({ user: { id: role === 'admin' ? 1 : 2, name: role === 'admin' ? 'Owner' : 'Viewer', role, kind: 'human' } }));
    if (path === '/api/channels') return route.fulfill(json({ channels: [{ id: 1, name: '综合反馈', topic: '系统观察' }] }));
    if (path === '/api/tasks') return route.fulfill(json({ tasks: [sampleTaskSummary], decisions: [] }));
    if (path === '/api/tasks/50') return route.fulfill(json(sampleTaskDetail));
    if (path === '/api/messages') return route.fulfill(json({ messages: sampleMessages }));
    if (path === '/api/files') return route.fulfill(json({ files: sampleFiles }));
    if (path === '/api/participants') return route.fulfill(json({ agents: agents.filter(a => a.active).map(a => ({ id: a.id, name: a.name, username: a.username })) }));
    if (path === '/api/admin/users') return route.fulfill(json({ accounts: [{ id: 1, name: 'Owner', username: 'owner', role: 'admin', active: 1 }] }));
    if (path === '/api/admin/agents') {
      const updated = agents.map(a => ({ ...a, pending_directives: countFor(a.id).pending, completed_directives: countFor(a.id).completed }));
      return route.fulfill(json({ accounts: updated }));
    }

    const dirListMatch = path.match(/^\/api\/admin\/agents\/(\d+)\/directives$/);
    if (dirListMatch) {
      adminDirectiveRequests++;
      if (role !== 'admin') return route.fulfill(json({ ok: false, error: '仅管理员可操作' }, 403));
      const aid = Number(dirListMatch[1]);
      if (method === 'GET') {
        const status = queryParam('status') || 'all';
        const all = directivesByAgent[aid] || [];
        const filtered = status === 'all' ? all : all.filter(d => d.status === status);
        return route.fulfill(json({ ok: true, agent_id: aid, counts: countFor(aid), directives: filtered, has_more: false, next_cursor: null }));
      }
      if (method === 'POST') {
        const body = req.postDataJSON();
        const ag = agents.find(a => a.id === aid);
        const created = {
          id: nextDirectiveId++,
          agent_id: aid,
          agent_name: ag?.name || `Agent #${aid}`,
          author_id: 1,
          author_name: 'Owner',
          content: String(body.content || '').trim(),
          status: 'pending',
          result: '',
          links: [],
          created_at: new Date().toISOString(),
          completed_at: null,
        };
        directivesByAgent[aid] = [created, ...(directivesByAgent[aid] || [])];
        return route.fulfill(json({ ok: true, directive: created, counts: countFor(aid) }, 201));
      }
    }

    const dirDelMatch = path.match(/^\/api\/admin\/agents\/(\d+)\/directives\/(\d+)$/);
    if (dirDelMatch && method === 'DELETE') {
      adminDirectiveRequests++;
      if (role !== 'admin') return route.fulfill(json({ ok: false, error: '仅管理员可操作' }, 403));
      const aid = Number(dirDelMatch[1]);
      const did = Number(dirDelMatch[2]);
      directivesByAgent[aid] = (directivesByAgent[aid] || []).filter(d => d.id !== did);
      return route.fulfill(json({ ok: true, id: did, counts: countFor(aid) }));
    }

    const quotaMatch = path.match(/^\/api\/admin\/agents\/(\d+)\/quota$/);
    if (quotaMatch) {
      const aid = Number(quotaMatch[1]);
      const ag = agents.find(a => a.id === aid);
      return route.fulfill(json({ ok: true, agent_id: aid, cutoff_at: cutoff, quota: ag?.quota || null, history: [], next_cursor: null }));
    }
    const visitsMatch = path.match(/^\/api\/admin\/agents\/(\d+)\/visits$/);
    if (visitsMatch) {
      const aid = Number(visitsMatch[1]);
      return route.fulfill(json({ ok: true, agent_id: aid, cutoff_at: cutoff, total_requests: 2, visits: [{ id: 1, visited_at: at }], next_cursor: null }));
    }

    return route.fulfill(json({ ok: true, channels: [], tasks: [], messages: [], agents: [], items: [], waiting: [], highlights: [], decisions: [], markdown: '', version: 'v1' }));
  });

  const modal = page.locator('#agentDetailModal');

  // ---- 1. Desktop Admin Flow ----
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#homeAgentQuotaPanel').waitFor({ state: 'visible' });

  // Workbench card displays pending directive badge for Muse Alpha
  await page.locator('.home-agent-card[data-agent-id="7"]').getByText('待回馈 1').waitFor();

  // Navigate to Tasks -> open task #50
  await page.locator('#navTasks').click();
  await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail .task-meta').waitFor({ state: 'visible' });

  // Click Agent name in Task Detail meta ("Muse Alpha") -> opens modal
  await page.locator('#taskDetail .task-meta .agent-name-trigger[data-agent-id="7"]').click();
  await modal.waitFor({ state: 'visible' });
  await modal.locator('#agentModalTitle').getByText('Muse Alpha').waitFor();
  await modal.getByText('请检查今日市场周报的数据来源').waitFor();
  await modal.getByText('已完成核查：港股板块因收盘时区漏跑一次').waitFor();
  await modal.getByText('Muse Alpha 回馈完成（已自动归档）').waitFor();

  // Completed directive must NOT have a recall button; pending directive MUST have one
  if (await modal.locator('.agent-directive-card[data-directive-id="100"] .agent-directive-recall-btn').count() !== 0) {
    throw Error('Completed archived directive must not show recall button');
  }
  if (await modal.locator('.agent-directive-card[data-directive-id="101"] .agent-directive-recall-btn').count() !== 1) {
    throw Error('Pending directive should show recall button');
  }

  // Test filter chips inside modal
  await modal.locator('[data-directive-filter="completed"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#agentDetailModal .agent-directive-card').length === 1);
  await modal.locator('.agent-directive-card[data-directive-id="100"]').waitFor();
  await modal.locator('[data-directive-filter="all"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#agentDetailModal .agent-directive-card').length === 2);

  // Send a new directive via composer
  await modal.locator('#agentDirectiveInput').fill('请把本周 Top 5 研报整理成对比表后回馈给我。');
  await modal.locator('#agentDirectiveForm button[type="submit"]').click();
  await modal.getByText('请把本周 Top 5 研报整理成对比表后回馈给我。').waitFor();
  await modal.locator('.agent-modal-title-row').getByText('待回馈 2').waitFor();

  // Recall the newly sent pending directive (#102)
  const newCard = modal.locator('.agent-directive-card[data-directive-id="102"]');
  await newCard.locator('.agent-directive-recall-btn').click();
  await newCard.locator('.agent-directive-recall-confirm').click();
  await newCard.waitFor({ state: 'detached' });
  await modal.locator('.agent-modal-title-row').getByText('待回馈 1').waitFor();

  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // Click Muse Beta inside 参与角色 -> opens Muse Beta modal
  await page.locator('#taskDetail .task-roles .agent-name-trigger[data-agent-id="8"]').first().click();
  await modal.waitFor({ state: 'visible' });
  await modal.locator('#agentModalTitle').getByText('Muse Beta').waitFor();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // Switch to Conversation tab: Muse Alpha is clickable trigger, human "Owner" is NOT clickable
  await page.locator('#detailTab-conversation').click();
  if (await page.locator('#detailPanel-conversation .agent-name-trigger[data-agent-id="7"]').count() === 0) {
    throw Error('Agent speaker in conversation should be clickable for admin');
  }
  const humanTriggerCount = await page.locator('#detailPanel-conversation .conversation-message.human .agent-name-trigger').count();
  if (humanTriggerCount !== 0) throw Error('Human speaker must not be rendered as agent-name-trigger');

  // Switch to 讨论区: Agent author is clickable, human author is NOT
  await page.locator('#navCommunity').click();
  await page.locator('#messages .entry').first().waitFor({ state: 'visible' });
  const msgTrigger = page.locator('#messages .agent-name-trigger[data-agent-id="7"]');
  if (await msgTrigger.count() !== 1) throw Error('Expected clickable agent name in discussion messages');
  await msgTrigger.click();
  await modal.waitFor({ state: 'visible' });
  await modal.locator('#agentModalTitle').getByText('Muse Alpha').waitFor();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // Switch to 档案: uploader Agent is clickable
  await page.locator('#navFiles').click();
  await page.locator('#filesList .file-gallery-card').first().waitFor({ state: 'visible' });
  await page.locator('#filesList .agent-name-trigger[data-agent-id="7"]').first().click();
  await modal.waitFor({ state: 'visible' });
  await modal.locator('#agentModalTitle').getByText('Muse Alpha').waitFor();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // Switch to Admin Accounts -> test "留言" button focuses composer, and test inactive agent
  await page.locator('#workspaceMenu > summary').click();
  await page.locator('#accountsMenu').click();
  await page.locator('#adminPanel').waitFor({ state: 'visible' });
  await page.locator('#agents [data-agent-account-id="7"] .agent-directive-btn').click();
  await modal.waitFor({ state: 'visible' });
  const isFocused = await page.evaluate(() => document.activeElement?.id === 'agentDirectiveInput');
  if (!isFocused) throw Error('Clicking 留言 button should focus #agentDirectiveInput');
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // Open inactive agent Muse Retired -> composer hidden, archived record still visible
  await page.locator('#agents [data-agent-account-id="9"] .agent-name-trigger').click();
  await modal.waitFor({ state: 'visible' });
  await modal.getByText('该 Agent 已停用，无法下达新留言').waitFor();
  if (await modal.locator('#agentDirectiveInput').count() !== 0) throw Error('Inactive agent must not show directive composer');
  await modal.getByText('已归档全部旧索引。').waitFor();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // ---- 2. Mobile 390x844 Overflow Check ----
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    throw Error('Admin accounts overflows on mobile');
  }
  await page.locator('#agents [data-agent-account-id="7"] .agent-directive-btn').click();
  await modal.waitFor({ state: 'visible' });
  await modal.getByText('请检查今日市场周报的数据来源').waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    throw Error('Agent detail modal with directives overflows on mobile');
  }
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // ---- 3. Non-Admin RBAC Checks (viewer & publisher) ----
  for (const nonAdminRole of ['viewer', 'publisher']) {
    role = nonAdminRole;
    adminDirectiveRequests = 0;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('about:blank');
    await page.goto('http://127.0.0.1:8765/');
    await page.locator('#viewHome').waitFor({ state: 'visible' });
    if (await page.locator('#homeAgentQuotaPanel').isVisible()) {
      throw Error(`Role ${nonAdminRole} must not see #homeAgentQuotaPanel`);
    }

    await page.locator('#navTasks').click();
    await page.locator('#taskList .task-item').first().click();
    await page.locator('#taskDetail .task-meta').waitFor({ state: 'visible' });
    if (await page.locator('.agent-name-trigger').count() !== 0) {
      throw Error(`Role ${nonAdminRole} must not see any clickable .agent-name-trigger in task detail`);
    }

    await page.locator('#navCommunity').click();
    await page.locator('#messages .entry').first().waitFor({ state: 'visible' });
    if (await page.locator('#messages .agent-name-trigger').count() !== 0) {
      throw Error(`Role ${nonAdminRole} must not see clickable .agent-name-trigger in messages`);
    }

    await page.locator('#navFiles').click();
    await page.locator('#filesList .file-gallery-card').first().waitFor({ state: 'visible' });
    if (await page.locator('#filesList .agent-name-trigger').count() !== 0) {
      throw Error(`Role ${nonAdminRole} must not see clickable .agent-name-trigger in files`);
    }

    if (adminDirectiveRequests !== 0) {
      throw Error(`Role ${nonAdminRole} must never trigger admin directive API calls`);
    }
  }

  if (errors.length) throw Error(errors.join('\n'));
  return {
    adminClickableSurfaces: ['workbench', 'taskMeta', 'taskRoles', 'conversation', 'messages', 'files', 'adminAccounts'],
    directiveSendAndRecall: 'passed',
    inactiveAgentArchivedOnly: 'passed',
    mobileOverflow: false,
    nonAdminIsolated: ['viewer', 'publisher'],
  };
}
