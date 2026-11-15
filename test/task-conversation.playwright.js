async page => {
  const task = { id: 5, title: "讨论秋天", status: "review", type: "debate", created_by: "管理员" };
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
  await page.locator("#taskList .task-item").first().click();
  const thread = page.locator("#taskDetail .conversation");
  await thread.locator(".conversation-message").first().waitFor({ timeout: 3000 });
  const order = await thread.locator(".conversation-message").evaluateAll(nodes => nodes.map(n => `${n.dataset.kind}:${n.dataset.debateId || n.querySelector('.conversation-speaker')?.textContent}`));
  const expected = ["debate:11", "challenge:质疑 Agent", "debate:12", "supplement:补充 Agent", `debate:14`, "debate:13", "debate:15"];
  if (order.join("|") !== expected.join("|")) throw Error(`对话没有按时间顺序排列：${order}`);
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
  await thread.locator('.link-card[href="https://example.com/evidence"]').waitFor({ timeout: 3000 });
  if (!await thread.locator('.plain-link[href="https://example.com/source"]').count()) throw Error("对话里的来源链接丢失");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("对话在手机宽度出现水平滚动");
  await page.locator("#taskList .task-item").nth(1).click();
  await page.locator("#taskDetail h3").getByText("空对话").waitFor();
  if (!await page.locator("#taskDetail .conversation-empty").count()) throw Error("没有发言时未显示空状态");
  return { conversation: "passed", quotedAgent: "passed", safeMarkup: "passed", mobileWidth: "passed" };
}
