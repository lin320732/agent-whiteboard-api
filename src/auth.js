// Whiteboard identities are stored only in D1. Tokens are generated, displayed once,
// and persisted solely as SHA-256 hashes. The legacy key has agent-only privileges.
export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS principals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
  role TEXT NOT NULL CHECK(role IN ('admin','publisher','viewer','agent')),
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('publisher','agent')),
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  principal_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS principal_labels (
  principal_id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL
);`;

export async function initAuthSchema(db) {
  // D1's Worker exec parses one SQL statement per line; flatten each DDL first.
  for (const sql of AUTH_SCHEMA.split(";")) {
    const statement = sql.replace(/\s+/g, " ").trim();
    if (statement) await db.exec(`${statement};`);
  }
}

export async function hashSecret(secret) {
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

function randomSecret(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}`;
}

function reply(data, status = 200, cookie) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}
const fail = (message, status = 400) => reply({ ok: false, error: message }, status);
const SESSION_COOKIE = "wb_session";
const SESSION_AGE = 60 * 60 * 24;
const cookie = (value, age = SESSION_AGE) => `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;

export async function principalFor(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (header) {
    if (!header.startsWith("Bearer ") || header.length > 256) return null;
    const secret = header.slice(7);
    if (env.API_KEY && secret === env.API_KEY) return { id: null, name: "Legacy Agent", kind: "legacy", role: "agent", via: "legacy" };
    const tokenHash = await hashSecret(secret);
    const row = await env.DB.prepare(`SELECT p.id, p.username, p.name, p.kind, p.role, c.scope, l.display_name
      FROM api_credentials c JOIN principals p ON p.id=c.principal_id
      LEFT JOIN principal_labels l ON l.principal_id=p.id
      WHERE c.token_hash=? AND c.active=1 AND p.active=1`).bind(tokenHash).first();
    if (!row) return null;
    return { ...row, via: "bearer" };
  }
  const value = (request.headers.get("Cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!value || !/^wbs_[a-f0-9]{64}$/.test(value)) return null;
  const row = await env.DB.prepare(`SELECT p.id, p.username, p.name, p.kind, p.role, l.display_name FROM sessions s
    JOIN principals p ON p.id=s.principal_id
    LEFT JOIN principal_labels l ON l.principal_id=p.id
    WHERE s.token_hash=? AND s.expires_at>? AND p.active=1 AND p.kind='human'`)
    .bind(await hashSecret(value), new Date().toISOString()).first();
  return row ? { ...row, via: "session" } : null;
}

export function permit(principal, action) {
  if (!principal) return false;
  if (principal.kind === "test") return true; // explicit TEST_MEMORY mode only
  if (action === "read") return true;
  const admin = principal.kind === "human" && principal.role === "admin" && principal.via === "session";
  const humanWriter = principal.kind === "human" && (principal.role === "admin" || principal.role === "publisher") && (principal.via === "session" || principal.scope === "publisher");
  const agent = principal.kind === "agent" || principal.kind === "legacy";
  if (action === "admin" || action === "channel:create" || ["verify", "reopen", "approve", "reject"].includes(action)) return admin;
  if (action === "task:create" || action === "message:post" || action === "debate") return admin || humanWriter || agent;
  if (["claim", "result", "challenge", "supplement"].includes(action)) return agent;
  return false;
}

export function actorName(principal, body = {}) {
  if (principal.kind === "test" || principal.kind === "legacy") return body.agent || body.createdBy || body.author || "Legacy Agent";
  return principal.name;
}

function sessionOriginAllowed(request, env) {
  return request.headers.get("Origin") === (env.BOARD_ORIGIN || "https://board.a4a4.ccwu.cc");
}

export function originAllowed(request, env, principal) {
  if (principal?.via !== "session" || request.method === "GET") return true;
  return sessionOriginAllowed(request, env);
}

function validUser(value) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,39}$/.test(value); }
function validName(value) { return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 80; }
async function issueCredential(db, id, scope) {
  const token = randomSecret(scope === "agent" ? "wba_" : "wbu_");
  await db.prepare("INSERT INTO api_credentials (principal_id, scope, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, scope, await hashSecret(token), new Date().toISOString()).run();
  return token;
}
async function createPrincipal(db, { username, name, kind, role }) {
  const password = kind === "human" ? randomSecret("wbp_") : null;
  const result = await db.prepare("INSERT INTO principals (username, name, kind, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(username, name, kind, role, password ? await hashSecret(password) : null, new Date().toISOString()).run();
  const id = result.meta.last_row_id;
  const token = role === "viewer" ? null : await issueCredential(db, id, kind === "agent" ? "agent" : "publisher");
  return { id, username, name, kind, role, ...(password ? { password } : {}), ...(token ? { [kind === "agent" ? "token" : "muse_token"]: token } : {}) };
}

export async function authRoute(request, env, principal, path) {
  if (path === "/api/admin/bootstrap" && request.method === "POST") {
    const existing = await env.DB.prepare("SELECT COUNT(*) AS count FROM principals").first();
    if (existing.count > 0) return fail("管理员已创建", 409);
    if (!env.BOOTSTRAP_KEY || request.headers.get("Authorization") !== `Bearer ${env.BOOTSTRAP_KEY}`) return fail("未授权", 401);
    try { return reply({ ok: true, ...await createPrincipal(env.DB, { username: "owner", name: "owner", kind: "human", role: "admin" }) }, 201); }
    catch { return fail("管理员创建失败", 409); }
  }
  if (path === "/api/auth/login" && request.method === "POST") {
    if (request.headers.get("Origin") && !sessionOriginAllowed(request, env)) return fail("来源不符", 403);
    const body = await request.json().catch(() => ({}));
    if (!validUser(body.username) || typeof body.password !== "string" || body.password.length > 128) return fail("账号或密码错误", 401);
    const user = await env.DB.prepare(`SELECT p.id, p.username, p.name, p.kind, p.role, p.password_hash, l.display_name
      FROM principals p LEFT JOIN principal_labels l ON l.principal_id=p.id
      WHERE p.username=? AND p.active=1 AND p.kind='human'`).bind(body.username).first();
    if (!user?.password_hash || user.password_hash !== await hashSecret(body.password)) return fail("账号或密码错误", 401);
    const secret = randomSecret("wbs_");
    const now = new Date();
    await env.DB.prepare("INSERT INTO sessions (token_hash, principal_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await hashSecret(secret), user.id, new Date(now.getTime() + SESSION_AGE * 1000).toISOString(), now.toISOString()).run();
    return reply({ ok: true, user: { id: user.id, username: user.username, name: user.display_name || user.name, kind: user.kind, role: user.role } }, 200, cookie(secret));
  }
  if (path === "/api/auth/me" && request.method === "GET") {
    return principal ? reply({ ok: true, user: { id: principal.id, username: principal.username, name: principal.display_name || principal.name, kind: principal.kind, role: principal.role, via: principal.via } }) : fail("未登录", 401);
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    if (!principal || principal.via !== "session" || !originAllowed(request, env, principal)) return fail("未授权", 403);
    const value = (request.headers.get("Cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await hashSecret(value)).run();
    return reply({ ok: true }, 200, cookie("", 0));
  }
  if (!path.startsWith("/api/admin/")) return null;
  if (!permit(principal, "admin") || !originAllowed(request, env, principal)) return fail("权限不足", principal ? 403 : 401);
  const listing = path.match(/^\/api\/admin\/(users|agents)$/);
  if (listing && request.method === "GET") {
    const kind = listing[1] === "users" ? "human" : "agent";
    const data = await env.DB.prepare(`SELECT p.id, p.username, COALESCE(l.display_name, p.name) AS name, p.kind, p.role, p.active, p.created_at
      FROM principals p LEFT JOIN principal_labels l ON l.principal_id=p.id
      WHERE p.kind=? ORDER BY p.id`).bind(kind).all();
    return reply({ ok: true, accounts: data.results });
  }
  if (listing && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const kind = listing[1] === "users" ? "human" : "agent";
    const role = kind === "agent" ? "agent" : b.role;
    if (!validUser(b.username) || !validName(b.name) || (kind === "human" && !["admin", "publisher", "viewer"].includes(role))) return fail("无效的账号、名称或角色");
    try { return reply({ ok: true, ...await createPrincipal(env.DB, { username: b.username, name: b.name.trim(), kind, role }) }, 201); }
    catch { return fail("账号名已存在", 409); }
  }
  const rename = path.match(/^\/api\/admin\/(users|agents)\/(\d+)\/name$/);
  if (rename && request.method === "POST") {
    const kind = rename[1] === "users" ? "human" : "agent", id = Number(rename[2]);
    const body = await request.json().catch(() => ({}));
    if (!validName(body.name)) return fail("显示名称需为 1–80 个字符");
    const target = await env.DB.prepare("SELECT id FROM principals WHERE id=? AND kind=?").bind(id, kind).first();
    if (!target) return fail("账号不存在", 404);
    const name = body.name.trim();
    await env.DB.prepare(`INSERT INTO principal_labels (principal_id, display_name) VALUES (?, ?)
      ON CONFLICT(principal_id) DO UPDATE SET display_name=excluded.display_name`).bind(id, name).run();
    return reply({ ok: true, id, name });
  }
  const change = path.match(/^\/api\/admin\/(users|agents)\/(\d+)\/(revoke|rotate)$/);
  if (change && request.method === "POST") {
    const kind = change[1] === "users" ? "human" : "agent", id = Number(change[2]);
    const target = await env.DB.prepare("SELECT id, kind, role, username, name, active FROM principals WHERE id=? AND kind=?").bind(id, kind).first();
    if (!target) return fail("账号不存在", 404);
    if (target.id === principal.id) return fail("不能撤销或轮换自己的管理员账号", 403);
    if (change[3] === "revoke") {
      await env.DB.prepare("UPDATE principals SET active=0 WHERE id=?").bind(id).run();
      await env.DB.prepare("UPDATE api_credentials SET active=0 WHERE principal_id=?").bind(id).run();
      await env.DB.prepare("DELETE FROM sessions WHERE principal_id=?").bind(id).run();
      return reply({ ok: true, id });
    }
    if (!target.active) return fail("账号已停用", 409);
    await env.DB.prepare("UPDATE api_credentials SET active=0 WHERE principal_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE principal_id=?").bind(id).run();
    const password = kind === "human" ? randomSecret("wbp_") : null;
    if (password) await env.DB.prepare("UPDATE principals SET password_hash=? WHERE id=?").bind(await hashSecret(password), id).run();
    const token = target.role === "viewer" ? null : await issueCredential(env.DB, id, kind === "agent" ? "agent" : "publisher");
    return reply({ ok: true, id, ...(password ? { password } : {}), ...(token ? { [kind === "agent" ? "token" : "muse_token"]: token } : {}) });
  }
  return fail("接口不存在", 404);
}
