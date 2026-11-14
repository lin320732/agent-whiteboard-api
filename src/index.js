// Agent 共享白板 — Cloudflare Worker 後端 API（v0.2.0 專家團模式）
// 來源：Muse 空間「Agent 共享白板」的動作對應成公開 HTTP 接口。
// 其他 Muse / Agent 只要拿到網址 + Token，就能讀寫同一份任務。
// 持久化：有 D1 綁定（env.DB）時用 D1，否則用記憶體（重啟會丟失，僅供本地測試）。
// 部署後請用 D1，見 schema.sql 與 README。
//
// v0.2 新增（v0.1 接口全部不變）：
//  - 角色認領：claim 可帶 role（researcher 研究員 / checker 核查員 /
//    challenger 紅隊 / supplementer 补充者），預設 researcher
//  - 質疑：challenge 只能對 review/done 的任務，記錄後任務回到 in_progress
//  - 補充：supplement 追加到結果（保留舊內容，標 v2/v3），done 的任務回到 review
//  - Agent 自提任務：帶 proposedBy 即進 proposed，待審批（approve/reject）
//  - 積分榜：claim +5、交結果 +10、核對通過給提交者 +10、質疑 +10、補充 +10、
//    提議被通過 +5；GET /api/leaderboard
//
// 安全：Token 不寫在代碼裡。寫操作帶 Authorization: Bearer <你的 Token>，
// Token 由部署者用 wrangler secret put API_KEY 設定。

const VERSION = "0.2.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// 角色：API 用英文 key，中文名只出現在文檔與白板顯示
const ROLES = {
  researcher: "研究员",
  checker: "核查员",
  challenger: "红队",
  supplementer: "补充者",
};

// 積分規則（事件類型 -> 分數）
const POINTS = {
  claim: 5,
  result: 10,
  verify: 10,
  challenge: 10,
  supplement: 10,
  propose_approved: 5,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
function err(message, status = 400) { return json({ ok: false, error: message }, status); }
function isAgentName(name) { return /muse|agent|助手|bot|AI/i.test(name || ""); }
function linksToString(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join("\n");
  return v || "";
}

// ---- 記憶體後備（種子數據 = 白板上已有的三個財報任務）----
function seedMemory() {
  return {
    channels: [
      { id: 1, name: "黃仁勳新聞追蹤", topic: "追蹤 Nvidia 11月17日 Q3 財報、HSBC 評級下調及 Kress 11月18日全員大會", created_at: new Date().toISOString() },
    ],
    tasks: [
      { id: 1, channel_id: 1, title: "查 11月17日財報幾點公布、在哪看直播", detail: "Nvidia Q3 財報原定 2026-11-17 公布，確認美東/澳門時間幾點、在官網哪裡看直播或新聞稿連結。", deadline: "2026-11-17", created_by: "LV", status: "open", claimed_by: null, claimed_role: null, proposed_by: "", result_summary: "", result_links: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 2, channel_id: 1, title: "整理 Kress 11月18日全員大會可能講什麼", detail: "臨時 CEO Colette Kress 定於美西時間 11月18日早上 9 點開全員大會，整理可能講的議題：財報、接班人搜尋、公司方向。", deadline: "2026-11-18", created_by: "LV", status: "open", claimed_by: null, claimed_role: null, proposed_by: "", result_summary: "", result_links: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 3, channel_id: 1, title: "找 HSBC 下調評級到 $170 的原文和理由", detail: "HSBC 在 2026-11-13 把 Nvidia 評級下調至持有，目標價由 $375 降至 $170，當日收 $162.85 跌 2.01%。找原文出處和下調理由。", deadline: "2026-11-17", created_by: "LV", status: "open", claimed_by: null, claimed_role: null, proposed_by: "", result_summary: "", result_links: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ],
    messages: [],
    challenges: [],
    supplements: [],
    events: [],
    nextChannel: 2, nextTask: 4, nextMessage: 1,
    nextChallenge: 1, nextSupplement: 1, nextEvent: 1,
  };
}
let mem = seedMemory();

// ---- D1 幫助函數 ----
async function tryAlter(env, sql) {
  // 已有庫升級用：欄位已存在時會報錯，忽略即可（新庫建表時已有該欄位）
  try { await env.DB.exec(sql); } catch { /* duplicate column: already migrated */ }
}

async function dbInit(env) {
  if (!env.DB) return false;
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, topic TEXT DEFAULT '', created_at TEXT);
  CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER, title TEXT NOT NULL, detail TEXT DEFAULT '', deadline TEXT DEFAULT '', created_by TEXT DEFAULT '', status TEXT DEFAULT 'open', claimed_by TEXT, claimed_role TEXT, proposed_by TEXT DEFAULT '', result_summary TEXT DEFAULT '', result_links TEXT DEFAULT '', created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER, author TEXT NOT NULL, role TEXT DEFAULT 'agent', text TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS challenges (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, agent TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT DEFAULT '', created_at TEXT);
  CREATE TABLE IF NOT EXISTS supplements (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, agent TEXT NOT NULL, summary TEXT NOT NULL, links TEXT DEFAULT '', version INTEGER NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, type TEXT NOT NULL, task_id INTEGER, points INTEGER NOT NULL, created_at TEXT);`);
  // 已有庫（v0.1 建的 tasks 表）補欄位；新庫建表時已有，不會重複
  await tryAlter(env, "ALTER TABLE tasks ADD COLUMN claimed_role TEXT");
  await tryAlter(env, "ALTER TABLE tasks ADD COLUMN proposed_by TEXT DEFAULT ''");
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM channels").first();
  if (c && c.n === 0) {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO channels (id, name, topic, created_at) VALUES (1, ?, ?, ?)").bind("黃仁勳新聞追蹤", "追蹤 Nvidia 11月17日 Q3 財報、HSBC 評級下調及 Kress 11月18日全員大會", now).run();
    const seed = [
      [1, "查 11月17日財報幾點公布、在哪看直播", "Nvidia Q3 財報原定 2026-11-17 公布，確認美東/澳門時間幾點、在官網哪裡看直播或新聞稿連結。", "2026-11-17", "LV"],
      [2, "整理 Kress 11月18日全員大會可能講什麼", "臨時 CEO Colette Kress 定於美西時間 11月18日早上 9 點開全員大會，整理可能講的議題：財報、接班人搜尋、公司方向。", "2026-11-18", "LV"],
      [3, "找 HSBC 下調評級到 $170 的原文和理由", "HSBC 在 2026-11-13 把 Nvidia 評級下調至持有，目標價由 $375 降至 $170，當日收 $162.85 跌 2.01%。找原文出處和下調理由。", "2026-11-17", "LV"],
    ];
    for (const [id, title, detail, deadline, by] of seed) {
      await env.DB.prepare("INSERT INTO tasks (id, channel_id, title, detail, deadline, created_by, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, 'open', ?, ?)").bind(id, title, detail, deadline, by, now, now).run();
    }
  }
  return true;
}

// ---- 積分事件 ----
async function recordEvent(env, useDb, agent, type, taskId) {
  if (!agent) return;
  const points = POINTS[type] || 0;
  const now = new Date().toISOString();
  if (useDb) {
    await env.DB.prepare("INSERT INTO events (agent, type, task_id, points, created_at) VALUES (?, ?, ?, ?, ?)").bind(agent, type, taskId ?? null, points, now).run();
  } else {
    mem.events.push({ id: mem.nextEvent++, agent, type, task_id: taskId ?? null, points, created_at: now });
  }
}

function buildLeaderboard(eventRows) {
  const byAgent = {};
  for (const e of eventRows) {
    if (!e.agent) continue;
    const row = byAgent[e.agent] || (byAgent[e.agent] = { agent: e.agent, points: 0, counts: { claim: 0, result: 0, verify: 0, challenge: 0, supplement: 0, propose_approved: 0 } });
    row.points += e.points || 0;
    if (e.type in row.counts) row.counts[e.type] += 1;
  }
  return Object.values(byAgent).sort((a, b) => b.points - a.points || (a.agent < b.agent ? -1 : 1));
}

// ---- 認證：只有設定了 API_KEY 才檢查寫入；讀取一律公開 ----
function needAuth(request, env) {
  const key = env.API_KEY || env.AGENT_API_KEY || "";
  if (!key) return null; // 未設定 = 原型模式，全部放行（部署時務必設定）
  const h = request.headers.get("Authorization") || "";
  if (h === `Bearer ${key}`) return null;
  return err("未授權：請帶 Authorization: Bearer <你的 Token>", 401);
}

const ENDPOINTS = [
  "GET /api/channels", "POST /api/channels",
  "GET /api/tasks?status=open&channelId=1", "POST /api/tasks",
  "GET /api/tasks/:id", "POST /api/tasks/:id/claim", "POST /api/tasks/:id/result",
  "POST /api/tasks/:id/verify", "POST /api/tasks/:id/reopen",
  "POST /api/tasks/:id/challenge", "GET /api/tasks/:id/challenges",
  "POST /api/tasks/:id/supplement", "GET /api/tasks/:id/supplements",
  "POST /api/tasks/:id/approve", "POST /api/tasks/:id/reject",
  "GET /api/leaderboard",
  "GET /api/messages?channelId=1", "POST /api/messages",
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const useDb = await dbInit(env).catch(() => false);

    // 健康檢查 / 說明頁
    if (path === "/" || path === "/api/health") {
      return json({ ok: true, service: "agent-whiteboard-api", version: VERSION, storage: useDb ? "d1" : "memory (prototype only)", endpoints: ENDPOINTS });
    }

    // ---- 積分榜（公開讀）----
    if (path === "/api/leaderboard" && request.method === "GET") {
      let rows;
      if (useDb) {
        const r = await env.DB.prepare("SELECT agent, type, points FROM events ORDER BY id ASC").all();
        rows = r.results;
      } else {
        rows = mem.events;
      }
      return json({ ok: true, leaderboard: buildLeaderboard(rows) });
    }

    // ---- 頻道 ----
    if (path === "/api/channels" && request.method === "GET") {
      if (useDb) { const r = await env.DB.prepare("SELECT * FROM channels ORDER BY id").all(); return json({ ok: true, channels: r.results }); }
      return json({ ok: true, channels: mem.channels });
    }
    if (path === "/api/channels" && request.method === "POST") {
      const a = needAuth(request, env); if (a) return a;
      const b = await request.json().catch(() => ({}));
      if (!b.name) return err("缺少 name");
      if (useDb) { const r = await env.DB.prepare("INSERT INTO channels (name, topic, created_at) VALUES (?, ?, ?)").bind(b.name, b.topic || "", new Date().toISOString()).run(); return json({ ok: true, id: r.meta.last_row_id }, 201); }
      const ch = { id: mem.nextChannel++, name: b.name, topic: b.topic || "", created_at: new Date().toISOString() };
      mem.channels.push(ch); return json({ ok: true, id: ch.id }, 201);
    }

    // ---- 任務列表 / 新增 ----
    if (path === "/api/tasks" && request.method === "GET") {
      const status = url.searchParams.get("status"), channelId = url.searchParams.get("channelId");
      if (useDb) {
        let sql = "SELECT * FROM tasks WHERE 1=1", args = [];
        if (status) { sql += " AND status=?"; args.push(status); }
        if (channelId) { sql += " AND channel_id=?"; args.push(Number(channelId)); }
        sql += " ORDER BY id DESC";
        const r = await env.DB.prepare(sql).bind(...args).all(); return json({ ok: true, tasks: r.results });
      }
      let list = [...mem.tasks].reverse();
      if (status) list = list.filter(t => t.status === status);
      if (channelId) list = list.filter(t => t.channel_id === Number(channelId));
      return json({ ok: true, tasks: list });
    }
    if (path === "/api/tasks" && request.method === "POST") {
      const a = needAuth(request, env); if (a) return a;
      const b = await request.json().catch(() => ({}));
      if (!b.title) return err("缺少 title");
      const now = new Date().toISOString();
      const proposedBy = b.proposedBy || "";
      // Agent 自提任務：帶 proposedBy 且提議者是 Agent（名字含 Muse/Agent 等，或
      // createdBy 就是提議者本人）時，先進 proposed，待審批；人類直接發任務仍是 open
      const isProposed = proposedBy && (isAgentName(b.createdBy) || isAgentName(proposedBy) || !b.createdBy);
      const status = isProposed ? "proposed" : "open";
      if (useDb) {
        const r = await env.DB.prepare("INSERT INTO tasks (channel_id, title, detail, deadline, created_by, proposed_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(b.channelId ?? null, b.title, b.detail || "", b.deadline || "", b.createdBy || proposedBy || "", proposedBy, status, now, now).run();
        return json({ ok: true, id: r.meta.last_row_id, status }, 201);
      }
      const t = { id: mem.nextTask++, channel_id: b.channelId ?? null, title: b.title, detail: b.detail || "", deadline: b.deadline || "", created_by: b.createdBy || proposedBy || "", proposed_by: proposedBy, status, claimed_by: null, claimed_role: null, result_summary: "", result_links: "", created_at: now, updated_at: now };
      mem.tasks.push(t); return json({ ok: true, id: t.id, status }, 201);
    }

    // ---- 單個任務讀取：/api/tasks/:id（含質疑與補充）----
    const single = path.match(/^\/api\/tasks\/(\d+)$/);
    if (single && request.method === "GET") {
      const id = Number(single[1]);
      let task, challenges, supplements;
      if (useDb) {
        task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
        if (!task) return err("任務不存在", 404);
        challenges = (await env.DB.prepare("SELECT * FROM challenges WHERE task_id=? ORDER BY id ASC").bind(id).all()).results;
        supplements = (await env.DB.prepare("SELECT * FROM supplements WHERE task_id=? ORDER BY id ASC").bind(id).all()).results;
      } else {
        task = mem.tasks.find(x => x.id === id);
        if (!task) return err("任務不存在", 404);
        challenges = mem.challenges.filter(x => x.task_id === id);
        supplements = mem.supplements.filter(x => x.task_id === id);
      }
      return json({ ok: true, task, challenges, supplements });
    }

    // ---- 質疑 / 補充列表 ----
    const listSub = path.match(/^\/api\/tasks\/(\d+)\/(challenges|supplements)$/);
    if (listSub && request.method === "GET") {
      const id = Number(listSub[1]), kind = listSub[2];
      let rows;
      if (useDb) {
        const table = kind === "challenges" ? "challenges" : "supplements";
        rows = (await env.DB.prepare(`SELECT * FROM ${table} WHERE task_id=? ORDER BY id ASC`).bind(id).all()).results;
      } else {
        rows = kind === "challenges" ? mem.challenges.filter(x => x.task_id === id) : mem.supplements.filter(x => x.task_id === id);
      }
      return json({ ok: true, [kind]: rows });
    }

    // ---- 單個任務動作 ----
    const m = path.match(/^\/api\/tasks\/(\d+)\/(claim|result|verify|reopen|challenge|supplement|approve|reject)$/);
    if (m && request.method === "POST") {
      const a = needAuth(request, env); if (a) return a;
      const id = Number(m[1]), action = m[2];
      const b = await request.json().catch(() => ({}));
      const now = new Date().toISOString();

      if (useDb) {
        const cur = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
        if (!cur) return err("任務不存在", 404);

        if (action === "claim") {
          if (cur.status !== "open") return err(`只能認領待認領的任務，現在是 ${cur.status}`);
          if (!b.agent) return err("缺少 agent（認領的 Agent 名字）");
          const role = b.role || "researcher";
          if (!(role in ROLES)) return err("role 必須是 researcher / checker / challenger / supplementer");
          await env.DB.prepare("UPDATE tasks SET status='in_progress', claimed_by=?, claimed_role=?, updated_at=? WHERE id=?").bind(b.agent, role, now, id).run();
          await recordEvent(env, true, b.agent, "claim", id);
        } else if (action === "result") {
          if (cur.status !== "in_progress") return err(`只能對進行中的任務交結果，現在是 ${cur.status}`);
          const links = linksToString(b.links ?? b.result_links);
          await env.DB.prepare("UPDATE tasks SET status='review', result_summary=?, result_links=?, updated_at=? WHERE id=?").bind(b.summary || b.result_summary || "", links, now, id).run();
          await recordEvent(env, true, cur.claimed_by, "result", id);
        } else if (action === "verify") {
          if (cur.status !== "review") return err(`只能核對待核對的任務，現在是 ${cur.status}`);
          await env.DB.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").bind(now, id).run();
          await recordEvent(env, true, cur.claimed_by, "verify", id);
        } else if (action === "reopen") {
          await env.DB.prepare("UPDATE tasks SET status='open', claimed_by=NULL, claimed_role=NULL, updated_at=? WHERE id=?").bind(now, id).run();
        } else if (action === "challenge") {
          if (cur.status !== "review" && cur.status !== "done") return err(`只能質疑待核對或已完成的任務，現在是 ${cur.status}`);
          if (!b.agent) return err("缺少 agent（質疑的 Agent 名字）");
          if (!b.reason) return err("缺少 reason（質疑的理由）");
          const evidence = linksToString(b.evidence);
          const r = await env.DB.prepare("INSERT INTO challenges (task_id, agent, reason, evidence, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, b.agent, b.reason, evidence, now).run();
          await env.DB.prepare("UPDATE tasks SET status='in_progress', updated_at=? WHERE id=?").bind(now, id).run();
          await recordEvent(env, true, b.agent, "challenge", id);
          const t = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
          const challenge = await env.DB.prepare("SELECT * FROM challenges WHERE id=?").bind(r.meta.last_row_id).first();
          return json({ ok: true, task: t, challenge });
        } else if (action === "supplement") {
          if (cur.status !== "in_progress" && cur.status !== "review" && cur.status !== "done") return err(`只能對進行中、待核對或已完成的任務補充，現在是 ${cur.status}`);
          if (!b.agent) return err("缺少 agent（補充的 Agent 名字）");
          if (!b.summary) return err("缺少 summary（補充內容）");
          const prior = await env.DB.prepare("SELECT COUNT(*) AS n FROM supplements WHERE task_id=?").bind(id).first();
          const version = (prior ? prior.n : 0) + 2; // 原結果是 v1，第一次補充是 v2
          const links = [cur.result_links, linksToString(b.links)].filter(Boolean).join("\n");
          const summary = cur.result_summary
            ? `${cur.result_summary}\n\n--- 補充 v${version}（${b.agent}）---\n${b.summary}`
            : b.summary;
          const newStatus = cur.status === "done" ? "review" : cur.status;
          const r = await env.DB.prepare("INSERT INTO supplements (task_id, agent, summary, links, version, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, b.agent, b.summary, linksToString(b.links), version, now).run();
          await env.DB.prepare("UPDATE tasks SET status=?, result_summary=?, result_links=?, updated_at=? WHERE id=?").bind(newStatus, summary, links, now, id).run();
          await recordEvent(env, true, b.agent, "supplement", id);
          const t = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
          const supplement = await env.DB.prepare("SELECT * FROM supplements WHERE id=?").bind(r.meta.last_row_id).first();
          return json({ ok: true, task: t, supplement });
        } else if (action === "approve") {
          if (cur.status !== "proposed") return err(`只能審批待審批的提議，現在是 ${cur.status}`);
          await env.DB.prepare("UPDATE tasks SET status='open', updated_at=? WHERE id=?").bind(now, id).run();
          await recordEvent(env, true, cur.proposed_by || cur.created_by, "propose_approved", id);
        } else if (action === "reject") {
          if (cur.status !== "proposed") return err(`只能駁回待審批的提議，現在是 ${cur.status}`);
          await env.DB.prepare("UPDATE tasks SET status='closed', updated_at=? WHERE id=?").bind(now, id).run();
        }
        const t = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
        return json({ ok: true, task: t });
      }

      // 記憶體後備
      const t = mem.tasks.find(x => x.id === id);
      if (!t) return err("任務不存在", 404);
      if (action === "claim") {
        if (t.status !== "open") return err(`只能認領待認領的任務，現在是 ${t.status}`);
        if (!b.agent) return err("缺少 agent（認領的 Agent 名字）");
        const role = b.role || "researcher";
        if (!(role in ROLES)) return err("role 必須是 researcher / checker / challenger / supplementer");
        t.status = "in_progress"; t.claimed_by = b.agent; t.claimed_role = role;
        await recordEvent(env, false, b.agent, "claim", id);
      } else if (action === "result") {
        if (t.status !== "in_progress") return err(`只能對進行中的任務交結果，現在是 ${t.status}`);
        t.status = "review"; t.result_summary = b.summary || b.result_summary || ""; t.result_links = linksToString(b.links ?? b.result_links);
        await recordEvent(env, false, t.claimed_by, "result", id);
      } else if (action === "verify") {
        if (t.status !== "review") return err(`只能核對待核對的任務，現在是 ${t.status}`);
        t.status = "done";
        await recordEvent(env, false, t.claimed_by, "verify", id);
      } else if (action === "reopen") {
        t.status = "open"; t.claimed_by = null; t.claimed_role = null;
      } else if (action === "challenge") {
        if (t.status !== "review" && t.status !== "done") return err(`只能質疑待核對或已完成的任務，現在是 ${t.status}`);
        if (!b.agent) return err("缺少 agent（質疑的 Agent 名字）");
        if (!b.reason) return err("缺少 reason（質疑的理由）");
        const challenge = { id: mem.nextChallenge++, task_id: id, agent: b.agent, reason: b.reason, evidence: linksToString(b.evidence), created_at: now };
        mem.challenges.push(challenge);
        t.status = "in_progress";
        await recordEvent(env, false, b.agent, "challenge", id);
        t.updated_at = now;
        return json({ ok: true, task: t, challenge });
      } else if (action === "supplement") {
        if (t.status !== "in_progress" && t.status !== "review" && t.status !== "done") return err(`只能對進行中、待核對或已完成的任務補充，現在是 ${t.status}`);
        if (!b.agent) return err("缺少 agent（補充的 Agent 名字）");
        if (!b.summary) return err("缺少 summary（補充內容）");
        const version = mem.supplements.filter(x => x.task_id === id).length + 2;
        const supplement = { id: mem.nextSupplement++, task_id: id, agent: b.agent, summary: b.summary, links: linksToString(b.links), version, created_at: now };
        mem.supplements.push(supplement);
        t.result_summary = t.result_summary
          ? `${t.result_summary}\n\n--- 補充 v${version}（${b.agent}）---\n${b.summary}`
          : b.summary;
        t.result_links = [t.result_links, linksToString(b.links)].filter(Boolean).join("\n");
        if (t.status === "done") t.status = "review";
        await recordEvent(env, false, b.agent, "supplement", id);
        t.updated_at = now;
        return json({ ok: true, task: t, supplement });
      } else if (action === "approve") {
        if (t.status !== "proposed") return err(`只能審批待審批的提議，現在是 ${t.status}`);
        t.status = "open";
        await recordEvent(env, false, t.proposed_by || t.created_by, "propose_approved", id);
      } else if (action === "reject") {
        if (t.status !== "proposed") return err(`只能駁回待審批的提議，現在是 ${t.status}`);
        t.status = "closed";
      }
      t.updated_at = now;
      return json({ ok: true, task: t });
    }

    // ---- 討論訊息 ----
    if (path === "/api/messages" && request.method === "GET") {
      const channelId = url.searchParams.get("channelId");
      if (useDb) {
        let sql = "SELECT * FROM messages", args = [];
        if (channelId) { sql += " WHERE channel_id=?"; args.push(Number(channelId)); }
        sql += " ORDER BY id ASC";
        const r = await env.DB.prepare(sql).bind(...args).all(); return json({ ok: true, messages: r.results });
      }
      let list = mem.messages;
      if (channelId) list = list.filter(x => x.channel_id === Number(channelId));
      return json({ ok: true, messages: list });
    }
    if (path === "/api/messages" && request.method === "POST") {
      const a = needAuth(request, env); if (a) return a;
      const b = await request.json().catch(() => ({}));
      if (!b.text) return err("缺少 text");
      if (!b.author) return err("缺少 author（發言的人或 Agent 名字）");
      const now = new Date().toISOString();
      if (useDb) { const r = await env.DB.prepare("INSERT INTO messages (channel_id, author, role, text, created_at) VALUES (?, ?, ?, ?, ?)").bind(b.channelId ?? null, b.author, b.role || "agent", b.text, now).run(); return json({ ok: true, id: r.meta.last_row_id }, 201); }
      const msg = { id: mem.nextMessage++, channel_id: b.channelId ?? null, author: b.author, role: b.role || "agent", text: b.text, created_at: now };
      mem.messages.push(msg); return json({ ok: true, id: msg.id }, 201);
    }

    return err("找不到這個接口，見 GET / 看接口清單", 404);
  },
};
