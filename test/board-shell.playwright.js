async page => {
  // 主流程：默认聚焦任务、成果入口、文字/报告成果、引用跳转、次要视图、手机宽度与键盘。
  const json = value => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  const report = { url: "https://example.com/report", title: "秋季市场报告", revision: "v2", published_at: "2026-11-17T09:00:00Z" };
  const plan = { goal: "analysis", collaboration: "hosted", acceptance: { criteria: "结论有据，页面可读", min_sources: 1, independent_review: true, opposing_views: false }, schedule: { kind: "once", start_at: null }, delivery: { format: "web_report", author_id: 3 }, revision: 2, configured: true };
  const tasks = [
    { id: 9, title: "市场报告：秋季趋势", status: "review", type: "data", goal: "analysis", created_by: "Owner", claimed_by: "Writer", report },
    { id: 8, title: "诗句整理", status: "done", type: "creative", created_by: "LV", result_summary: "已整理 20 句秋天的诗，来源 https://example.com/poem", result_links: "https://example.com/poem" },
    { id: 7, title: "待认领：整理资料", status: "open", type: "research", created_by: "Owner", collaboration: { help_wanted: true, suggested_action: "claim", reason: "尚无人认领" } },
    { id: 6, title: "空成果任务", status: "done", type: "research", created_by: "Owner" },
  ];
  const outcome = { id: 1, author_id: 3, author: "Writer", summary: "秋季需求上升，价格与库存是主要风险。", links: "https://source.example.com/official", changes: "补充了库存风险", source_refs: [], report, created_at: "2026-11-17T09:10:00Z" };
  const workflow = { enabled: true, plan, host_id: 2, host: "Host", report_author_id: 3, report_author: "Writer", acceptance: plan.acceptance.criteria, min_sources: 1, fingerprint: "fp-1", author_ids: [2, 3], blocking: 1, issues: [{ id: 1, text: "日期需要修正", severity: "blocking", state: "open", revision: 0, author: "Checker" }], subtasks: [], outcomes: [outcome], reviews: [{ reviewer: "Checker", fingerprint: "fp-1", note: "已对照官方来源", evidence: "https://source.example.com/official" }], current_reviews: [{ reviewer: "Checker" }] };
  const debate = [
    { id: 11, agent: "Agent A", role: "agent", stance: "支持", content: "结论与官方数据一致", created_at: "2026-11-15T10:00:00Z" },
    { id: 12, agent: "Agent B", role: "agent", stance: "反驳", reply_to: 11, content: "库存数据的时间窗口偏短", created_at: "2026-11-15T10:02:00Z" },
  ];
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path === "/api/auth/me") return route.fulfill(json({ user: { id: 1, name: "管理员", role: "admin" } }));
    if (path === "/api/channels") return route.fulfill(json({ channels: [{ id: 1, name: "市场观察" }, { id: 2, name: "工具" }] }));
    if (path === "/api/tasks") return route.fulfill(json({ tasks }));
    if (path === "/api/tasks/9") return route.fulfill(json({
      task: tasks[0], plan, workflow, debate,
      challenges: [{ id: 11, agent: "质疑 Agent", reason: "请检查证据", evidence: "https://example.com/challenge", created_at: "2026-11-15T10:01:00Z" }],
      supplements: [{ id: 11, agent: "补充 Agent", version: 2, summary: "后来补充了材料", created_at: "2026-11-15T10:03:00Z" }],
      verify_readiness: { ready: false, checks: [{ key: "issues", label: "重要问题已解决", met: false, detail: "还有 1 项重要问题待处理" }] },
    }));
    if (path === "/api/tasks/8") return route.fulfill(json({ task: tasks[1], debate: [], challenges: [], supplements: [], verify_readiness: { ready: true, checks: [] } }));
    if (path === "/api/tasks/6") return route.fulfill(json({ task: tasks[3], debate: [], challenges: [], supplements: [], verify_readiness: { ready: true, checks: [] } }));
    if (path === "/api/tasks/7") return route.fulfill(json({ task: tasks[2], collaboration: tasks[2].collaboration, debate: [], challenges: [], supplements: [], verify_readiness: { ready: false, checks: [] } }));
    if (path === "/api/messages") return route.fulfill(json({ messages: [{ author: "LV", role: "human", text: "报告已更新", created_at: "2026-11-17T08:00:00Z" }] }));
    if (path === "/api/leaderboard") return route.fulfill(json({ leaderboard: [{ agent: "Agent A", points: 12 }] }));
    if (path === "/api/participants") return route.fulfill(json({ agents: [{ id: 2, name: "Host" }, { id: 3, name: "Writer" }] }));
    if (path === "/api/digest") return route.fulfill(json({ highlights: [{ task_id: 9, title: "成果更新", text: "Writer 发布了 v2 报告" }], decisions: [{ task_id: 9, title: tasks[0].title, status: "review" }] }));
    if (path === "/api/inbox") return route.fulfill(json({ items: [], waiting: [] }));
    if (path === "/api/topics") return route.fulfill(json({ themes: [{ id: "tech", name: "科技" }], topics: [{ id: 1, theme: "tech", author: "Host", title: "核对方式", content: "讨论工具", replies: 2 }] }));
    if (path === "/api/topics/1") return route.fulfill(json({ topic: { id: 1, title: "核对方式", author: "Host", content: "讨论工具" }, replies: [{ id: 1, author: "Worker", content: "可以先做小样", reply_to: null }, { id: 2, author: "Checker", content: "同意，先做小样再核对", reply_to: 1 }, { id: 3, author: "Host", content: "引用已经不存在", reply_to: 99 }], proposals: [] }));
    if (path === "/api/agent-guide") return route.fulfill(json({ ok: true, version: "v1", instructions: "先处理已接单工作。", markdown: "# 指南", bootstrap: "每轮先读取 /api/agent-guide" }));
    if (path === "/api/admin/users" || path === "/api/admin/agents") return route.fulfill(json({ accounts: [] }));
    if (path === "/api/link-preview") return route.fulfill(json({ ok: true, domain: "example.com", title: "示例来源" }));
    if (path.endsWith("/contributions")) return route.fulfill(json({ contributions: [] }));
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `unmocked ${path}` }) });
  });

  await page.goto("http://127.0.0.1:8765/");
  await page.waitForURL('**/#home');

  // --- 默认工作台，任务与成果分别阅读 ---
  const nav = page.locator(".primary-nav");
  if (!await page.locator("#viewHome").isVisible() || await page.locator("#viewTasks").isVisible()) throw Error("默认没有进入工作台");
  if (await nav.getByRole("tab").count() !== 4) throw Error("主导航应只有四个一级入口");
  if (await page.locator('#navHome').getAttribute("aria-selected") !== "true") throw Error("默认选中项不是工作台");
  if (await nav.getByRole("tab", { name: "成果" }).getAttribute("aria-selected") !== "false") throw Error("默认同时选中了成果");
  if (await page.locator("#createTaskBox").evaluate(node => node.open) || await page.locator("#taskForm").isVisible()) throw Error("发布任务表单默认不应展开");
  if (await page.locator("#createChannelBox").evaluate(node => node.open)) throw Error("新建频道表单默认不应展开");

  await page.locator('#navTasks').click();
  await page.locator("#taskList .task-item").first().click();
  await page.locator("#taskDetail h3").waitFor();
  if (!await page.locator('#detailPanel-overview').isVisible()) throw Error('任务入口未打开概览');
  if (await page.locator("#taskDetail .detail-tab[aria-controls]").count() !== 4) throw Error("缺少四个详情分区");
  await page.locator('#taskDetail').getByRole('tab',{name:'成果',exact:true}).click();
  const block = page.locator("#detailPanel-outcome .outcome-block");
  const tabs = page.locator("#taskDetail .detail-tabs");
  const box = await block.boundingBox(), bar = await tabs.boundingBox();
  if (!box || !bar || box.y < bar.y) throw Error("长成果仍排在详情页签之前");
  if (!await block.getByText("秋季需求上升", { exact: false }).count()) throw Error("详情没有先呈现当前结论");
  if (!await block.getByText("当前版本已独立核查").count()) throw Error("详情缺少核查状态");
  if (!await block.getByText("作者 Writer", { exact: false }).count()) throw Error("详情缺少成果作者");
  const reportLink = block.locator(".published-report");
  if (await reportLink.getAttribute("href") !== "https://example.com/report") throw Error("详情缺少登记报告链接");
  if (await reportLink.getAttribute("rel") !== "noopener noreferrer") throw Error("报告链接缺少安全属性");
  if (!await block.getByText("报告 v2").count()) throw Error("详情缺少报告版本");
  await page.locator('#taskDetail').getByRole('tab',{name:/^讨论/}).click();

  // --- 引用关联与跳转 ---
  const quote = page.locator("#debate-12 .reply-reference");
  if (await quote.getAttribute("href") !== "#debate-11") throw Error("回复没有指向原发言");
  if (!await quote.getByText("Agent A", { exact: false }).count() || !await quote.getByText("结论与官方数据一致", { exact: false }).count()) throw Error("引用卡缺少作者或原话摘要");
  if (await page.locator("#debate-11").count() !== 1) throw Error("不同记录类型的相同 ID 被错误合并");
  if (await page.locator('#taskDetail [data-kind="challenge"][data-debate-id]').count()) throw Error("质疑记录冒用了辩论 ID");
  await quote.click();
  await page.waitForFunction(() => document.getElementById("debate-11")?.classList.contains("flash"));
  await page.waitForFunction(() => !document.getElementById("debate-11")?.classList.contains("flash"), null, { timeout: 4000 });
  await page.locator("#debate-11").getByRole("button", { name: "回复 Agent A" }).click();
  const replySelect = page.locator('#debateForm select[name="reply_to"]');
  if (await replySelect.inputValue() !== "11") throw Error("发言旁的回复按钮没有带入引用");
  if (!await page.locator("#debateForm .reply-preview").getByText("Agent A", { exact: false }).count()) throw Error("回复预览没有显示引用对象");
  await replySelect.selectOption("");
  if (await page.locator("#debateForm .reply-preview").isVisible()) throw Error("取消引用后预览没有消失");

  // --- 成果入口：待核对 / 已完成 / 文字成果 / 空状态 ---
  await nav.getByRole("tab", { name: "成果" }).click();
  if (!await page.locator("#viewOutcomes").isVisible() || await page.locator("#viewTasks").isVisible()) throw Error("成果入口没有切换视图");
  await page.locator("#outcomeListReview .outcome-item").first().waitFor();
  if (await page.locator("#outcomeReviewCount").textContent() !== "1" || await page.locator("#outcomeDoneCount").textContent() !== "2") throw Error("成果没有区分待核对与已完成");
  if (!await page.locator("#outcomeListReview").getByText("待核对", { exact: false }).count()) throw Error("待核对分组缺少状态标记");
  await page.locator("#outcomeListReview .outcome-item").first().click();
  const reader = page.locator("#outcomeDetail");
  await reader.locator("h3").getByText("市场报告：秋季趋势").waitFor();
  if (!await reader.getByText("秋季需求上升", { exact: false }).count()) throw Error("成果阅读区没有正文");
  if (await reader.locator(".published-report").getAttribute("href") !== "https://example.com/report") throw Error("成果阅读区缺少报告链接");
  await page.locator("#outcomeDetail").getByRole("button", { name: "打开任务详情" }).click();
  if (!await page.locator("#viewTasks").isVisible()) throw Error("成果没有回到任务详情");
  if (!await page.locator("#taskDetail h3").getByText("市场报告：秋季趋势").count()) throw Error("成果跳转没有选中原任务");

  await nav.getByRole("tab", { name: "成果" }).click();
  const doneItems = page.locator("#outcomeListDone .outcome-item");
  await doneItems.first().waitFor();
  await doneItems.filter({ hasText: "诗句整理" }).click();
  await page.locator("#outcomeDetail h3").getByText("诗句整理").waitFor();
  if (!await page.locator("#outcomeDetail").getByText("已整理 20 句", { exact: false }).count()) throw Error("文字成果无法阅读");
  if (await page.locator("#outcomeDetail .published-report").count()) throw Error("旧任务的来源链接被当成了发布报告");
  if (!await page.locator('#outcomeDetail a[href="https://example.com/poem"]').count()) throw Error("文字成果的来源链接丢失");
  await doneItems.filter({ hasText: "空成果任务" }).click();
  await page.locator("#outcomeDetail h3").getByText("空成果任务").waitFor();
  if (!await page.locator("#outcomeDetail .outcome-empty").count()) throw Error("没有成果时缺少空状态");
  if (await page.locator("#outcomeDetail .outcome-summary").count() || await page.locator("#outcomeDetail .published-report").count()) throw Error("空成果被捏造了总结或报告");

  // --- 交流与按需打开的工具 ---
  await nav.getByRole("tab", { name: "交流" }).click();
  await page.locator("#topicList button").first().click();
  await page.locator("#topicDetail h3").waitFor();
  const topicQuote = page.locator("#topic-reply-2 .reply-reference");
  if (await topicQuote.getAttribute("href") !== "#topic-reply-1") throw Error("主题回复没有引用卡");
  if (!await page.locator("#topic-reply-3 .reply-reference.is-missing").count()) throw Error("坏引用没有降级提示");
  await topicQuote.click();
  await page.waitForFunction(() => document.getElementById("topic-reply-1")?.classList.contains("flash"));
  await page.locator("#topic-reply-1").getByRole("button", { name: "回复 Worker" }).click();
  if (await page.locator('.topic-reply-form select[name="reply_to"]').inputValue() !== "1") throw Error("主题回复按钮没有带入引用");
  if (!await page.locator("#messages .entry").count()) throw Error("频道讨论没有内容");
  await page.locator('#workspaceMenu > summary').click();
  await page.locator('#accountsMenu').click();
  if (!await page.locator("#adminPanel").isVisible()) throw Error("管理员看不到成员与 Agent 管理");
  await page.locator('#settings-ranking').click();
  if (!await page.locator("#leaderboard .entry").count()) throw Error("协作积分没有渲染");
  await page.locator('#settings-guide').click();
  if (!await page.locator("#agentGuide .guide-current").count()) throw Error("工作指南没有渲染");
  if (await page.locator("#adminPanel").isVisible()) throw Error('工具模块没有分开显示');
  if (await page.locator("#taskList").isVisible()) throw Error("次要视图仍显示任务主面板");
  // 从次要视图点进任务，应回到任务视图并选中该任务。
  await page.locator('#navHome').click();
  await page.locator("#dailyHighlights .workbench-item").first().click();
  await page.locator('#outcomeDetail').getByRole('button',{name:'打开任务详情'}).click();
  await page.locator("#taskDetail h3").getByText("市场报告：秋季趋势").waitFor();
  if (!await page.locator("#viewTasks").isVisible()) throw Error("从今日重点进入任务没有回到任务视图");
  await page.locator('#navHome').click();

  // --- 键盘切换与选中的 aria ---
  await page.locator(".primary-nav").getByRole("tab", { name: "任务" }).focus();
  await page.keyboard.press("ArrowRight");
  if (await page.locator(".primary-nav").getByRole("tab", { name: "成果" }).getAttribute("aria-selected") !== "true") throw Error("方向键没有切换主导航");
  if (!await page.locator("#viewOutcomes").isVisible()) throw Error("键盘切换后视图没有更新");
  if (await page.locator(".primary-nav").getByRole("tab", { name: "任务" }).getAttribute("aria-selected") !== "false") throw Error("旧入口仍标记为选中");

  // --- 手机宽度 ---
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["工作台", "任务", "成果", "交流"]) {
    await page.locator(".primary-nav").getByRole("tab", { name }).click();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(`手机宽度下「${name}」出现横向溢出`);
  }
  await page.screenshot({ path: ".playwright-cli/board-shell-mobile.png", fullPage: true });
  return { defaultFocus: "passed", outcomeEntry: "passed", textAndReport: "passed", quoteJump: "passed", secondaryViews: "passed", keyboard: "passed", mobile: "passed" };
}
