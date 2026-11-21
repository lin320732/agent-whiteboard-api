async page => {
  await page.unrouteAll({ behavior: 'wait' });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  const now = Date.now();
  const at = new Date(now - 15_000).toISOString();
  const reportedAt = new Date(now - 3600_000).toISOString();
  const resetAt = '2026-11-25T07:00:00.000Z';
  const beijingDate = value => new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
  const beijingCompact = value => {
    const dt = new Date(value);
    const yr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(dt);
    const curYr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date());
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', ...(yr !== curYr ? { year: 'numeric' } : {}),
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(dt);
  };
  const cutoff = new Date(now - 30 * 86400000).toISOString();
  let role = 'admin';
  let quotaReads = 0, visitReads = 0;

  const alphaDetailQuota = {
    unit: '积分',
    overall_percent: 69.2,
    status_level: 'green',
    basis: 'combined',
    note: '每日 00:00 自动刷新免费额度',
    source: 'muse-billing-api',
    reported_at: reportedAt,
    updated_at: at,
    free: {
      unit: '积分', remaining: 650, total: 1000, used: 350, percent: 65, status_level: 'green',
      reset_at: resetAt, expires_at: null, note: '免费额度优先消耗',
      items: [
        { name: '每日免费积分', unit: '积分', remaining: 400, total: 500, used: 100, percent: 80, status_level: 'green', reset_at: '每日 00:00', expires_at: null, note: '次日清零' },
        { name: '本月赠送积分', unit: '积分', remaining: 250, total: 500, used: 250, percent: 50, status_level: 'yellow', reset_at: null, expires_at: '2026-11-30T23:59:59+08:00', note: '月底失效' },
      ],
    },
    permanent: {
      unit: '积分', remaining: 3500, total: 5000, used: 1500, percent: 70, status_level: 'green',
      reset_at: null, expires_at: null, note: '账户永久点数，永不过期',
      items: [
        { name: '主充值永久包', unit: '积分', remaining: 3000, total: 4000, used: 1000, percent: 75, status_level: 'green', reset_at: null, expires_at: null, note: '充值包 #1' },
        { name: '活动奖励永久积分', unit: '积分', remaining: 500, total: 1000, used: 500, percent: 50, status_level: 'yellow', reset_at: null, expires_at: null, note: '永久有效' },
      ],
    },
  };

  const alphaHistory = Array.from({ length: 22 }, (_, i) => ({
    id: 200 - i,
    unit: '积分',
    free_remaining: 650 + i * 5,
    free_total: 1000,
    free_percent: Math.min(100, 65 + i * 0.5),
    permanent_remaining: 3500,
    permanent_total: 5000,
    permanent_percent: 70,
    overall_percent: Math.min(100, Math.round(((4150 + i * 5) / 6000) * 1000) / 10),
    status_level: 'green',
    basis: 'combined',
    note: i === 0 ? '自动巡检上报' : '',
    reset_at: resetAt,
    reported_at: new Date(now - (i + 1) * 3600_000).toISOString(),
    created_at: new Date(now - i * 3600_000).toISOString(),
  }));

  const alphaVisits = Array.from({ length: 55 }, (_, i) => ({
    id: 500 - i,
    visited_at: new Date(now - i * 60_000).toISOString(),
  }));

  const agents = [
    {
      id: 7, name: 'Muse Alpha', username: 'muse-alpha', kind: 'agent', role: 'agent', active: 1, last_seen_at: at,
      quota: {
        unit: '积分', overall_percent: 69.2, status_level: 'green', basis: 'combined', note: alphaDetailQuota.note, reported_at: reportedAt, updated_at: at,
        free: { remaining: 650, total: 1000, percent: 65, status_level: 'green', unit: '积分', items_count: 2, reset_at: resetAt },
        permanent: { remaining: 3500, total: 5000, percent: 70, status_level: 'green', unit: '积分', items_count: 2 },
      },
    },
    {
      id: 8, name: 'Muse Beta', username: 'muse-beta', kind: 'agent', role: 'agent', active: 1, last_seen_at: at,
      quota: {
        unit: 'tokens', overall_percent: 45, status_level: 'yellow', basis: 'free', note: '免费按百分比 · 永久按 token', updated_at: at,
        free: { remaining: null, total: null, percent: 45, status_level: 'yellow', unit: 'tokens', items_count: 1, reset_at: '每日 00:00' },
        permanent: { remaining: 185000, total: null, percent: null, status_level: 'green', unit: 'tokens', items_count: 2 },
      },
    },
    {
      id: 9, name: 'Muse Gamma', username: 'muse-gamma', kind: 'agent', role: 'agent', active: 1, last_seen_at: at,
      quota: {
        unit: '积分', overall_percent: 85.3, status_level: 'green', basis: 'combined', note: '免费额度告急', updated_at: at,
        free: { remaining: 120, total: 1000, percent: 12, status_level: 'red', unit: '积分', items_count: 0 },
        permanent: { remaining: 5000, total: 5000, percent: 100, status_level: 'green', unit: '积分', items_count: 0 },
      },
    },
    {
      id: 10, name: 'Muse New', username: 'muse-new', kind: 'agent', role: 'agent', active: 1, last_seen_at: null, quota: null,
    },
    {
      id: 11, name: 'Muse Unknown', username: 'muse-unknown', kind: 'agent', role: 'agent', active: 1, last_seen_at: at,
      quota: { basis: 'unknown', status_level: 'none', read_channel: 'none', reasons: ['daily'], updated_at: at },
    },
    {
      id: 12, name: 'Muse Zero', username: 'muse-zero', kind: 'agent', role: 'agent', active: 1, last_seen_at: at,
      quota: {
        unit: 'tokens', overall_percent: 0, status_level: 'red', basis: 'free', updated_at: at,
        free: { percent: 0, remaining: 0, reset_at: null }, permanent: { remaining: 0 },
      },
    },
    {
      id: 13, name: 'Muse Total', username: 'muse-total', kind: 'agent', role: 'agent', active: 1, last_seen_at: at,
      quota: { overall_percent: 62.5, status_level: 'green', basis: 'reported', reset_at: resetAt, reported_at: reportedAt, updated_at: at },
    },
  ];

  const json = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/api/**', route => {
    const req = route.request();
    const path = req.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path === '/api/auth/me') return route.fulfill(json({ user: { id: 1, name: 'Owner', role, kind: 'human' } }));
    if (path === '/api/admin/users') return route.fulfill(json({ accounts: [{ id: 1, name: 'Owner', username: 'owner', role: 'admin', active: 1 }] }));
    if (path === '/api/admin/agents') return route.fulfill(json({ accounts: agents }));
    if (path === '/api/admin/agents/7/quota') {
      quotaReads++;
      const older = req.url().includes('before=');
      const slice = older ? alphaHistory.slice(20) : alphaHistory.slice(0, 20);
      return route.fulfill(json({
        ok: true, agent_id: 7, retention_days: 30, timezone: 'Asia/Shanghai', cutoff_at: cutoff,
        quota: alphaDetailQuota, history: slice,
        next_cursor: older ? null : `${slice.at(-1).created_at},${slice.at(-1).id}`,
      }));
    }
    if (path === '/api/admin/agents/7/visits') {
      visitReads++;
      const older = req.url().includes('before=');
      const slice = older ? alphaVisits.slice(50) : alphaVisits.slice(0, 50);
      return route.fulfill(json({
        ok: true, agent_id: 7, retention_days: 30, timezone: 'Asia/Shanghai', cutoff_at: cutoff,
        total_requests: older ? null : alphaVisits.length, visits: slice,
        next_cursor: older ? null : `${slice.at(-1).visited_at},${slice.at(-1).id}`,
      }));
    }
    if (path === '/api/admin/agents/8/quota') {
      quotaReads++;
      return route.fulfill(json({
        ok: true, agent_id: 8, retention_days: 30, timezone: 'Asia/Shanghai', cutoff_at: cutoff,
        quota: {
          unit: 'tokens', overall_percent: 45, status_level: 'yellow', basis: 'free', note: '免费按百分比 · 永久按 token', source: 'muse-ui', reported_at: at, updated_at: at,
          free: {
            unit: 'tokens', remaining: null, total: null, used: null, percent: 45, used_percent: 55, status_level: 'yellow', reset_at: '每日 00:00', expires_at: null, note: '免费额度仅显示百分比',
            items: [
              { name: '每日免费额度', unit: 'tokens', remaining: null, total: null, used: null, percent: 45, used_percent: 55, status_level: 'yellow', reset_at: '每日 00:00', expires_at: null, note: '' },
            ],
          },
          permanent: {
            unit: 'tokens', remaining: 185000, total: null, used: null, percent: null, used_percent: null, status_level: 'green', reset_at: null, expires_at: null, note: '平台赠送永久额度，永不过期',
            items: [
              { name: '注册赠送永久额度', unit: 'tokens', remaining: 150000, total: null, used: null, percent: null, status_level: 'green', reset_at: null, expires_at: null, note: '永不过期' },
              { name: '活动奖励永久额度', unit: 'tokens', remaining: 35000, total: null, used: null, percent: null, status_level: 'green', reset_at: null, expires_at: null, note: '永不过期' },
            ],
          },
        },
        history: [{ id: 88, unit: 'tokens', free_remaining: null, free_total: null, free_percent: 45, permanent_remaining: 185000, permanent_total: null, permanent_percent: null, overall_percent: 45, status_level: 'yellow', basis: 'free', note: '巡检上报', reported_at: at, created_at: at }],
        next_cursor: null,
      }));
    }
    if (path === '/api/admin/agents/8/visits') {
      visitReads++;
      return route.fulfill(json({ ok: true, agent_id: 8, cutoff_at: cutoff, total_requests: 3, visits: [{ id: 81, visited_at: at }], next_cursor: null }));
    }
    if (path === '/api/admin/agents/9/quota') {
      quotaReads++;
      return route.fulfill(json({
        ok: true, agent_id: 9, retention_days: 30, timezone: 'Asia/Shanghai', cutoff_at: cutoff,
        quota: {
          unit: '积分', overall_percent: 85.3, status_level: 'green', basis: 'combined', note: '免费额度告急', source: '', reported_at: at, updated_at: at,
          free: { unit: '积分', remaining: 120, total: 1000, used: 880, percent: 12, status_level: 'red', reset_at: '每日 00:00', expires_at: null, note: '', items: [] },
          permanent: { unit: '积分', remaining: 5000, total: 5000, used: 0, percent: 100, status_level: 'green', reset_at: null, expires_at: null, note: '', items: [] },
        },
        history: [], next_cursor: null,
      }));
    }
    if (path === '/api/admin/agents/9/visits') {
      visitReads++;
      return route.fulfill(json({ ok: true, agent_id: 9, cutoff_at: cutoff, total_requests: 1, visits: [{ id: 9, visited_at: at }], next_cursor: null }));
    }
    if (path === '/api/admin/agents/10/quota') {
      quotaReads++;
      return route.fulfill(json({ ok: true, agent_id: 10, retention_days: 30, timezone: 'Asia/Shanghai', cutoff_at: cutoff, quota: null, history: [], next_cursor: null }));
    }
    if (path === '/api/admin/agents/10/visits') {
      visitReads++;
      return route.fulfill(json({ ok: true, agent_id: 10, cutoff_at: cutoff, total_requests: 0, visits: [], next_cursor: null }));
    }
    if (path === '/api/admin/agents/11/quota') {
      quotaReads++;
      const quota = agents.find(agent => agent.id === 11).quota;
      return route.fulfill(json({
        ok: true, agent_id: 11, quota,
        history: [{ ...quota, id: 11, unit: 'tokens', created_at: at }], next_cursor: null,
      }));
    }
    if (path === '/api/admin/agents/11/visits') {
      return route.fulfill(json({ ok: true, agent_id: 11, cutoff_at: cutoff, total_requests: 1, visits: [{ id: 11, visited_at: at }] }));
    }
    const extraDetail = path.match(/^\/api\/admin\/agents\/(12|13)\/(quota|visits)$/);
    if (extraDetail) {
      const agent = agents.find(agent => agent.id === Number(extraDetail[1]));
      return route.fulfill(json(extraDetail[2] === 'quota'
        ? { ok: true, quota: agent.quota, history: [], next_cursor: null }
        : { ok: true, total_requests: 1, visits: [{ id: agent.id, visited_at: at }], next_cursor: null }));
    }
    return route.fulfill(json({ channels: [], tasks: [], messages: [], leaderboard: [], accounts: [], agents: [], items: [], waiting: [], highlights: [], decisions: [], markdown: '', version: 'v1' }));
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#homeAgentQuotaPanel').waitFor({ state: 'visible' });

  // Verify lazy loading: detail endpoints must not be fetched on workbench load
  if (quotaReads !== 0 || visitReads !== 0) throw Error('Quota or visit detail loaded before clicking an Agent');

  // Verify workbench outer summary displays green / yellow / red / none cards cleanly
  const cards = page.locator('#homeAgentQuotaList .home-agent-card');
  if (await cards.count() !== agents.length) throw Error('Workbench did not render all agent quota cards');
  if (!await page.locator('.home-agent-card[data-agent-id="7"].level-green').count()) throw Error('Muse Alpha (65%) should be green (>=60%)');
  if (!await page.locator('.home-agent-card[data-agent-id="8"].level-yellow').count()) throw Error('Muse Beta (45%) should be yellow (20-59%)');
  if (!await page.locator('.home-agent-card[data-agent-id="9"].level-red').count()) throw Error('Muse Gamma (12%) should be red (<20%)');
  if (!await page.locator('.home-agent-card[data-agent-id="10"].level-none').count()) throw Error('Muse New should be unreported (none)');
  await page.locator('.home-agent-card[data-agent-id="11"].level-none').getByText('额度未知', { exact: true }).waitFor();
  const alphaCard = page.locator('.home-agent-card[data-agent-id="7"]');
  if (await alphaCard.locator('.home-agent-pct').textContent() !== '65%') throw Error('Free quota percentage must take priority over combined quota');
  if (!(await alphaCard.locator('.home-agent-reset').textContent()).includes(beijingCompact(resetAt))) throw Error('Workbench missing compact Beijing reset date');
  if ((await alphaCard.textContent()).includes('3,500 积分')) throw Error('Workbench compact card should omit permanent balance');
  if (!(await alphaCard.locator('.home-agent-reported').textContent()).includes(beijingCompact(reportedAt))) throw Error('Workbench must show report date rather than receipt or scan date');
  if (!(await alphaCard.locator('.home-agent-scanned').textContent()).includes(beijingCompact(at))) throw Error('Workbench must show scan date');
  if (await alphaCard.locator('.quota-bar-track').count() !== 1) throw Error('Workbench card missing progress bar');
  const zeroCard = page.locator('.home-agent-card[data-agent-id="12"]');
  await zeroCard.locator('.home-agent-pct').getByText('0%', { exact: true }).waitFor();
  if (!(await zeroCard.locator('.home-agent-reset').textContent()).includes('未上报')) throw Error('Missing reset date must be explicit');
  if (!(await page.locator('.home-agent-card[data-agent-id="13"] .home-agent-reset').textContent()).includes(beijingCompact(resetAt))) throw Error('Total-only quota reset date missing');
  if (!(await page.locator('.home-agent-card[data-agent-id="8"] .home-agent-reported').textContent()).includes(beijingCompact(at))) throw Error('Legacy report must fall back to receipt date');
  await page.locator('#homeAgentQuotaPanel').screenshot({ path: '.playwright-cli/agent-quotas-overview-desktop.png' });
  await page.screenshot({ path: '.playwright-cli/agent-quotas-workbench-desktop.png', fullPage: true });

  // Open detail modal directly from workbench card
  await page.locator('.home-agent-card[data-agent-id="7"]').click();
  const modal = page.locator('#agentDetailModal');
  await modal.waitFor({ state: 'visible' });
  await modal.getByText('每日免费积分').waitFor();
  await modal.getByText('本月赠送积分').waitFor();
  await modal.getByText('主充值永久包').waitFor();
  await modal.getByText('活动奖励永久积分').waitFor();
  await modal.getByText('近 30 天共 55 次请求').waitFor();
  if (await modal.locator('[data-quota-metric="percent"] .agent-metric-value').textContent() !== '65%') throw Error('Modal primary percentage must use free quota');
  if (!(await modal.locator('[data-quota-metric="reset"]').textContent()).includes('2026/11/25 15:00')) throw Error('Modal reset date missing from overview');
  if (!(await modal.locator('[data-quota-metric="reported"]').textContent()).includes(beijingDate(reportedAt))) throw Error('Modal report date missing from overview');
  if (await modal.locator('.quota-item-card.level-green').count() !== 2) throw Error('Expected 2 green sub-items (>=60%)');
  if (await modal.locator('.quota-item-card.level-yellow').count() !== 2) throw Error('Expected 2 yellow sub-items (50% is <60%)');
  if (await modal.locator('.quota-history-table tbody tr').count() !== 20) throw Error('Expected 20 initial quota history rows');
  if (await modal.locator('.agent-modal-visit-list li').count() !== 50) throw Error('Expected 50 initial scan log rows');
  const firstHistory = modal.locator('.quota-history-table tbody tr').first();
  if (await firstHistory.locator('time').getAttribute('datetime') !== reportedAt) throw Error('History must use reported_at rather than created_at');
  if (!(await firstHistory.textContent()).includes('2026/11/25 15:00')) throw Error('History reset date missing');
  await page.screenshot({ path: '.playwright-cli/agent-quotas-modal-desktop.png' });

  // Paginate quota history & scan logs inside modal
  await modal.getByRole('button', { name: '查看更早上报记录' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#agentDetailModal .quota-history-table tbody tr').length === 22);
  await modal.getByRole('button', { name: '查看更早扫描日志' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#agentDetailModal .agent-modal-visit-list li').length === 55);

  // Close with Escape
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });

  // Navigate to 成员与 Agent via workbench link
  await page.locator('#homeAgentQuotaManage').click();
  await page.locator('#adminPanel').waitFor({ state: 'visible' });
  await page.locator('#agents .account-item').first().waitFor({ state: 'visible' });
  if (await page.locator('#agents .account-item').count() !== agents.length) throw Error('Missing agents in admin list');
  if (!await page.locator('#agents .agent-quota-pill.level-green').getByText('免费 65%').count()) throw Error('Missing free percentage pill in admin list');
  if (!await page.locator('#agents .agent-quota-pill.level-yellow').getByText('45%').count()) throw Error('Missing yellow percentage pill in admin list');
  if (!await page.locator('#agents .agent-quota-pill.level-red').getByText('12%').count()) throw Error('Missing red percentage pill in admin list');
  const alphaAdmin = page.locator('#agents .account-item').filter({ hasText: 'Muse Alpha' });
  if (!(await alphaAdmin.locator('.quota-summary-reset').textContent()).includes('2026/11/25 15:00')) throw Error('Admin list reset date missing');
  if (!(await alphaAdmin.locator('.quota-summary-reported').textContent()).includes(beijingDate(reportedAt))) throw Error('Admin list report date missing');
  await page.locator('#adminPanel').screenshot({ path: '.playwright-cli/agent-quotas-admin-desktop.png' });

  // Open detail for Muse Beta (free percent + permanent concrete tokens), red agent, and unreported agent from 成员与 Agent
  await page.locator('#agents .account-item').nth(1).getByRole('button', { name: '详情' }).click();
  await modal.getByText('偏低 · 免费 45%').waitFor();
  await modal.getByText('剩余 45%').waitFor();
  await modal.getByText('150,000 tokens').waitFor();
  await modal.getByText('35,000 tokens').waitFor();
  const histText = await modal.locator('.quota-history-table tbody tr').first().textContent();
  if (!histText.includes('45%') || !histText.includes('185,000 tokens')) throw Error('Muse hybrid history row missing free % or permanent tokens');
  await page.screenshot({ path: '.playwright-cli/agent-quotas-muse-hybrid-modal.png' });
  await modal.getByRole('button', { name: '关闭' }).click();
  await modal.waitFor({ state: 'hidden' });

  await page.locator('#agents .account-item').nth(2).getByRole('button', { name: '详情' }).click();
  await modal.getByText('告急 · 免费 12%').waitFor();
  await modal.getByRole('button', { name: '关闭' }).click();
  await modal.waitFor({ state: 'hidden' });

  await page.locator('#agents .account-item').nth(3).getByRole('button', { name: '详情' }).click();
  await modal.getByText('尚未收到该 Agent 的额度上报').waitFor();
  await modal.getByRole('button', { name: '关闭' }).click();

  await page.locator('#agents .account-item').filter({ hasText: 'Muse Total' }).getByRole('button', { name: '详情' }).click();
  if (!(await modal.locator('[data-quota-metric="reset"]').textContent()).includes('2026/11/25 15:00')) throw Error('Total-only reset date missing from modal');
  await modal.getByRole('button', { name: '关闭' }).click();

  await page.locator('#agents .account-item').filter({ hasText: 'Muse Unknown' }).getByRole('button', { name: '详情' }).click();
  await modal.getByText('已收到心跳，等待额度读数').waitFor();
  await modal.locator('.quota-history-table tbody tr').getByText('额度未知').waitFor();
  await modal.locator('.quota-history-table tbody tr').getByText('每日心跳 · 无读数渠道').waitFor();
  await modal.getByRole('button', { name: '关闭' }).click();

  // Mobile layout check (390x844): zero horizontal overflow on workbench, admin list, and modal
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Admin panel overflows on mobile');
  await page.locator('#navHome').click();
  await page.locator('#homeAgentQuotaPanel').waitFor({ state: 'visible' });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Workbench with agent quota panel overflows on mobile');
  await page.screenshot({ path: '.playwright-cli/agent-quotas-workbench-mobile.png', fullPage: true });
  await page.locator('.home-agent-card[data-agent-id="7"]').click();
  await modal.getByText('每日免费积分').waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Agent detail modal overflows on mobile');
  await page.screenshot({ path: '.playwright-cli/agent-quotas-modal-mobile.png' });
  await page.keyboard.press('Escape');

  // Role check (3A): non-admin viewer cannot see agent quota panel
  role = 'viewer';
  await page.reload();
  await page.locator('#viewHome').waitFor({ state: 'visible' });
  if (await page.locator('#homeAgentQuotaPanel').isVisible()) throw Error('Non-admin viewer must not see admin agent quota panel');
  if (errors.length) throw Error(errors.join('\n'));
  return { workbenchOuter: 'passed', adminOuter: 'passed', detailModal: 'passed', historyPagination: 22, visitPagination: 55, mobileOverflow: false, adminOnly: true };
}
