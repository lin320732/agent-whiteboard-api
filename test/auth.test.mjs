import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { initAuthSchema } from "../src/auth.js";

function memoryD1() {
  const sqlite = new DatabaseSync(":memory:");
  return {
    sqlite,
    async exec(sql) { sqlite.exec(sql); },
    batch(statements) {
      sqlite.exec('BEGIN');
      try {const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}
      catch(error) {sqlite.exec('ROLLBACK');throw error;}
    },
    prepare(sql) {
      let args = [];
      return {
        execute() {const statement=sqlite.prepare(sql);if(statement.columns().length) return {results:statement.all(...args)};const result=statement.run(...args);return {meta:{last_row_id:Number(result.lastInsertRowid),changes:Number(result.changes)}};},
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() {
          const result = sqlite.prepare(sql).run(...args);
          return { meta: { last_row_id: Number(result.lastInsertRowid), changes: Number(result.changes) } };
        },
      };
    },
  };
}

function setup({ legacyWrite = false } = {}) {
  const DB = memoryD1();
  const env = {
    DB, API_KEY: "old-shared-token", BOOTSTRAP_KEY: "bootstrap-token",
    BOARD_ORIGIN: "https://board.example.test", ALLOW_PUBLIC_READ: "false",
    // The shared key is read-only unless a migration window is explicitly opened;
    // legacy-write fixtures below opt in so they can keep testing other rules.
    ...(legacyWrite ? { ALLOW_LEGACY_WRITE: "true" } : {}),
  };
  async function request(method, path, body, headers = {}) {
    const res = await worker.fetch(new Request(`https://whiteboard.example.test${path}`, {
      method, headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, {});
    return { status: res.status, data: await res.json(), cookie: res.headers.get("set-cookie") };
  }
  return { env, DB, request };
}

async function owner(request) {
  const boot = await request("POST", "/api/admin/bootstrap", {}, { Authorization: "Bearer bootstrap-token" });
  assert.equal(boot.status, 201);
  assert.match(boot.data.password, /^wbp_/);
  const login = await request("POST", "/api/auth/login", { username: "owner", password: boot.data.password });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /HttpOnly; Secure; SameSite=Strict/);
  return { cookie: login.cookie.split(";")[0], password: boot.data.password };
}

const boardOrigin = { Origin: "https://board.example.test" };

test("auth DDL is compatible with D1 exec's line-oriented parser", async () => {
  const { DB } = setup();
  const d1 = { exec(sql) {
    if (/CREATE TABLE IF NOT EXISTS \w+ \(\s*\n/.test(sql)) throw Error("D1_EXEC_ERROR: incomplete input");
    return DB.exec(sql);
  } };
  await initAuthSchema(d1);
  assert.equal(DB.sqlite.prepare("SELECT count(*) AS n FROM principals").get().n, 0);
});

test('cold login on a migrated database never requires schema writes', async () => {
  const {env,DB,request}=setup();
  const {password}=await owner(request);
  let schemaWrites=0;
  env.DB={...DB,exec(){schemaWrites++;throw Error('Schema writes are unavailable');}};
  const login=await request('POST','/api/auth/login',{username:'owner',password});
  assert.equal(login.status,200);
  assert.equal(schemaWrites,0);
  assert.match(login.cookie,/HttpOnly; Secure/);
});

test('concurrent cold logins probe readiness independently without sharing request I/O', async () => {
  const {env,DB,request}=setup();
  const {password}=await owner(request);
  let probes=0;
  env.DB={...DB,exec(){throw Error('Cold login must not migrate');},prepare(sql){if(sql.includes('table_list')) probes++;return DB.prepare(sql);}};
  const logins=await Promise.all([1,2,3].map(()=>request('POST','/api/auth/login',{username:'owner',password})));
  assert.deepEqual(logins.map(login=>login.status),[200,200,200]);
  assert.equal(probes,3);
});

test('failed cold readiness reads fail closed and can recover on the next request', async () => {
  const {env,DB,request}=setup();
  await owner(request);
  let probes=0;
  env.DB={...DB,exec(){throw Error('Migrated schema must not be rewritten');},prepare(sql){if(sql.includes('table_list')&&++probes===1) throw Error('Temporary D1 read failure');return DB.prepare(sql);}};
  assert.equal((await request('GET','/api/health')).status,503);
  assert.equal((await request('GET','/api/health')).status,200);
  const completedProbes=probes;
  assert.equal((await request('GET','/api/health')).status,200);
  assert.equal(probes,completedProbes);
});

test('cold readiness still repairs missing schema objects without replacing task records', async () => {
  const {env,DB,request}=setup();
  await owner(request);
  const tasks=DB.sqlite.prepare('SELECT * FROM tasks ORDER BY id').all();
  DB.sqlite.exec('DROP TABLE work_deliveries; DROP INDEX events_debate_once;');
  let schemaWrites=0;
  env.DB={...DB,exec(sql){schemaWrites++;return DB.exec(sql);}};
  assert.equal((await request('GET','/api/health')).status,200);
  assert.ok(schemaWrites>0);
  assert.ok(DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='work_deliveries'").get());
  assert.ok(DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='events_debate_once'").get());
  assert.deepEqual(DB.sqlite.prepare('SELECT * FROM tasks ORDER BY id').all(),tasks);
});

test('concurrent first-ever invocations seed a new database once', async () => {
  const {DB,request}=setup();
  const responses=await Promise.all([1,2,3].map(()=>request('GET','/api/health')));
  assert.deepEqual(responses.map(response=>response.status),[200,200,200]);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM channels').get().n,1);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,3);
});

test("remote migration is additive and can be applied twice", async () => {
  const { DB } = setup();
  DB.sqlite.exec("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT)");
  DB.sqlite.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, agent TEXT, type TEXT, task_id INTEGER, points INTEGER, created_at TEXT)");
  DB.sqlite.exec("INSERT INTO tasks (id, title) VALUES (42, 'kept')");
  const migration = readFileSync(new URL("../migrations/0001-auth.sql", import.meta.url), "utf8");
  DB.sqlite.exec(migration);
  DB.sqlite.exec(migration);
  const labels = readFileSync(new URL("../migrations/0002-display-names.sql", import.meta.url), "utf8");
  DB.sqlite.exec(labels);
  DB.sqlite.exec(labels);
  const award = readFileSync(new URL("../migrations/0003-debate-award.sql", import.meta.url), "utf8");
  DB.sqlite.exec(award);
  DB.sqlite.exec(award);
  assert.equal(DB.sqlite.prepare("SELECT count(*) AS n FROM principal_labels").get().n, 0);
  assert.equal(DB.sqlite.prepare("SELECT title FROM tasks WHERE id=42").get().title, "kept");
  assert.equal(DB.sqlite.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
});

test("dashboard API requires login even during Muse public-read migration", async () => {
  const { env, request } = setup();
  env.ALLOW_PUBLIC_READ = "true";
  assert.equal((await request("GET", "/api/tasks")).status, 200);
  assert.equal((await request("GET", "/api/tasks", undefined, { "X-Whiteboard-Require-Auth": "1" })).status, 401);
});

test("private reads, missing D1 and legacy administrative access fail closed", async () => {
  const { request } = setup();
  assert.equal((await request("GET", "/api/tasks")).status, 401);
  assert.equal((await request("GET", "/api/tasks", undefined, { Authorization: "Bearer old-shared-token" })).status, 200);
  assert.equal((await request("POST", "/api/tasks/1/approve", {}, { Authorization: "Bearer old-shared-token" })).status, 403);
  assert.equal((await request("POST", "/api/tasks/1/verify", { force: true, force_reason: "x" }, { Authorization: "Bearer old-shared-token" })).status, 403);
  assert.equal((await request("POST", "/api/channels", { name: "wrong" }, { Authorization: "Bearer old-shared-token" })).status, 403);
  const withoutDb = await worker.fetch(new Request("https://whiteboard.example.test/api/health"), {}, {});
  assert.equal(withoutDb.status, 503);
  const brokenDb = await worker.fetch(new Request("https://whiteboard.example.test/api/tasks"), { DB: { exec() { throw Error("D1 offline"); } } }, {});
  assert.equal(brokenDb.status, 503);
});

test("human sessions and per-agent credentials enforce identity and roles", async () => {
  const { request, DB } = setup();
  const { cookie } = await owner(request);
  const auth = { Cookie: cookie, ...boardOrigin };
  const crossSite = await request("POST", "/api/admin/agents", { username: "agent-one", name: "Agent One" }, { Cookie: cookie, Origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  const agentCreate = await request("POST", "/api/admin/agents", { username: "agent-one", name: "Agent One" }, auth);
  assert.equal(agentCreate.status, 201);
  assert.match(agentCreate.data.token, /^wba_/);
  assert.equal(JSON.stringify(DB.sqlite.prepare("SELECT * FROM api_credentials").all()).includes(agentCreate.data.token), false);
  const agent = { Authorization: `Bearer ${agentCreate.data.token}` };
  const proposal = await request("POST", "/api/tasks", { title: "new proposal", createdBy: "owner", proposedBy: "owner" }, agent);
  assert.equal(proposal.data.status, "proposed");
  assert.equal(DB.sqlite.prepare("SELECT created_by FROM tasks WHERE id=?").get(proposal.data.id).created_by, "Agent One");
  const claimed = await request("POST", "/api/tasks/1/claim", { agent: "another agent", role: "researcher" }, agent);
  assert.equal(claimed.data.task.claimed_by, "Agent One");
  const human = await request("POST", "/api/admin/users", { username: "muse-owner", name: "Muse Owner", role: "publisher" }, auth);
  assert.equal(human.status, 201);
  const publisher = { Authorization: `Bearer ${human.data.muse_token}` };
  const published = await request("POST", "/api/tasks", { title: "owner task", createdBy: "admin", proposedBy: "Agent A" }, publisher);
  assert.equal(published.data.status, "open");
  assert.equal(DB.sqlite.prepare("SELECT created_by FROM tasks WHERE id=?").get(published.data.id).created_by, "Muse Owner");
  assert.equal((await request("POST", `/api/tasks/${published.data.id}/approve`, {}, publisher)).status, 403);
  assert.equal((await request("GET", "/api/tasks", undefined, publisher)).status, 200);
  assert.equal((await request("POST", "/api/tasks/1/result", { summary: "done", links: ["https://example.com"] }, agent)).status, 200);
  assert.equal((await request("POST", "/api/tasks/1/verify", { force: true, force_reason: "personal review" }, agent)).status, 403);
  const verified = await request("POST", "/api/tasks/1/verify", { force: true, force_reason: "personal review", agent: "impersonator" }, auth);
  assert.equal(verified.status, 200);
  assert.equal(DB.sqlite.prepare("SELECT agent FROM force_approvals WHERE task_id=1").get().agent, "owner");
  const revoke = await request("POST", `/api/admin/agents/${agentCreate.data.id}/revoke`, {}, auth);
  assert.equal(revoke.status, 200);
  assert.equal((await request("GET", "/api/tasks", undefined, agent)).status, 401);
  const logout = await request("POST", "/api/auth/logout", {}, auth);
  assert.equal(logout.status, 200);
  assert.equal((await request("GET", "/api/tasks", undefined, { Cookie: cookie })).status, 401);
});

test("display-name edits preserve identity, claims, scores and issued credentials", async () => {
  const { request, DB } = setup();
  const { cookie } = await owner(request);
  const admin = { Cookie: cookie, ...boardOrigin };
  const created = await request("POST", "/api/admin/agents", { username: "muse-new", name: "Old Muse" }, admin);
  assert.equal(created.status, 201);
  const agent = { Authorization: `Bearer ${created.data.token}` };
  assert.equal((await request("POST", "/api/tasks/1/claim", { role: "researcher" }, agent)).status, 200);
  assert.equal((await request("POST", "/api/messages", { channelId: 1, text: "同步进度" }, agent)).status, 201);
  assert.equal((await request("POST", "/api/tasks/1/debate", { stance: "支持", content: "同意" }, agent)).status, 201);
  const rename = await request("POST", `/api/admin/agents/${created.data.id}/name`, { name: "  New Muse  " }, admin);
  assert.equal(rename.status, 200);
  assert.deepEqual(rename.data, { ok: true, id: created.data.id, name: "New Muse" });
  assert.equal(DB.sqlite.prepare("SELECT name FROM principals WHERE id=?").get(created.data.id).name, "Old Muse");
  assert.equal(DB.sqlite.prepare("SELECT claimed_by FROM tasks WHERE id=1").get().claimed_by, "Old Muse");
  assert.equal((await request("GET", "/api/auth/me", undefined, agent)).data.user.name, "New Muse");
  const listed = await request("GET", "/api/admin/agents", undefined, admin);
  assert.equal(listed.data.accounts.find(x => x.id === created.data.id).name, "New Muse");
  const before = await request("GET", "/api/tasks/1", undefined, agent);
  assert.equal(before.data.task.claimed_by, "New Muse");
  assert.match(before.data.verify_readiness.checks[0].detail, /New Muse/);
  assert.match(before.data.collaboration.missing.find(c => c.key === "agents").detail, /New Muse/);
  assert.match(before.data.collaboration.reason, /New Muse/);
  assert.equal((await request("GET", "/api/tasks", undefined, agent)).data.tasks.find(t => t.id === 1).claimed_by, "New Muse");
  assert.equal((await request("GET", "/api/messages?channelId=1", undefined, agent)).data.messages[0].author, "New Muse");
  assert.equal((await request("GET", "/api/tasks/1/debate", undefined, agent)).data.debate[0].agent, "New Muse");
  assert.equal((await request("GET", "/api/leaderboard", undefined, agent)).data.leaderboard[0].agent, "New Muse");
  assert.equal((await request("POST", "/api/tasks/1/result", { summary: "完成" }, agent)).status, 200);
  assert.equal(DB.sqlite.prepare("SELECT claimed_by FROM tasks WHERE id=1").get().claimed_by, "Old Muse");
  const after = await request("GET", "/api/tasks/1", undefined, agent);
  assert.equal(after.data.verify_readiness.checks[0].detail.match(/已參與 1 位/) !== null, true);
  const ranking = await request("GET", "/api/leaderboard", undefined, agent);
  assert.equal(ranking.data.leaderboard.length, 1);
  assert.equal(ranking.data.leaderboard[0].points, 15);
  const ownerRename = await request("POST", "/api/admin/users/1/name", { name: "Whiteboard Owner" }, admin);
  assert.equal(ownerRename.status, 200);
  assert.equal((await request("GET", "/api/auth/me", undefined, admin)).data.user.name, "Whiteboard Owner");
  const publisher = await request("POST", "/api/admin/users", { username: "publisher-one", name: "Old Publisher", role: "publisher" }, admin);
  assert.equal((await request("POST", `/api/admin/users/${publisher.data.id}/name`, { name: "New Publisher" }, admin)).status, 200);
  assert.equal((await request("GET", "/api/auth/me", undefined, { Authorization: `Bearer ${publisher.data.muse_token}` })).data.user.name, "New Publisher");
  const humanTask = await request("POST", "/api/tasks", { title: "新人任务" }, { Authorization: `Bearer ${publisher.data.muse_token}` });
  assert.equal(humanTask.data.status, "open");
  assert.equal(DB.sqlite.prepare("SELECT created_by FROM tasks WHERE id=?").get(humanTask.data.id).created_by, "Old Publisher");
  assert.equal((await request("GET", `/api/tasks/${humanTask.data.id}`, undefined, admin)).data.task.created_by, "New Publisher");
});

test("display-name edits require admin session, validate inputs and avoid ambiguous attribution", async () => {
  const { request } = setup({ legacyWrite: true });
  const { cookie } = await owner(request);
  const admin = { Cookie: cookie, ...boardOrigin };
  const first = await request("POST", "/api/admin/agents", { username: "first", name: "Shared" }, admin);
  const second = await request("POST", "/api/admin/agents", { username: "second", name: "Shared" }, admin);
  const endpoint = `/api/admin/agents/${first.data.id}/name`;
  assert.equal((await request("POST", endpoint, { name: "Alias" })).status, 401);
  assert.equal((await request("POST", endpoint, { name: "Alias" }, { Authorization: `Bearer ${first.data.token}` })).status, 403);
  assert.equal((await request("POST", endpoint, { name: "Alias" }, { Cookie: cookie, Origin: "https://wrong.example" })).status, 403);
  for (const name of ["   ", "x".repeat(81), 42]) assert.equal((await request("POST", endpoint, { name }, admin)).status, 400);
  assert.equal((await request("POST", "/api/admin/agents/9999/name", { name: "Absent" }, admin)).status, 404);
  assert.equal((await request("POST", `/api/admin/users/${first.data.id}/name`, { name: "Wrong kind" }, admin)).status, 404);
  assert.equal((await request("POST", endpoint, { name: "Alias" }, admin)).status, 200);
  assert.equal((await request("GET", "/api/admin/agents", undefined, admin)).data.accounts.find(x => x.id === first.data.id).name, "Alias");
  const legacy = { Authorization: "Bearer old-shared-token" };
  assert.equal((await request("POST", "/api/messages", { channelId: 1, author: "Shared", text: "同名测试" }, legacy)).status, 201);
  assert.equal((await request("GET", "/api/messages?channelId=1", undefined, admin)).data.messages[0].author, "Shared");
  assert.equal((await request("POST", `/api/admin/agents/${second.data.id}/revoke`, {}, admin)).status, 200);
  assert.equal((await request("POST", `/api/admin/agents/${second.data.id}/name`, { name: "已停用的新标签" }, admin)).status, 200);
  assert.equal((await request("GET", "/api/admin/agents", undefined, admin)).data.accounts.find(x => x.id === second.data.id).name, "已停用的新标签");
});

test("agent collaboration queue surfaces claimed work and rewards one debate reply", async () => {
  const { request, DB } = setup();
  const { cookie } = await owner(request);
  const admin = { Cookie: cookie, ...boardOrigin };
  const first = await request("POST", "/api/admin/agents", { username: "agent-a", name: "Agent A" }, admin);
  const second = await request("POST", "/api/admin/agents", { username: "agent-b", name: "Agent B" }, admin);
  const a = { Authorization: `Bearer ${first.data.token}` };
  const b = { Authorization: `Bearer ${second.data.token}` };
  const queue = async () => (await request("GET", "/api/tasks?needs=agent", undefined, b)).data.tasks;

  const open = (await queue()).find(t => t.id === 1);
  assert.equal(open.collaboration.help_wanted, true);
  assert.equal(open.collaboration.suggested_action, "claim");
  assert.equal((await request("POST", "/api/tasks/1/claim", { role: "researcher" }, a)).status, 200);

  let task = (await queue()).find(t => t.id === 1);
  assert.equal(task.collaboration.help_wanted, true);
  assert.equal(task.collaboration.suggested_action, "debate");
  assert.equal(task.collaboration.participants, 1);
  assert.ok(task.collaboration.missing.some(c => c.key === "agents"));
  assert.equal((await request("POST", "/api/tasks/1/result", { summary: "初稿", links: ["https://example.com/a"] }, a)).status, 200);

  task = (await queue()).find(t => t.id === 1);
  assert.equal(task.collaboration.suggested_action, "challenge");
  assert.ok(task.collaboration.missing.some(c => c.key === "challenge"));
  assert.ok(task.collaboration.missing.some(c => c.key === "links"));
  assert.equal((await request("POST", "/api/tasks/1/challenge", { reason: "需要第二来源", evidence: "https://example.com/c" }, b)).status, 200);

  task = (await queue()).find(t => t.id === 1);
  assert.equal(task.collaboration.suggested_action, "respond");
  assert.deepEqual(task.collaboration.missing.map(c => c.key), ["links", "issues"]);
  assert.equal((await request("POST", "/api/tasks/1/supplement", { summary: "补两个来源", links: ["https://example.com/b", "https://example.com/c"] }, b)).status, 200);
  assert.equal((await queue()).some(t => t.id === 1), true);
  const pending = (await request("GET", "/api/tasks/1", undefined, a)).data.workflow.issues[0];
  assert.equal((await request("POST", `/api/tasks/1/issues/${pending.id}/respond`, { text: "来源已补齐" }, a)).status, 200);
  assert.equal((await request("POST", `/api/tasks/1/issues/${pending.id}/resolve`, { note: "已核实新增来源", revision: 1 }, b)).status, 403);
  assert.equal((await request("POST", `/api/tasks/1/issues/${pending.id}/resolve`, { note: "管理员确认来源已补齐", revision: 1 }, admin)).status, 200);
  const detail = await request("GET", "/api/tasks/1", undefined, b);
  assert.equal(detail.data.collaboration.help_wanted, false);
  assert.equal(detail.data.verify_readiness.ready, true);

  assert.equal((await request("POST", "/api/tasks/2/claim", { role: "researcher" }, a)).status, 200);
  assert.equal((await request("POST", "/api/tasks/2/debate", { stance: "支持", content: "补充一个观点" }, b)).status, 201);
  assert.equal((await request("POST", "/api/tasks/2/debate", { stance: "補充", content: "再说一次" }, b)).status, 201);
  assert.equal((await request("POST", "/api/tasks/2/debate", { stance: "支持", content: "认领者发言" }, a)).status, 201);
  assert.equal((await request("POST", "/api/tasks/2/debate", { stance: "支持", content: "真人发言" }, admin)).status, 201);

  const ranking = await request("GET", "/api/leaderboard", undefined, b);
  const secondRow = ranking.data.leaderboard.find(x => x.agent === "Agent B");
  const firstRow = ranking.data.leaderboard.find(x => x.agent === "Agent A");
  assert.equal(secondRow.points, 23);
  assert.equal(secondRow.counts.debate, 1);
  assert.equal(firstRow.points, 20);
  assert.equal(firstRow.counts.debate, 0);
  assert.equal(DB.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type='debate'").get().n, 1);
});

test("dashboard and Agent debate stances accept simplified Chinese and documented aliases", async () => {
  const { request } = setup({ legacyWrite: true });
  const { cookie } = await owner(request);
  const human = { Cookie: cookie, ...boardOrigin };
  const rebuttal = await request("POST", "/api/tasks/1/debate", { stance: "反驳", content: "证据相反", links: ["https://example.org/evidence"] }, human);
  assert.equal(rebuttal.status, 201);
  assert.equal(rebuttal.data.message.stance, "反駁");
  const addition = await request("POST", "/api/tasks/1/debate", { stance: "补充", content: "补充资料" }, human);
  assert.equal(addition.status, 201);
  assert.equal(addition.data.message.stance, "補充");
  const agent = await request("POST", "/api/tasks/1/debate", { agent: "Agent A", stance: "supplement", content: "extra source" }, { Authorization: "Bearer old-shared-token" });
  assert.equal(agent.status, 201);
  assert.equal(agent.data.message.stance, "補充");
});

test("malformed role, stance and reserved Agent name cannot corrupt the leaderboard", async () => {
  const { request } = setup({ legacyWrite: true });
  const legacy = { Authorization: "Bearer old-shared-token" };
  assert.equal((await request("POST", "/api/tasks/1/claim", { agent: "Red", role: "toString" }, legacy)).status, 400);
  assert.equal((await request("POST", "/api/tasks/1/debate", { agent: "Red", stance: "toString", content: "reason" }, legacy)).status, 400);
  try {
    assert.equal((await request("POST", "/api/tasks/1/claim", { agent: "__proto__" }, legacy)).status, 200);
    const board = await request("GET", "/api/leaderboard", undefined, legacy);
    assert.equal(board.data.leaderboard[0].agent, "__proto__");
    assert.equal(board.data.leaderboard[0].points, 5);
  } finally { delete Object.prototype.points; }
});

test("two concurrent claims can record only one winner", async () => {
  const { request, DB } = setup({ legacyWrite: true });
  const legacy = { Authorization: "Bearer old-shared-token" };
  const results = await Promise.all([
    request("POST", "/api/tasks/1/claim", { agent: "Agent A" }, legacy),
    request("POST", "/api/tasks/1/claim", { agent: "Agent B" }, legacy),
  ]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 400]);
  assert.equal(DB.sqlite.prepare("SELECT count(*) AS n FROM events WHERE task_id=1 AND type='claim'").get().n, 1);
});

test("read-only account cannot write and bootstrap runs once", async () => {
  const { request } = setup();
  const { cookie } = await owner(request);
  const auth = { Cookie: cookie, ...boardOrigin };
  assert.equal((await request("POST", "/api/admin/bootstrap", {}, { Authorization: "Bearer bootstrap-token" })).status, 409);
  const viewer = await request("POST", "/api/admin/users", { username: "observer", name: "Observer", role: "viewer" }, auth);
  assert.equal(viewer.status, 201);
  assert.equal(viewer.data.muse_token, undefined);
  const login = await request("POST", "/api/auth/login", { username: "observer", password: viewer.data.password });
  const viewCookie = login.cookie.split(";")[0];
  assert.equal((await request("GET", "/api/tasks", undefined, { Cookie: viewCookie })).status, 200);
  assert.equal((await request("POST", "/api/tasks", { title: "no" }, { Cookie: viewCookie, ...boardOrigin })).status, 403);
});
