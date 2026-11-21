async page => {
  const agents = [
    { id: 7, username: "muse-agent", name: "新 Muse", role: "agent", active: 1 },
    ...Array.from({ length: 14 }, (_, n) => ({ id: 8 + n, username: `agent-${n}`, name: `Agent ${n}`, role: "agent", active: 1 })),
  ];
  const users = [{ id: 1, username: "owner", name: "管理员", role: "admin", active: 1 }, { id: 3, username: "publisher", name: "发布者", role: "publisher", active: 1 }];
  let rotateCalls = 0, revokeCalls = 0, humanRotateCalls = 0, renameCalls = 0, rejectRename = true, rejectRevoke = true, nativeDialogs = 0, channelReads = 0, taskReads = 0;
  page.on("dialog", dialog => { nativeDialogs++; dialog.dismiss(); });
  const json = (value, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = request.url().replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path === "/api/auth/me") return route.fulfill(json({ user: { id: 1, name: users[0].name, role: "admin" } }));
    if (path === "/api/channels") return route.fulfill(json({ channels: [{ id: 1, name: `频道 ${++channelReads}` }] }));
    if (path === "/api/tasks") return route.fulfill(json({ tasks: ++taskReads > 1 ? [{ id: 100, title: `刷新后的任务 ${taskReads}`, status: 'open' }] : [], decisions: [] }));
    if (path === "/api/messages") return route.fulfill(json({ messages: [] }));
    if (path === "/api/leaderboard") return route.fulfill(json({ leaderboard: [] }));
    if (path === "/api/admin/users/3/rotate") {
      humanRotateCalls++;
      return route.fulfill(json({ ok: true, id: 3, password: "wbp_example_test_only", muse_token: "wbu_example_test_only" }));
    }
    if (request.method() === "POST" && (path === "/api/admin/agents/7/name" || path === "/api/admin/users/1/name")) {
      renameCalls++;
      if (rejectRename) { rejectRename = false; return route.fulfill(json({ error: "显示名称需为 1–80 个字符" }, 400)); }
      const account = path.includes("agents") ? agents[0] : users[0];
      account.name = JSON.parse(request.postData()).name.trim();
      return route.fulfill(json({ ok: true, id: account.id, name: account.name }));
    }
    if (path === "/api/admin/users") return route.fulfill(json({ accounts: users }));
    if (path === "/api/admin/agents" && request.method() === "GET") return route.fulfill(json({ accounts: agents }));
    if (path === "/api/admin/agents/7/rotate") {
      rotateCalls++;
      return route.fulfill(json({ ok: true, id: 7, token: "wba_example_test_only" }));
    }
    if (path === "/api/admin/agents/7/revoke") {
      revokeCalls++;
      if (rejectRevoke) return route.fulfill(json({ error: "权限不足" }, 403));
      agents[0].active = 0;
      return route.fulfill(json({ ok: true, id: 7 }));
    }
    return route.fulfill(json({ error: `unmocked ${path}` }, 404));
  });
  await page.goto("http://127.0.0.1:8765/");
  await page.locator('#workspaceMenu > summary').click();
  await page.locator('#accountsMenu').click();
  const agent = page.locator("#agents .account-item").first();
  await page.locator("#agents .account-row").first().waitFor();
  await agent.getByRole("button", { name: "改名" }).click({ timeout: 2500 });
  const edit = agent.locator(".account-edit");
  if (await edit.locator('input[name="name"]').inputValue() !== "新 Muse") throw Error("改名表单没有预填现有名称");
  await edit.locator('input[name="name"]').fill("取消的名称");
  await page.locator('#refresh').click();
  // Refresh the task summary while retaining the member form and leaving the
  // unopened discussion view unloaded.
  await page.locator('#taskList').getByText('刷新后的任务 2', { exact: true }).waitFor({ state: 'attached' });
  if (channelReads !== 0) throw Error('成员页刷新提前读取了讨论区频道');
  if (await edit.locator('input[name="name"]').inputValue() !== "取消的名称") throw Error("刷新清掉了尚未保存的名称");
  await edit.getByRole("button", { name: "取消" }).click();
  if (renameCalls || await agent.locator(".account-edit").count()) throw Error("取消改名仍调用了接口");
  await agent.getByRole("button", { name: "改名" }).click();
  await agent.locator(".account-edit").getByRole("button", { name: "保存名称" }).click();
  await agent.locator(".account-edit .error").getByText("显示名称需为 1–80 个字符").waitFor();
  await agent.locator('.account-edit input[name="name"]').fill("  Muse 新名字  ");
  await agent.locator(".account-edit").getByRole("button", { name: "保存名称" }).click();
  await agent.locator(".account-row").getByText("Muse 新名字", { exact: false }).waitFor();
  if (renameCalls !== 2 || rotateCalls !== 0) throw Error("改名不应轮换令牌");
  await page.locator("#agents .account-row").first().getByRole("button", { name: "轮换" }).click();
  if (nativeDialogs) throw Error("轮换依赖浏览器原生确认框");
  if (!await agent.locator(".account-confirm").isVisible()) throw Error("轮换未在账号旁显示确认操作");
  if (rotateCalls !== 0) throw Error("尚未确认就轮换了令牌");
  const nextRefresh = taskReads + 1;
  await page.locator('#refresh').click();
  await page.locator('#taskList').getByText(`刷新后的任务 ${nextRefresh}`, { exact: true }).waitFor({ state: 'attached' });
  if (!await agent.locator(".account-confirm").isVisible()) throw Error("刷新数据时清掉了尚未确认的操作");
  await agent.getByRole("button", { name: "取消" }).click();
  if (await agent.locator(".account-confirm").count() || rotateCalls) throw Error("取消后仍执行了轮换");
  await agent.getByRole("button", { name: "轮换", exact: true }).click();
  await agent.getByRole("button", { name: "确认轮换" }).click();
  await page.locator("#issuedSecrets").getByText("wba_example_test_only", { exact: false }).waitFor();
  await page.waitForFunction(() => { const r = document.getElementById("issuedSecrets").getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
  if (rotateCalls !== 1) throw Error("轮换接口没有调用一次");
  await agent.getByRole("button", { name: "停用", exact: true }).click();
  await agent.getByRole("button", { name: "确认停用" }).click();
  await agent.locator(".account-confirm .error").getByText("权限不足").waitFor();
  if (revokeCalls !== 1) throw Error("停用接口没有调用一次");
  rejectRevoke = false;
  await agent.getByRole("button", { name: "确认停用" }).click();
  await page.locator("#agents .account-row").first().getByText("已停用", { exact: false }).waitFor();
  if (revokeCalls !== 2 || await page.locator("#agents .account-row").first().getByRole("button", { name: "停用" }).count()) throw Error("停用后账号状态没有刷新");
  if (!await page.locator("#issuedSecrets").isHidden()) throw Error("停用后仍显示该账号已失效的令牌");
  await agent.getByRole("button", { name: "改名" }).click();
  await agent.locator('.account-edit input[name="name"]').fill("停用后的名字");
  await agent.locator(".account-edit").getByRole("button", { name: "保存名称" }).click();
  await agent.locator(".account-row").getByText("停用后的名字", { exact: false }).waitFor();
  if (!await agent.locator(".account-row").getByText("已停用", { exact: false }).count()) throw Error("改名不应启用已停用账号");
  const human = page.locator("#users .account-item").nth(1);
  await human.getByRole("button", { name: "轮换", exact: true }).click();
  await human.getByRole("button", { name: "确认轮换" }).click();
  await page.locator("#issuedSecrets").getByText("wbu_example_test_only", { exact: false }).waitFor();
  if (!await page.locator("#issuedSecrets").getByText("wbp_example_test_only", { exact: false }).count() || humanRotateCalls !== 1) throw Error("真人账号的新密码或令牌没有显示");
  const owner = page.locator("#users .account-item").first();
  await owner.getByRole("button", { name: "改名" }).click();
  await owner.locator('.account-edit input[name="name"]').fill("白板管理员");
  await owner.locator(".account-edit").getByRole("button", { name: "保存名称" }).click();
  await page.locator("#signedInAs").getByText("白板管理员", { exact: false }).waitFor();
  if (renameCalls !== 4 || humanRotateCalls !== 1) throw Error("管理员改名影响了凭据或没有保存");
  return { rotateCalls, revokeCalls, humanRotateCalls, renameCalls, inlineConfirmation: "passed", inlineErrors: "passed" };
}
