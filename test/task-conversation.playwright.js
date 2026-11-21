async page => {
  const task = {
    id: 5,
    title: "讨论秋天",
    detail: "## 讨论议题\n\n- (a) 每天一次心跳\n- (b) 跨阈值触发\n\n<script>alert(1)</script>",
    status: "review",
    type: "debate",
    created_by: "管理员",
    created_at: "2026-11-15T09:00:00Z",
  };
  const longName = "Agent " + "長名字".repeat(32);
  const debate = [
    { id: 11, agent: "Agent A", role: "agent", stance: "支持", content: "第一条观点，引用 https://example.com/source", created_at: "2026-11-15T10:00:00Z" },
    { id: 12, agent: "<img src=x onerror=alert(1)> Agent", role: "agent", stance: "反駁", reply_to: 11, content: "不同意 <script>alert(1)</script>", links: "https://example.com/evidence", created_at: "2026-11-15T10:02:00Z" },
    { id: 14, agent: longName, role: "agent", stance: "補充", reply_to: 999, content: "无法找到原文", created_at: "2026-11-15T10:04:00Z" },
    { id: 13, agent: "人类成员", role: "human", stance: "補充", reply_to: 12, content: "稍后补充", created_at: null },
    { id: 15, agent: "Agent D", role: "agent", stance: "支持", reply_to: "bad-id", content: "坏引用", created_at: "invalid" },
  ];
  const challenges = [{ id: 11, agent: "质疑 Agent", reason: "请检查证据", evidence: "https://example.com/challenge", created_at: "2026-11-15T10:01:00Z" }];
  const supplements = [{ id: 11, agent: "补充 Agent", version: 2, summary: "后来补充了材料", links: "https://example.com/supplement", created_at: "2026-11-15T10:03:00Z" }];
  let role = "admin", submitted = null;
  const json = data => ({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path === "/api/auth/me") return route.fulfill(json({ user: { id: 1, name: "管理员", role } }));
    if (path === "/api/channels") return route.fulfill(json({ channels: [] }));
    if (path === "/api/tasks" && request.method() === "GET") return route.fulfill(json({ tasks: [task, { id: 6, title: "空对话", status: "open" }] }));
    if (path === "/api/messages") return route.fulfill(json({ messages: [] }));
    if (path === "/api/leaderboard") return route.fulfill(json({ leaderboard: [] }));
    if (path === "/api/admin/users" || path === "/api/admin/agents") return route.fulfill(json({ accounts: [] }));
    if (path === "/api/link-preview") return route.fulfill(json({ ok: true, title: "证据预览", domain: "example.com" }));
    if (path === "/api/tasks/5" && request.method() === "GET") return route.fulfill(json({ task, debate, challenges, supplements, verify_readiness: { ready: false, checks: [] } }));
    if (path === "/api/tasks/6") return route.fulfill(json({ task: { id: 6, title: "空对话", status: "open" }, debate: [], challenges: [], supplements: [], verify_readiness: { ready: false, checks: [] } }));
    if (path === "/api/tasks/5/debate" && request.method() === "POST") {
      submitted = JSON.parse(request.postData());
      debate.push({ id: 16, agent: "管理员", role: "human", stance: submitted.stance, content: submitted.content, reply_to: submitted.reply_to, created_at: "2026-11-15T10:05:00Z" });
      return route.fulfill(json({ ok: true }));
    }
    return route.fulfill({ status: 404, body: `unmocked ${path}` });
  });
  await page.goto("http://127.0.0.1:8765/");
  await page.evaluate(() => localStorage.removeItem('whiteboard.conversationSort.1'));
  await page.reload();
  await page.locator('#navTasks').click();
  await page.locator("#taskList .task-item").first().click();
  await page.locator('#taskDetail').getByRole('tab',{name:/^讨论/}).click();
  const topic = page.locator("#detailPanel-conversation .conversation-topic");
  await topic.waitFor({ timeout: 3000 });
  if (await topic.getAttribute("open") === null) throw Error("讨论页初始主题默认未展开");
  if (!await topic.locator(".conversation-topic-badge").getByText("初始主题").count()) throw Error("讨论页初始主题缺少标识");
  if (!await topic.locator(".conversation-topic-title").getByText("讨论秋天").count()) throw Error("讨论页初始主题缺少标题");
  if (!await topic.locator(".conversation-topic-meta").getByText("发起：管理员", { exact: false }).count()) throw Error("讨论页初始主题缺少发起人");
  if (!await topic.locator(".conversation-topic-content h2").getByText("讨论议题").count() || !await topic.locator(".conversation-topic-content li").filter({ hasText: "(b) 跨阈值触发" }).count()) throw Error("讨论页初始主题未渲染完整 Markdown");
  if (await topic.locator("script").count()) throw Error("讨论页初始主题未过滤危险脚本");
  if (await topic.locator(".conversation-topic-toggle").textContent() !== "收起主题") throw Error("展开时切换文案错误");
  await topic.locator(".conversation-topic-summary").click();
  await topic.locator(".conversation-topic-toggle").getByText("展开主题").waitFor({ timeout: 3000 });
  if (await topic.getAttribute("open") !== null) throw Error("讨论页初始主题无法收起");
  await topic.locator(".conversation-topic-summary").click();
  await topic.locator(".conversation-topic-toggle").getByText("收起主题").waitFor({ timeout: 3000 });
  if (await topic.getAttribute("open") === null) throw Error("讨论页初始主题无法重新展开");
  const thread = page.locator("#taskDetail .conversation");
  await thread.locator(".conversation-message").first().waitFor({ timeout: 3000 });
  const order = await thread.locator(".conversation-message").evaluateAll(nodes => nodes.map(n => `${n.dataset.kind}:${n.dataset.debateId || n.querySelector('.conversation-speaker')?.textContent}`));
  const expected = [`debate:14`, "supplement:补充 Agent", "debate:12", "challenge:质疑 Agent", "debate:11", "debate:13", "debate:15"];
  if (order.join("|") !== expected.join("|")) throw Error(`对话默认没有最新在前：${order}`);
  await page.locator('#taskDetail .conversation-sort').selectOption('asc');
  const ascending = await thread.locator(".conversation-message").evaluateAll(nodes => nodes.map(n => `${n.dataset.kind}:${n.dataset.debateId || n.querySelector('.conversation-speaker')?.textContent}`));
  if (ascending.join('|') !== ["debate:11", "challenge:质疑 Agent", "debate:12", "supplement:补充 Agent", `debate:14`, "debate:13", "debate:15"].join('|')) throw Error(`切换正序后顺序错误：${ascending}`);
  await page.locator('#taskDetail .conversation-sort').selectOption('desc');
  const reply = thread.locator("#debate-12 .reply-reference");
  if (await reply.getAttribute("href") !== "#debate-11" || !await reply.getByText("Agent A", { exact: false }).count() || !await reply.getByText("第一条观点", { exact: false }).count()) throw Error("回覆没有标示被引用的 Agent 和原话");
  if (await thread.locator('[data-kind="challenge"][data-debate-id], [data-kind="supplement"][data-debate-id]').count()) throw Error("非辩论记录冒用辩论 ID");
  if (await thread.locator("#debate-11").count() !== 1) throw Error("重复编号导致引用到其他类型的记录");
  for (const id of [14, 15]) {
    const missing = thread.locator(`#debate-${id} .reply-reference`);
    if (await missing.count() !== 1 || await missing.getAttribute("href") || !await missing.getByText("原发言不可见", { exact: false }).count()) throw Error("失效引用错误地归到其他 Agent");
  }
  if (!await thread.locator("#debate-12 .conversation-speaker").getByText("<img src=x onerror=alert(1)> Agent").count()) throw Error("名字被错误解析");
  if (!await thread.locator("#debate-12").getByText("不同意 <script>alert(1)</script>").count() || await thread.locator("img,script").count()) throw Error("不可信内容被当成 HTML 执行");
  if (!await thread.getByText("v2", { exact: false }).count() || !await thread.getByText("质疑", { exact: false }).count()) throw Error("质疑或补充类型没有标示");
  if (!await thread.locator("#debate-12 .conversation-source-label").getByText("证据").count() || !await thread.locator('[data-kind="supplement"] .conversation-source-label').getByText("来源").count()) throw Error("对话里的证据和来源没有标示");
  const sources=thread.locator('#debate-12 .source-fold');
  if(await sources.getAttribute('open')!==null) throw Error('证据来源没有折叠');
  await sources.locator('summary').click();
  await sources.locator('.plain-link[href="https://example.com/evidence"]').waitFor({ timeout: 3000 });
  if (!await thread.locator('.plain-link[href="https://example.com/source"]').count()) throw Error("对话里的来源链接丢失");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("对话在手机宽度出现水平滚动");
  await page.locator('#taskBack').click();
  await page.locator("#taskList .task-item").nth(1).click();
  await page.locator('#taskDetail').getByRole('tab',{name:/^讨论/}).click();
  await page.locator("#taskDetail h3").getByText("空对话").waitFor();
  if (await page.locator("#detailPanel-conversation .conversation-topic").count()) throw Error("无任务说明时不应显示初始主题卡片");
  if (!await page.locator("#taskDetail .conversation-empty").count()) throw Error("没有发言时未显示空状态");
  await page.locator('#taskBack').click();
  await page.locator("#taskList .task-item").first().click();
  await page.locator('#taskDetail').getByRole('tab',{name:/^讨论/}).click();
  await page.locator("#debate-11").waitFor();
  const select = page.locator('#debateForm select[name="reply_to"]');
  const preview = page.locator("#debateForm .reply-preview");
  await select.selectOption("12");
  if (!await preview.getByText("<img src=x onerror=alert(1)> Agent", { exact: false }).count() || !await preview.getByText("不同意 <script>alert(1)</script>", { exact: false }).count() || await preview.getAttribute("role") !== "status") throw Error("选择回复对象后没有显示安全的引用预览");
  await select.selectOption("");
  if (await preview.isVisible()) throw Error("取消引用后预览仍显示");
  await page.locator("#debate-11").getByRole("button", { name: "回复 Agent A" }).click({ timeout: 3000 });
  if (await select.inputValue() !== "11" || !await preview.getByText("Agent A", { exact: false }).count() || !await preview.getByText("第一条观点", { exact: false }).count()) throw Error("发言旁的回复按钮没有选中对应 Agent");
  await page.locator('#debateForm select[name="stance"]').selectOption("补充");
  await page.locator('#debateForm textarea[name="content"]').fill("新的回复");
  await page.locator("#detailPanel-conversation .conversation-topic-summary").click();
  if (await page.locator("#detailPanel-conversation .conversation-topic").getAttribute("open") !== null) throw Error("发帖前未能收起初始主题");
  await page.locator("#debateForm").getByRole("button", { name: "发表观点" }).click();
  await page.locator("#debate-16 .reply-reference").getByText("Agent A", { exact: false }).waitFor();
  if (await page.locator("#detailPanel-conversation .conversation-topic").getAttribute("open") !== null) throw Error("刷新讨论后意外重新展开了已收起的初始主题");
  if (submitted?.reply_to !== 11 || submitted?.content !== "新的回复" || submitted?.stance !== "补充") throw Error("发表回复没有带正确的 reply_to");
  role = "viewer";
  await page.reload();
  await page.locator('#navTasks').click();
  await page.locator("#taskList .task-item").first().click();
  await page.locator('#taskDetail').getByRole('tab',{name:/^讨论/}).click();
  await page.locator("#debate-11").waitFor();
  if (await page.locator("#debateForm, #taskDetail .conversation-message .text-button").count()) throw Error("只读成员看到回复入口");
  return { conversation: "passed", quotedAgent: "passed", safeMarkup: "passed", mobileWidth: "passed", replySelection: "passed", postedReply: submitted.reply_to, viewer: "passed" };
}
