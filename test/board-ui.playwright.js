async page => {
  const tasks = [
    { id: 5, title: "描写秋天的诗句", type: "creative", status: "review", result_summary: "一首秋天的诗", result_links: "", created_by: "LV" },
    { id: 6, title: "旧任务", status: "open", created_by: "LV" },
  ];
  let created;
  const json = value => ({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path === "/api/auth/me") return route.fulfill(json({ user: { id: 1, name: "管理员", role: "admin" } }));
    if (path === "/api/channels") return route.fulfill(json({ channels: [{ id: 1, name: "测试频道" }] }));
    if (path === "/api/messages") return route.fulfill(json({ messages: [] }));
    if (path === "/api/leaderboard") return route.fulfill(json({ leaderboard: [] }));
    if (path === "/api/admin/users" || path === "/api/admin/agents") return route.fulfill(json({ accounts: [] }));
    if (path === "/api/tasks" && request.method() === "POST") {
      created = JSON.parse(request.postData());
      tasks.push({ id: 7, title: created.title, type: created.type, status: "open", created_by: "管理员" });
      return route.fulfill(json({ id: 7, ok: true }));
    }
    if (path === "/api/tasks") return route.fulfill(json({ tasks }));
    if (path === "/api/tasks/5") return route.fulfill(json({
      task: tasks[0], debate: [], challenges: [], supplements: [],
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
  return { typeSelection: "passed", createdType: created.type };
}
