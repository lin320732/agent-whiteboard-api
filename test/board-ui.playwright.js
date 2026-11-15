async page => {
  const tasks = [
    { id: 5, title: "描写秋天的诗句", type: "creative", status: "review", result_summary: "一首秋天的诗", result_links: "诗文 https://example.com/poem.\n失败 https://example.com/fail\n断线 https://example.com/down", created_by: "LV" },
    { id: 6, title: "旧任务", status: "open", created_by: "LV" },
  ];
  let created;
  const previewCalls = {};
  const json = value => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path === "/api/auth/me") return route.fulfill(json({ user: { id: 1, name: "管理员", role: "admin" } }));
    if (path === "/api/channels") return route.fulfill(json({ channels: [{ id: 1, name: "测试频道" }] }));
    if (path === "/api/messages") return route.fulfill(json({ messages: [{ author: "LV", role: "human", text: "讨论参考 https://example.com/poem" }] }));
    if (path === "/api/link-preview") {
      const target = decodeURIComponent(request.url().split("url=")[1] || "");
      previewCalls[target] = (previewCalls[target] || 0) + 1;
      if (target.endsWith("/down")) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "暂时无法预览" }) });
      if (target.endsWith("/fail")) return route.fulfill(json({ ok: false, url: target, error: "无法连接" }));
      return route.fulfill(json({ ok: true, url: target, domain: "example.com", title: target.endsWith("/poem") ? "<img src=x onerror=alert(1)> 詩歌來源" : "證據來源", description: "页面简介 <script>alert(1)</script>" }));
    }
    if (path === "/api/leaderboard") return route.fulfill(json({ leaderboard: [] }));
    if (path === "/api/admin/users" || path === "/api/admin/agents") return route.fulfill(json({ accounts: [] }));
    if (path === "/api/tasks" && request.method() === "POST") {
      created = JSON.parse(request.postData());
      tasks.push({ id: 7, title: created.title, type: created.type, status: "open", created_by: "管理员" });
      return route.fulfill(json({ id: 7, ok: true }));
    }
    if (path === "/api/tasks") return route.fulfill(json({ tasks }));
    if (path === "/api/tasks/5") return route.fulfill(json({
      task: tasks[0], debate: [{ agent: "Agent A", stance: "支持", content: "观点", links: "https://example.com/evidence" }],
      challenges: [{ agent: "Agent B", reason: "核对", evidence: "https://example.com/evidence" }],
      supplements: [{ agent: "Agent C", version: 2, summary: "补证据", links: "https://example.com/evidence" }],
      verify_readiness: { ready: true, checks: [
        { key: "result", label: "结果已提交", met: true, detail: "结果已提交" },
        { key: "links", label: "来源链接", met: true, na: true, detail: "创意类不适用" },
      ] },
    }));
    if (path === "/api/tasks/6" || path === "/api/tasks/7") return route.fulfill(json({ task: tasks.find(t => t.id === Number(path.slice(-1))), debate: [], verify_readiness: { ready: false, checks: [] } }));
    return route.fulfill({ status: 404, body: "missing mock" });
  });
  await page.goto("http://127.0.0.1:8765/");
  await page.locator("#taskList .task-item").first().waitFor();
  const type = page.getByLabel("任务类型");
  if (await type.inputValue() !== "research") throw Error("新任务默认类型应为调研");
  if ((await type.locator("option").evaluateAll(options => options.map(o => o.value))).join(",") !== "research,creative,debate,data") throw Error("缺少任务类型选项");
  if (!await page.locator("#taskList .task-item").first().getByText("创意").count()) throw Error("列表缺少创意类型标记");
  await page.locator("#taskList .task-item").first().click();
  await page.locator("#taskDetail h3").getByText("描写秋天的诗句").waitFor();
  if (!await page.locator("#taskDetail .task-type").getByText("创意").count()) throw Error("任务详情缺少创意类型标记");
  if (!await page.locator("#taskDetail .check.na").getByText("不适用").count()) throw Error("不适用的核对条件未标注");
  if (!await page.getByRole("button", { name: "核对通过" }).isVisible()) throw Error("创意任务未显示核对通过");
  await page.locator("#taskList .task-item").nth(1).click();
  await page.locator("#taskDetail h3").getByText("旧任务").waitFor();
  if (!await page.locator("#taskDetail .task-type").getByText("调研").count()) throw Error("旧任务应默认显示调研");
  await type.selectOption("debate");
  await page.getByLabel("标题").fill("一条辩论任务");
  await page.getByRole("button", { name: "发布到白板" }).click();
  await page.locator("#taskDetail h3").getByText("一条辩论任务").waitFor();
  if (created?.type !== "debate") throw Error(`发布请求中的类型错误：${created?.type}`);
  await page.locator("#taskList .task-item").first().click();
  await page.locator("#taskDetail .link-card").getByText("詩歌來源", { exact: false }).waitFor({ timeout: 5000 });
  if (!await page.locator("#messages .link-card").count()) throw Error("讨论链接没有卡片");
  if (!await page.locator("#taskDetail .link-card").getByText("證據來源").count()) throw Error("证据链接没有卡片");
  const source = page.locator('#taskDetail a.plain-link[href="https://example.com/poem"]');
  if (!await source.count()) throw Error("带句末标点的 URL 应留在正文作为普通链接");
  if (!await page.locator('#taskDetail a.link-card[href="https://example.com/poem"]').count()) throw Error("正文下方缺少预览卡片");
  if (!await source.evaluate(a => a.nextSibling?.textContent?.startsWith("."))) throw Error("句号应紧跟正文中的链接");
  if (await source.getAttribute("rel") !== "noopener noreferrer" || await source.getAttribute("target") !== "_blank") throw Error("外部链接缺少安全属性");
  for (const url of ["fail", "down"]) {
    const fallback = page.locator(`#taskDetail a[href="https://example.com/${url}"]`);
    if (!await fallback.count() || !await fallback.getAttribute("class").then(s => s.includes("plain-link"))) throw Error(`预览失败时 ${url} 没有普通链接`);
  }
  if (await page.locator(".link-card img, .link-card script").count()) throw Error("预览数据被插入为 HTML");
  if (previewCalls["https://example.com/poem"] !== 1) throw Error("同一 URL 应共享一次预览请求");
  return { typeSelection: "passed", createdType: created.type, linkCards: "passed", previewCalls };
}
