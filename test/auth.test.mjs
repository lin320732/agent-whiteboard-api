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
    prepare(sql) {
      let args = [];
      return {
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

function setup() {
  const DB = memoryD1();
  const env = {
    DB, API_KEY: "old-shared-token", BOOTSTRAP_KEY: "bootstrap-token",
    BOARD_ORIGIN: "https://board.example.test", ALLOW_PUBLIC_READ: "false",
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

test("remote migration is additive and can be applied twice", async () => {
  const { DB } = setup();
  DB.sqlite.exec("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT)");
  DB.sqlite.exec("INSERT INTO tasks (id, title) VALUES (42, 'kept')");
  const migration = readFileSync(new URL("../migrations/0001-auth.sql", import.meta.url), "utf8");
  DB.sqlite.exec(migration);
  DB.sqlite.exec(migration);
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

test("dashboard and Agent debate stances accept simplified Chinese and documented aliases", async () => {
  const { request } = setup();
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
  const { request } = setup();
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
  const { request, DB } = setup();
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
