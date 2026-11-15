import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

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
          return { meta: { last_row_id: Number(result.lastInsertRowid) } };
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
