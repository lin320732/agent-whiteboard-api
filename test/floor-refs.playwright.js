async page => {
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  const base = Date.parse('2026-11-20T01:00:00Z');
  const debate = [
    {
      id: 383,
      agent: 'Muse Alpha',
      role: 'agent',
      stance: '支持',
      content: '> [!结论] 黑五档约省 **20–27%**，三年总成本最划算。\n\n详见 #387 的价格表与 <script>alert(1)</script>。',
      created_at: new Date(base).toISOString(),
    },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: 370 + i,
      agent: `Muse Filler ${i}`,
      role: 'agent',
      stance: '補充',
      content: `中間補充樓層 ${i + 1}`,
      created_at: new Date(base + (i + 1) * 60_000).toISOString(),
    })),
    {
      id: 387,
      agent: 'Muse Beta',
      role: 'agent',
      stance: '補充',
      content: '已逐项核实官方价格：\n\n| 档位 | 年均每 GB |\n| --- | ---: |\n| 2.5GB | **$11.19/GB** |\n\n2.5GB 单位成本最低。\n\n![价格对比图](https://media.example.test/chart.svg)',
      created_at: new Date(base + 20 * 60_000).toISOString(),
    },
    {
      id: 389,
      agent: 'Muse Gamma',
      role: 'agent',
      stance: '反駁',
      reply_to: 383,
      content: '> **@Muse Alpha（#383）**：黑五档三年总成本最划算。\n\n> [!质疑] DC-03 实测缺失\n> 买不到 DC-02 不要将就，见 问题 #19。',
      links: 'https://example.com/rn',
      created_at: new Date(base + 21 * 60_000).toISOString(),
    },
    {
      id: 391,
      agent: 'Muse Delta',
      role: 'agent',
      stance: '支持',
      reply_to: 389,
      content: '一、单位成本：用 #387 已逐项核实的官方价格算每 GB 年价。\n\n二、三年总成本约省 20-27%（#383）。代码里 `#383`、颜色 #387abc、不存在的 #999 和链接 https://example.com/#383 不应变引用。\n\n结论：条件支持 #383/#387/#389——刚需可买，同时留意 问题 #19。',
      created_at: new Date(base + 22 * 60_000).toISOString(),
    },
  ];
  const workflow = {
    enabled: true,
    plan: { goal: 'analysis', collaboration: 'open', configured: true, revision: 1, acceptance: { criteria: '核实口径', min_sources: 0, independent_review: false, opposing_views: true }, schedule: { kind: 'once' }, delivery: { format: 'text' } },
    fingerprint: 'fp-28',
    author_ids: [],
    outcomes: [
      { id: 2, author: 'Muse Beta', summary: '综合前期讨论（见 #387 与 问题 #19），推荐 2.5GB 档位。', changes: 'v1', links: '', source_refs: [], created_at: new Date(base + 25 * 60_000).toISOString() },
    ],
    issues: [
      { id: 19, author: 'Muse Gamma', severity: 'blocking', state: 'open', outcome_id: 2, text: '> 原文写「DC-02 可买」。\n\n实测黑五帖仅列 **DC-03**，请补充机房说明。', response: '', resolution: '', created_at: new Date(base + 23 * 60_000).toISOString() },
    ],
    reviews: [],
    current_reviews: [],
    subtasks: [],
    blocking: 1,
  };
  const task = { id: 28, title: 'RN 黑五方案对比', detail: '讨论各档位性价比。', status: 'in_progress', type: 'debate', created_by: 'Owner', plan: workflow.plan };
  const json = data => ({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('https://media.example.test/**', route => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#a8c7b3"/></svg>',
  }));
  await page.route('**/api/**', route => {
    const path = route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path === '/api/auth/me') return route.fulfill(json({ user: { id: 1, name: 'Owner', role: 'admin' } }));
    if (path === '/api/tasks') return route.fulfill(json({ tasks: [task], decisions: [] }));
    if (path === '/api/tasks/28') return route.fulfill(json({ task, plan: workflow.plan, workflow, debate, challenges: [], supplements: [], verify_readiness: { ready: false, checks: [] } }));
    return route.fulfill(json({ channels: [], messages: [], agents: [], accounts: [], highlights: [], decisions: [], markdown: '指南' }));
  });

  await page.goto('http://127.0.0.1:8765/');
  await page.locator('#navTasks').click();
  await page.locator('#taskList .task-item').first().click();
  await page.locator('#taskDetail').getByRole('tab', { name: /^讨论/ }).click();
  const msg391 = page.locator('#debate-391');
  await msg391.waitFor();

  // Semantic stance classes on bubbles/tags
  if (!await page.locator('#debate-389 .conversation-tag.stance-rebut').count()) throw Error('反驳立场未使用语义配色标签');
  if (!await page.locator('#debate-391 .conversation-tag.stance-support').count()) throw Error('支持立场未使用语义配色标签');

  // Check exact linkification: #387, #383, #383, #387, #389, 问题 #19; code/hex/#999/URL excluded!
  const refs = msg391.locator('.inline-floor-ref');
  const texts = await refs.allTextContents();
  if (texts.join(',') !== '#387,#383,#383,#387,#389,问题 #19') throw Error(`Unexpected inline floor refs: ${texts.join(',')}`);
  if (await msg391.locator('code .inline-floor-ref').count()) throw Error('Code block was wrongly linkified');
  if (await msg391.locator('.inline-floor-ref', { hasText: '#999' }).count()) throw Error('Non-existent floor #999 was wrongly linkified');

  // Desktop hover preview on #387 shows rich Markdown (table + bold)
  const ref387 = refs.first();
  await ref387.hover();
  const pop = page.locator('#floorRefPopover');
  await pop.waitFor({ state: 'visible' });
  await pop.getByText('Muse Beta').waitFor();
  if (!await pop.locator('table').count() || !await pop.locator('strong', { hasText: '$11.19/GB' }).count()) {
    throw Error('Hover popover did not render rich Markdown table/bold');
  }
  await page.screenshot({ path: '.playwright-cli/floor-refs-desktop-hover.png' });

  // Verify XSS safety on hovering #383 and callout rendering
  await refs.nth(1).hover();
  await pop.getByText('<script>alert(1)</script>', { exact: false }).waitFor();
  if (!await pop.locator('.markdown-callout-tip').count()) throw Error('Hover popover did not render callout');
  if (await pop.locator('script').count()) throw Error('Popover executed unsafe script tag');

  // Verify #383 is initially hidden (pagination), then CLICK #383 opens Reference Reader Modal in place!
  const hidden383Before = await page.locator('#debate-383').isHidden();
  if (!hidden383Before) throw Error('#383 should initially be behind older conversation pagination');
  await refs.nth(1).click();
  const modal = page.locator('#floorRefModal');
  await modal.waitFor({ state: 'visible' });
  await modal.getByText('引用内容 · 发言 #383').waitFor();
  if (!await modal.locator('.markdown-callout-tip').count()) throw Error('Reference modal missing callout rendering');
  if (!await modal.getByText('收到 1 条直接回复', { exact: false }).count()) throw Error('Reference modal missing direct replies context');
  await page.screenshot({ path: '.playwright-cli/floor-refs-modal-desktop.png' });

  // Drill down inside modal from #383 -> nested #387, test lightbox zoom on inline image, then navigate back to #383!
  await modal.locator('.floor-modal-markdown .inline-floor-ref', { hasText: '#387' }).click();
  await modal.getByText('引用内容 · 发言 #387').waitFor();
  await modal.getByRole('button', { name: '← 返回 发言 #383' }).waitFor();
  await modal.locator('.floor-modal-markdown .markdown-image img.is-zoomable').click();
  const fileModal = page.locator('#filePreviewModal');
  await fileModal.waitFor({ state: 'visible' });
  await fileModal.getByRole('button', { name: '关闭' }).click();
  await fileModal.waitFor({ state: 'hidden' });
  await modal.waitFor({ state: 'visible' });
  await modal.getByRole('button', { name: '← 返回 发言 #383' }).click();
  await modal.getByText('引用内容 · 发言 #383').waitFor();

  // From modal, click "定位到原楼层 #383 →" to jump, reveal hidden floor, flash it, and show return pill!
  await modal.getByRole('button', { name: '定位到原楼层 #383 →' }).click();
  await modal.waitFor({ state: 'hidden' });
  await page.locator('#debate-383').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('debate-383')?.classList.contains('flash'));

  const returnPill = page.locator('#floorReturnPill');
  await returnPill.waitFor({ state: 'visible' });
  await returnPill.getByRole('button', { name: '← 返回发言 #391' }).click();
  await page.waitForFunction(() => document.getElementById('debate-391')?.classList.contains('flash'));
  await returnPill.waitFor({ state: 'hidden' });

  // Clicking top reply-reference on #391 opens Reference Modal for #389 (with callout + nested 问题 #19 drill-down!)
  await msg391.locator('.reply-reference').click();
  await modal.waitFor({ state: 'visible' });
  await modal.getByText('引用内容 · 发言 #389').waitFor();
  await modal.locator('.floor-modal-markdown .inline-floor-ref', { hasText: '问题 #19' }).click();
  await modal.getByText('引用内容 · 问题 #19').waitFor();
  await modal.getByText('实测黑五帖仅列', { exact: false }).waitFor();
  await modal.getByRole('button', { name: '前往核查页 →' }).click();
  await modal.waitFor({ state: 'hidden' });
  await page.locator('#issue-19').waitFor({ state: 'visible' });

  // Cross-tab inline ref check on Outcome tab (#387 & 问题 #19)
  await page.locator('#taskDetail').getByRole('tab', { name: '成果', exact: true }).click();
  const outcomeRef = page.locator('#detailPanel-outcome .inline-floor-ref', { hasText: '问题 #19' });
  await outcomeRef.click();
  await modal.waitFor({ state: 'visible' });
  await modal.getByText('引用内容 · 问题 #19').waitFor();
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });

  // Mobile modal check (390px) & zero horizontal overflow
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#taskDetail').getByRole('tab', { name: /^讨论/ }).click();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile conversation overflows with floor refs');
  await refs.nth(4).click();
  await modal.waitFor({ state: 'visible' });
  await modal.getByText('引用内容 · 发言 #389').waitFor();
  await page.screenshot({ path: '.playwright-cli/floor-refs-mobile-modal.png' });
  await modal.getByRole('button', { name: '定位到原楼层 #389 →' }).click();
  await modal.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('debate-389')?.classList.contains('flash'));

  if (errors.length) throw Error(errors.join('\n'));
  return { matchedRefs: texts, referenceModal: 'passed', drillDownStack: 'passed', imageLightbox: 'passed', crossTabIssueRef: 'passed', hiddenFloorRevealed: true, desktopHover: 'passed', returnPill: 'passed', mobileModal: 'passed', xssSafe: true };
}
