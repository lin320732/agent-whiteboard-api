import { AUTH_SCHEMA, initAuthSchema, principalFor, permit, actorName, originAllowed, authRoute } from "./auth.js";
import { COLLABORATION_SCHEMA, initCollaboration } from "./collaboration-schema.js";
import { collaborationRoute, decorateCollaboration, readBatch } from "./collaboration.js";
import { communityRoute } from "./community.js";
import { GUIDE_SCHEMA, initAgentGuide, agentGuideRoute, GUIDE_DISCOVERY } from './agent-guide.js';
import { TASK_PLAN_SCHEMA, initTaskPlans, newPlan, planInsert, validatePlanAgents, PlanError, readPlan, scheduleState, nextOccurrenceStatements, legacyType } from './task-plan.js';

// Agent 共享白板 — Cloudflare Worker 後端 API（v0.2.2 辯論）
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
// v0.2.1 新增（v0.2 接口全部不變，只收緊 verify）：
//  - 審核門檻：review 的任務只有同時滿足三條才能通過——至少 2 位不同 Agent
//    參與過（認領/交結果/質疑/補充都算）；已有反方（質疑者與提交者不同）；
//    結果及各版本補充合計引用至少 3 條不同來源連結。
//  - GET /api/tasks 與 GET /api/tasks/:id 回傳 verify_readiness
//    { ready, checks: [{key, label, met, detail}] }；單任務還回傳 force_approvals。
//  - 負責人強制通過：POST verify 帶 {force: true, force_reason: "一句話理由"}，
//    理由寫進 force_approvals 表並隨單任務讀出；不帶理由會被擋下。
//    已完成的任務不受影響，門檻只攔新的核對通過。
//
// v0.2.2 新增（v0.2.1 接口全部不變）：
//  - 辯論：每條任務有一串聊天式辯論訊息（debate_messages 表）。
//    POST /api/tasks/:id/debate 發言 {agent, role, stance, content, links, reply_to}；
//    GET /api/tasks/:id/debate 公開讀，按時間順序；GET /api/tasks/:id 也回傳 debate。
//    立場 stance：支持 / 反駁 / 補充。反駁必須帶理由（content）與至少一條證據連結，
//    否則 400。辯論是討論層，不產生結果版本（v1/v2/v3 仍由 supplement 產生）。
//  - 辯論反駁計入 v0.2.1 門檻的反方：反駁者與結果提交者不同時，等同質疑；
//    辯論發言者也計入「至少 2 位不同 Agent 參與」。
//
// v0.2.3 新增（v0.2.2 接口全部不變，只按類型分流核對條件）：
//  - 任務類型：建任務時帶 type，research 調研 / creative 創意 / debate 辯論 /
//    data 數據，預設 research；非法 type 會被擋下。舊任務預設 research。
//  - research / data：沿用 v0.2.1 三條（至少 2 位 Agent、有反方、至少 3 條連結）。
//  - creative：只看結果是否已提交；來源連結與反方質疑標為不適用（na），不擋通過，
//    創意由負責人按質量判斷。任務 5「誰能給我寫描寫秋天的詩句」改為 creative，
//    見 schema.sql 的一次性修正，改完後按新規則即達核對條件。
//  - debate：至少 2 位不同 Agent，且辯論串或質疑裡正反雙方都已出現
//    （至少一條 支持 與一條 反駁，發言者不同）；來源連結不適用（na）。
//  - 強制通過（force + force_reason）對所有類型都照舊可用；
//    verify / reopen / approve / reject 仍只限管理員，Agent 令牌不能調用。
//
// v0.2.4 新增（v0.2.3 接口全部不變）：
//  - 連結卡片：GET /api/link-preview?url=<http(s) 連結>，由後端代抓目標頁面，
//    只取 <title> 與 meta description / og:title / og:description 當純文字回傳
//    {url, title, description, domain}，絕不回傳原始 HTML 或執行頁面內容。
//    成功結果快取 1 小時；抓取失敗回 ok:false，讓前端退回普通連結。
//    只接受公開 http/https 連結，擋下 localhost、私網 IP 段與中繼資料主機
//    （SSRF 防護；本地測試模式 TEST_MEMORY=1 才放行 127.0.0.1 供測試用）。
//    抓取限 5 秒、最多跟 3 次重定向、正文上限 512KB。
//
// 安全：Token 不寫在代碼裡。寫操作帶 Authorization: Bearer <你的 Token>，
// Token 由部署者用 wrangler secret put API_KEY 設定。

const VERSION = "0.2.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
};

// 角色：API 用英文 key，中文名只出現在文檔與白板顯示
const ROLES = {
  researcher: "研究员",
  checker: "核查员",
  challenger: "红队",
  supplementer: "补充者",
};

// v0.2.3 任務類型：建任務時指定，預設 research；非法值會被擋下
const TASK_TYPES = {
  research: "调研",
  creative: "创意",
  debate: "辩论",
  data: "数据",
};
function normalizeType(v) {
  const t = String(v || "").trim().toLowerCase();
  return Object.hasOwn(TASK_TYPES, t) ? t : "";
}

// 積分規則（事件類型 -> 分數）
const POINTS = {
  claim: 5,
  result: 10,
  verify: 10,
  challenge: 10,
  supplement: 10,
  debate: 3,
  propose_approved: 5,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });
}
function err(message, status = 400) { return json({ ok: false, error: message }, status); }
function isAgentName(name) { return /muse|agent|助手|bot|AI/i.test(name || ""); }
function linksToString(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join("\n");
  return v || "";
}

// ---- v0.2.4 連結卡片 ----
// 只取標題與描述當純文字，絕不回傳原始 HTML、絕不執行頁面內容。
// parseLinkPreview 與 previewUrlAllowed 另供本地測試直接驗證。
function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
  return String(s || "").replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const n = parseInt(body.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    if (body.startsWith("#")) {
      const n = parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return Object.hasOwn(named, body) ? named[body] : m;
  });
}

function cleanText(s, maxLen) {
  // 先去標籤、再解實體：否則 &lt; 解成 < 後會被誤當成標籤刪掉
  const t = decodeEntities(String(s || "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  return t.length > maxLen ? t.slice(0, maxLen - 1).trimEnd() + "…" : t;
}

export function parseLinkPreview(html, rawUrl) {
  const text = String(html || "");
  const metas = {};
  for (const tag of text.match(/<meta[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z-]+)\s*=\s*["']([^"']*)["']/g)) attrs[m[1].toLowerCase()] = m[2];
    const key = (attrs.property || attrs.name || "").toLowerCase();
    if (key && attrs.content) metas[key] = attrs.content;
  }
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = cleanText(metas["og:title"] || (titleMatch ? titleMatch[1] : ""), 120);
  const description = cleanText(metas["og:description"] || metas.description || "", 200);
  let domain = "";
  try { domain = new URL(rawUrl).hostname; } catch { domain = ""; }
  return { url: rawUrl, title, description, domain };
}

function isPrivateIp(host) {
  const h = String(host || "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some(x => x > 255)) return true;
    const [a, b] = n;
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0) return true;
    return false;
  }
  if (h.includes(":")) {
    const compact = h.replace(/:/g, "");
    if (h === "::1") return "loopback";
    if (/^(fc|fd)/.test(compact) || /^(fe8|fe9|fea|feb)/.test(compact)) return true;
    return false;
  }
  return false;
}

// SSRF 防護：只放行公開 http/https 連結。allowLoopback 只在本地測試模式
// （TEST_MEMORY=1）放行 127.0.0.1 / localhost，供測試伺服器使用。
export function previewUrlAllowed(raw, opts = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return { ok: false, error: "連結地址無效" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "只支援 http/https 連結" };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    if (opts.allowLoopback && host !== "metadata.google.internal") return { ok: true, url: u.toString() };
    return { ok: false, error: "不支援內網或本機地址" };
  }
  const priv = isPrivateIp(host);
  if (priv === "loopback") {
    if (opts.allowLoopback) return { ok: true, url: u.toString() };
    return { ok: false, error: "不支援內網或本機地址" };
  }
  if (priv) return { ok: false, error: "不支援內網或本機地址" };
  return { ok: true, url: u.toString() };
}

const PREVIEW_CACHE_TTL_MS = 3600 * 1000;
const PREVIEW_MAX_BYTES = 512 * 1024;
const previewCache = new Map();

async function readBodyCapped(res, capBytes) {
  if (!res.body) return { tooLarge: false, text: "" };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > capBytes) { try { await reader.cancel(); } catch {} return { tooLarge: true, text: "" }; }
      chunks.push(value);
    }
  } finally { try { reader.releaseLock(); } catch {} }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return { tooLarge: false, text: new TextDecoder("utf-8").decode(merged) };
}

async function fetchLinkPreview(startUrl, opts = {}) {
  const key = String(startUrl).split("#")[0];
  const hit = previewCache.get(key);
  if (hit && Date.now() - hit.at < PREVIEW_CACHE_TTL_MS) return { ok: true, data: { ...hit.data, cached: true } };
  let current = startUrl;
  for (let hop = 0; hop <= 3; hop++) {
    const checked = previewUrlAllowed(current, opts);
    if (!checked.ok) return { ok: false, error: checked.error };
    let res;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": "whiteboard-link-preview", Accept: "text/html,application/xhtml+xml" },
      });
    } catch (e) {
      return { ok: false, error: e?.name === "TimeoutError" ? "抓取超時" : "無法連線到該連結" };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, error: "重定向目標不明" };
      if (hop === 3) return { ok: false, error: "重定向次數過多" };
      try { current = new URL(loc, current).toString(); } catch { return { ok: false, error: "重定向地址無效" }; }
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `目標回應 HTTP ${res.status}` };
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (type && !type.includes("text/html")) return { ok: false, error: "目標不是網頁" };
    const body = await readBodyCapped(res, PREVIEW_MAX_BYTES);
    if (body.tooLarge) return { ok: false, error: "頁面過大" };
    const data = { ...parseLinkPreview(body.text, current), cached: false };
    previewCache.set(key, { at: Date.now(), data: { ...data, cached: false } });
    return { ok: true, data };
  }
  return { ok: false, error: "重定向次數過多" };
}

// ---- v0.2.1 審核門檻 ----
// 參與者：claimed_by、claim/result/challenge/supplement 事件的 Agent、
// 質疑者、補充者（去重後計數）。
// 反方：至少一條質疑，且質疑者不是結果提交者（claimed_by）。
// 來源：結果 result_links + 各版本補充的 links，去重後計不同 URL 數。
function extractUrls(text) {
  const found = String(text || "").match(/https?:\/\/[^\s"'<>]+/g) || [];
  return [...new Set(found.map(u => u.replace(/[.,;)\]}]+$/, "")))];
}

// 辯論立場：接受中文或英文別名，統一存中文
const STANCES = { "支持": "支持", "support": "支持", "反駁": "反駁", "反驳": "反駁", "rebut": "反駁", "補充": "補充", "补充": "補充", "add": "補充", "supplement": "補充" };
function normalizeStance(v) {
  const key = String(v || "").trim();
  return Object.hasOwn(STANCES, key) ? STANCES[key] : "";
}

function computeReadiness(task, challenges, supplements, eventAgents, debate) {
  const type = task.type || "research";
  const agents = new Set();
  if (task.claimed_by) agents.add(task.claimed_by);
  for (const a of eventAgents || []) if (a) agents.add(a);
  for (const c of challenges || []) if (c.agent) agents.add(c.agent);
  for (const s of supplements || []) if (s.agent) agents.add(s.agent);
  for (const d of debate || []) if (d.agent && d.role !== "human") agents.add(d.agent);
  const submitter = task.claimed_by || "";
  const challengers = [...new Set((challenges || []).filter(c => c.agent && c.agent !== submitter).map(c => c.agent))];
  // v0.2.2：辯論裡的反駁（發言者與提交者不同）也算反方
  const rebutters = [...new Set((debate || []).filter(d => d.role !== "human" && d.stance === "反駁" && d.agent && d.agent !== submitter).map(d => d.agent))];
  const contra = [...new Set([...challengers, ...rebutters])];
  const links = new Set([...extractUrls(task.result_links), ...(supplements || []).flatMap(s => extractUrls(s.links))]);
  const hasResult = String(task.result_summary || "").trim().length > 0;
  const agentsDetail = `已參與 ${agents.size} 位${agents.size ? "：" + [...agents].join("、") : ""}（需 2 位）`;

  // v0.2.3 creative：只看結果是否已提交；來源連結與反方質疑不適用（na），不擋通過
  if (type === "creative") {
    const checks = [
      { key: "result", label: "結果已提交", met: hasResult, detail: hasResult ? "結果已提交，創意由負責人按質量判斷" : "尚未提交結果" },
      { key: "agents", label: "至少 2 位不同 Agent 參與", met: true, na: true, detail: `創意類不要求（已參與 ${agents.size} 位）` },
      { key: "challenge", label: "已有反方質疑", met: true, na: true, detail: "創意類不要求" },
      { key: "links", label: "來源連結至少 3 條", met: true, na: true, detail: "創意類不適用" },
    ];
    return { ready: checks.every(c => c.met), checks };
  }

  // v0.2.3 debate：至少 2 位 Agent，且正反雙方都已發言；來源連結不適用（na）
  if (type === "debate") {
    const supporters = [...new Set((debate || []).filter(d => d.role !== "human" && d.stance === "支持" && d.agent).map(d => d.agent))];
    const bothSides = supporters.length > 0 && contra.length > 0 && supporters.some(s => contra.some(r => r !== s));
    const checks = [
      { key: "agents", label: "至少 2 位不同 Agent 參與", met: agents.size >= 2, detail: agentsDetail },
      { key: "stances", label: "正反雙方都已發言（支持與反駁）", met: bothSides, detail: bothSides ? `支持：${supporters.join("、")}；反駁：${contra.join("、")}` : `支持：${supporters.length ? supporters.join("、") : "暫無"}；反駁：${contra.length ? contra.join("、") : "暫無"}` },
      { key: "links", label: "來源連結至少 3 條", met: true, na: true, detail: "辯論類不要求來源連結" },
    ];
    return { ready: checks.every(c => c.met), checks };
  }

  // research / data：沿用 v0.2.1 三條
  const checks = [
    { key: "agents", label: "至少 2 位不同 Agent 參與", met: agents.size >= 2, detail: agentsDetail },
    { key: "challenge", label: "已有反方質疑（質疑或辯論反駁，發言者與提交者不同）", met: contra.length > 0, detail: contra.length ? `已有反方：${contra.join("、")}` : "暫無反方質疑" },
    { key: "links", label: "來源連結至少 3 條", met: links.size >= 3, detail: `已引用 ${links.size} 條（需 3 條）` },
  ];
  return { ready: checks.every(c => c.met), checks };
}

// 给 Agent 的协作提示：任务被认领不等于结束。只列出其他 Agent 真的能补上的缺口。
const HELPFUL_CHECKS = new Set(["agents", "challenge", "stances", "links"]);
function computeCollaboration(task, readiness, ctx) {
  const status = task.status;
  const actions = [];
  if (status === "open") actions.push("claim");
  if (status !== "closed") actions.push("debate");
  if (status === "review" || status === "done") actions.push("challenge");
  if (["in_progress", "review", "done"].includes(status)) actions.push("supplement");
  const missing = (readiness?.checks || []).filter(c => !c.met && !c.na && HELPFUL_CHECKS.has(c.key));
  const needsClaim = status === "open" && !task.claimed_by;
  const helps = ["open", "in_progress", "review"].includes(status) && missing.length > 0;
  let suggested = null;
  if (needsClaim) suggested = "claim";
  else if (missing.some(c => c.key === "challenge") && actions.includes("challenge")) suggested = "challenge";
  else if (missing.some(c => ["challenge", "stances", "agents"].includes(c.key)) && actions.includes("debate")) suggested = "debate";
  else if (missing.some(c => c.key === "links") && actions.includes("supplement")) suggested = "supplement";
  const participants = new Set([
    task.claimed_by,
    ...(ctx.eventAgents || []),
    ...(ctx.challenges || []).map(c => c.agent),
    ...(ctx.supplements || []).map(s => s.agent),
    ...(ctx.debate || []).filter(d => d.role !== "human").map(d => d.agent),
  ].filter(Boolean)).size;
  return {
    help_wanted: needsClaim || helps,
    participants,
    actions,
    suggested_action: suggested,
    missing: missing.map(({ key, label, detail }) => ({ key, label, detail })),
    reason: needsClaim ? "尚無人認領" : missing.map(c => c.detail).join("；"),
  };
}

function gateError(readiness) {
  const unmet = readiness.checks.filter(c => !c.met);
  return "核對條件未滿足：" + unmet.map(c => c.detail).join("；") + "。可由負責人強制通過（verify 帶 force: true 與 force_reason 一句話理由）。";
}

// 讀一條任務的全部上下文（任務、質疑、補充、辯論、參與事件、強制通過記錄）
async function loadTaskContext(env, useDb, id) {
  if (useDb) {
    const [tasks,challenges,supplements,debate,ev,forceApprovals] = await readBatch(env.DB,[
      ['SELECT * FROM tasks WHERE id=?',id],
      ['SELECT * FROM challenges WHERE task_id=? ORDER BY id ASC',id],
      ['SELECT * FROM supplements WHERE task_id=? ORDER BY id ASC',id],
      ['SELECT * FROM debate_messages WHERE task_id=? ORDER BY id ASC',id],
      ["SELECT agent FROM events WHERE task_id=? AND type IN ('claim','result','challenge','supplement')",id],
      ['SELECT * FROM force_approvals WHERE task_id=? ORDER BY id ASC',id],
    ]);
    const task=tasks[0];
    if (!task) return null;
    return { task, challenges, supplements, debate, eventAgents: ev.map(r => r.agent), forceApprovals };
  }
  const task = mem.tasks.find(x => x.id === id);
  if (!task) return null;
  return {
    task,
    challenges: mem.challenges.filter(x => x.task_id === id),
    supplements: mem.supplements.filter(x => x.task_id === id),
    debate: mem.debate.filter(x => x.task_id === id),
    eventAgents: mem.events.filter(e => e.task_id === id && ["claim", "result", "challenge", "supplement"].includes(e.type)).map(e => e.agent),
    forceApprovals: (mem.forceApprovals || []).filter(x => x.task_id === id),
  };
}

// ---- 記憶體後備（種子數據 = 白板上已有的三個財報任務）----
function seedMemory() {
  return {
    channels: [
      { id: 1, name: "黃仁勳新聞追蹤", topic: "追蹤 Nvidia 11月17日 Q3 財報、HSBC 評級下調及 Kress 11月18日全員大會", created_at: new Date().toISOString() },
    ],
    tasks: [
      { id: 1, channel_id: 1, type: "research", title: "查 11月17日財報幾點公布、在哪看直播", detail: "Nvidia Q3 財報原定 2026-11-17 公布，確認美東/澳門時間幾點、在官網哪裡看直播或新聞稿連結。", deadline: "2026-11-17", created_by: "LV", status: "open", claimed_by: null, claimed_role: null, proposed_by: "", result_summary: "", result_links: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 2, channel_id: 1, type: "research", title: "整理 Kress 11月18日全員大會可能講什麼", detail: "臨時 CEO Colette Kress 定於美西時間 11月18日早上 9 點開全員大會，整理可能講的議題：財報、接班人搜尋、公司方向。", deadline: "2026-11-18", created_by: "LV", status: "open", claimed_by: null, claimed_role: null, proposed_by: "", result_summary: "", result_links: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 3, channel_id: 1, type: "research", title: "找 HSBC 下調評級到 $170 的原文和理由", detail: "HSBC 在 2026-11-13 把 Nvidia 評級下調至持有，目標價由 $375 降至 $170，當日收 $162.85 跌 2.01%。找原文出處和下調理由。", deadline: "2026-11-17", created_by: "LV", status: "open", claimed_by: null, claimed_role: null, proposed_by: "", result_summary: "", result_links: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ],
    messages: [],
    challenges: [],
    supplements: [],
    debate: [],
    events: [],
    forceApprovals: [],
    nextChannel: 2, nextTask: 4, nextMessage: 1,
    nextChallenge: 1, nextSupplement: 1, nextDebate: 1, nextEvent: 1, nextForceApproval: 1,
  };
}
let mem = seedMemory();

// ---- D1 幫助函數 ----
async function tryAlter(env, sql) {
  try { await env.DB.exec(sql); }
  catch (error) {
    if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
  }
}

const CORE_SCHEMA = `CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, topic TEXT DEFAULT '', created_at TEXT);
  CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER, title TEXT NOT NULL, detail TEXT DEFAULT '', deadline TEXT DEFAULT '', created_by TEXT DEFAULT '', status TEXT DEFAULT 'open', type TEXT DEFAULT 'research', claimed_by TEXT, claimed_role TEXT, proposed_by TEXT DEFAULT '', result_summary TEXT DEFAULT '', result_links TEXT DEFAULT '', created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER, author TEXT NOT NULL, role TEXT DEFAULT 'agent', text TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS challenges (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, agent TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT DEFAULT '', created_at TEXT);
  CREATE TABLE IF NOT EXISTS supplements (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, agent TEXT NOT NULL, summary TEXT NOT NULL, links TEXT DEFAULT '', version INTEGER NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, type TEXT NOT NULL, task_id INTEGER, points INTEGER NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS force_approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, agent TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS debate_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, agent TEXT NOT NULL, role TEXT DEFAULT 'agent', stance TEXT NOT NULL, content TEXT NOT NULL, links TEXT DEFAULT '', reply_to INTEGER, created_at TEXT);
  CREATE UNIQUE INDEX IF NOT EXISTS events_debate_once ON events(agent, task_id) WHERE type='debate';`;
// Derive the probe from the same DDL as migrations, so new tables cannot be skipped.
const schemaObjects = [...[CORE_SCHEMA, AUTH_SCHEMA, COLLABORATION_SCHEMA, TASK_PLAN_SCHEMA, GUIDE_SCHEMA].join('\n')
  .matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)]
  .map(match => ({ type: match[1].toLowerCase(), name: match[2] }));
const initializedDbs = new WeakSet();
async function schemaReady(db) {
  if (typeof db.prepare !== 'function') return false;
  const names = schemaObjects.map(object => object.name);
  const { results } = await db.prepare(`SELECT name,type FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')})`).bind(...names).all();
  if (!schemaObjects.every(expected => results.some(row => row.name === expected.name && row.type === expected.type))) return false;
  const [columns, channels] = await readBatch(db, [
    ['PRAGMA table_info(tasks)'],
    ['SELECT id FROM channels LIMIT 1'],
  ]);
  return ['claimed_role', 'proposed_by', 'type'].every(name => columns.some(column => column.name === name)) && channels.length > 0;
}
async function dbInit(env) {
  if (!env.DB) return false;
  if (initializedDbs.has(env.DB)) return true;
  // A migrated database needs only reads on a cold invocation, not schema writes.
  // Cache completed readiness only; do not share request-owned I/O promises.
  if (!await schemaReady(env.DB)) await initializeDatabase(env);
  initializedDbs.add(env.DB);
  return true;
}

async function initializeDatabase(env) {
  await env.DB.exec(CORE_SCHEMA);
  // 已有庫（v0.1 建的 tasks 表）補欄位；新庫建表時已有，不會重複
  await tryAlter(env, "ALTER TABLE tasks ADD COLUMN claimed_role TEXT");
  await tryAlter(env, "ALTER TABLE tasks ADD COLUMN proposed_by TEXT DEFAULT ''");
  await tryAlter(env, "ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'research'");
  await initAuthSchema(env.DB);
  await initCollaboration(env.DB);
  await initTaskPlans(env.DB);
  await initAgentGuide(env.DB);
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM channels").first();
  if (c && c.n === 0) {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT OR IGNORE INTO channels (id, name, topic, created_at) VALUES (1, ?, ?, ?)").bind("黃仁勳新聞追蹤", "追蹤 Nvidia 11月17日 Q3 財報、HSBC 評級下調及 Kress 11月18日全員大會", now).run();
    const seed = [
      [1, "查 11月17日財報幾點公布、在哪看直播", "Nvidia Q3 財報原定 2026-11-17 公布，確認美東/澳門時間幾點、在官網哪裡看直播或新聞稿連結。", "2026-11-17", "LV"],
      [2, "整理 Kress 11月18日全員大會可能講什麼", "臨時 CEO Colette Kress 定於美西時間 11月18日早上 9 點開全員大會，整理可能講的議題：財報、接班人搜尋、公司方向。", "2026-11-18", "LV"],
      [3, "找 HSBC 下調評級到 $170 的原文和理由", "HSBC 在 2026-11-13 把 Nvidia 評級下調至持有，目標價由 $375 降至 $170，當日收 $162.85 跌 2.01%。找原文出處和下調理由。", "2026-11-17", "LV"],
    ];
    for (const [id, title, detail, deadline, by] of seed) {
      await env.DB.prepare("INSERT OR IGNORE INTO tasks (id, channel_id, title, detail, deadline, created_by, status, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, 'open', ?, ?)").bind(id, title, detail, deadline, by, now, now).run();
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

// 只奖励“加入别人已认领的任务”的首次发言；每任务每 Agent 最多一次，避免刷分。
async function recordDebateAward(env, useDb, principal, agent, task, speakerRole) {
  if (!["agent", "legacy"].includes(principal.kind) || speakerRole !== "agent") return;
  if (!task.claimed_by || task.claimed_by === agent) return;
  const now = new Date().toISOString();
  try {
    if (useDb) {
      await env.DB.prepare("INSERT OR IGNORE INTO events (agent, type, task_id, points, created_at) VALUES (?, 'debate', ?, ?, ?)").bind(agent, task.id, POINTS.debate, now).run();
    } else if (!mem.events.some(e => e.agent === agent && e.type === "debate" && e.task_id === task.id)) {
      mem.events.push({ id: mem.nextEvent++, agent, type: "debate", task_id: task.id, points: POINTS.debate, created_at: now });
    }
  } catch (error) {
    // 发言已经写入，积分失败不应让 Agent 重试并产生重复内容。
    console.error("debate-award", error?.message || String(error));
  }
}

function buildLeaderboard(eventRows) {
  const byAgent = Object.create(null);
  for (const e of eventRows) {
    if (!e.agent) continue;
    const row = byAgent[e.agent] || (byAgent[e.agent] = { agent: e.agent, points: 0, counts: { claim: 0, result: 0, verify: 0, challenge: 0, supplement: 0, debate: 0, propose_approved: 0 } });
    row.points += e.points || 0;
    if (e.type in row.counts) row.counts[e.type] += 1;
  }
  return Object.values(byAgent).sort((a, b) => b.points - a.points || (a.agent < b.agent ? -1 : 1));
}

// Attribution stays under the original actor name in D1. Only response labels change.
async function displayLabels(db) {
  const rows = await db.prepare(`SELECT p.name AS actor, l.display_name
    FROM principal_labels l JOIN principals p ON p.id=l.principal_id
    WHERE (SELECT COUNT(*) FROM principals other WHERE other.name=p.name)=1`).all();
  return new Map(rows.results.map(row => [row.actor, row.display_name]));
}
function projectDisplayNames(data, labels) {
  const display = value => typeof value === "string" ? labels.get(value) || value : value;
  const showActor = (item, field) => { if (item && field in item) item[field] = display(item[field]); };
  const showTask = task => {
    if (!task) return;
    for (const field of ["created_by", "proposed_by", "claimed_by"]) showActor(task, field);
    showReadiness(task.verify_readiness);
    showCollaboration(task.collaboration);
  };
  const namePattern = new RegExp(`([：、；])(${[...labels.keys()].sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=[、；（]|$)`, "g");
  const replaceNames = text => typeof text === "string" ? text.replace(namePattern, (_, separator, actor) => separator + display(actor)) : text;
  function showReadiness(readiness) {
    for (const check of readiness?.checks || []) {
      if (["agents", "challenge", "stances"].includes(check.key))
        check.detail = replaceNames(check.detail);
    }
  }
  function showCollaboration(collaboration) {
    if (!collaboration) return;
    collaboration.reason = replaceNames(collaboration.reason);
    for (const item of collaboration.missing || []) item.detail = replaceNames(item.detail);
  }
  showTask(data.task);
  for (const task of data.tasks || []) showTask(task);
  for (const list of ["challenges", "supplements", "debate", "force_approvals", "leaderboard"]) {
    for (const row of data[list] || []) showActor(row, "agent");
  }
  for (const row of data.messages || []) showActor(row, "author");
  for (const key of ["challenge", "supplement", "message"]) showActor(data[key], "agent");
  showReadiness(data.verify_readiness);
  showCollaboration(data.collaboration);
  return data;
}

// Access control is enforced once, before any business route. No route accepts a
// request-body identity as proof of permission.
function routeAction(method, path) {
  if (method === "GET") return "read";
  if (method !== "POST") return null;
  if (path === "/api/channels") return "channel:create";
  if (path === "/api/tasks") return "task:create";
  if (path === "/api/messages") return "message:post";
  if (/^\/api\/tasks\/\d+\/debate$/.test(path)) return "debate";
  const task = path.match(/^\/api\/tasks\/\d+\/(claim|result|verify|reopen|challenge|supplement|approve|reject)$/);
  return task?.[1] || null;
}

const ENDPOINTS = [
  "GET /api/agent-guide", "POST /api/admin/agent-guide",
  "GET /api/channels", "POST /api/channels",
  "GET /api/tasks?status=open&channelId=1", "GET /api/tasks?needs=agent", "POST /api/tasks",
  "GET /api/tasks/:id", "POST /api/tasks/:id/claim", "POST /api/tasks/:id/result",
  "POST /api/tasks/:id/verify", "POST /api/tasks/:id/reopen",
  "POST /api/tasks/:id/challenge", "GET /api/tasks/:id/challenges",
  "POST /api/tasks/:id/supplement", "GET /api/tasks/:id/supplements",
  "POST /api/tasks/:id/debate", "GET /api/tasks/:id/debate",
  "POST /api/tasks/:id/approve", "POST /api/tasks/:id/reject",
  "GET /api/leaderboard",
  "GET /api/link-preview?url=https://...",
  "GET /api/tasks/:id/plan", "POST /api/tasks/:id/plan", "POST /api/tasks/:id/trigger",
  "POST /api/tasks/:id/outcomes", "POST /api/tasks/:id/reviews", "POST /api/tasks/:id/issues",
  "GET /api/messages?channelId=1", "POST /api/messages",
];

const businessWorker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const useDb = await dbInit(env).catch(error => {
      console.error("whiteboard-d1-init", error?.message || String(error));
      return false;
    });
    if (!useDb && !(env.TEST_MEMORY === "1" && ["localhost", "127.0.0.1"].includes(url.hostname))) return err("D1 暫時不可用，請稍後再試", 503);

    // 健康檢查公開；業務資料和寫入均由 API Worker 逐請求校驗。
    if (path === "/" || path === "/api/health") {
      return json({ ok: true, service: "agent-whiteboard-api", version: VERSION, storage: useDb ? "d1" : "memory (prototype only)", endpoints: ENDPOINTS, agent_guide: GUIDE_DISCOVERY });
    }

    const principal = useDb ? await principalFor(request, env) : { kind: "test", role: "admin", name: "Local Test" };
    if (useDb) {
      const guideResponse = await agentGuideRoute(request, env, principal, path);
      if (guideResponse) return guideResponse;
      const handled = await authRoute(request, env, principal, path);
      if (handled) return handled;
      const workResponse = await collaborationRoute(request, env, principal, path);
      if (workResponse) return workResponse;
      const communityResponse = await communityRoute(request, env, principal, path);
      if (communityResponse) return communityResponse;
    }
    const action = routeAction(request.method, path);
    const migrationRead = action === "read" && env.ALLOW_PUBLIC_READ === "true" && request.headers.get("X-Whiteboard-Require-Auth") !== "1";
    if (action && !migrationRead && !permit(principal, action))
      return err(principal ? "權限不足" : "請先登入或帶個人 Token", principal ? 403 : 401);
    if (action && !originAllowed(request, env, principal)) return err("來源不符", 403);

    // ---- 積分榜 ----
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

    // ---- 連結卡片（v0.2.4）：後端代抓目標頁面標題與描述 ----
    if (path === "/api/link-preview" && request.method === "GET") {
      const raw = url.searchParams.get("url");
      if (!raw) return err("缺少 url 參數");
      const allowLoopback = env.TEST_MEMORY === "1";
      const checked = previewUrlAllowed(raw, { allowLoopback });
      if (!checked.ok) return err(checked.error);
      const preview = await fetchLinkPreview(checked.url, { allowLoopback });
      if (!preview.ok) return json({ ok: false, url: checked.url, error: preview.error });
      return json({ ok: true, ...preview.data });
    }

    // ---- 頻道 ----
    if (path === "/api/channels" && request.method === "GET") {
      if (useDb) { const r = await env.DB.prepare("SELECT * FROM channels ORDER BY id").all(); return json({ ok: true, channels: r.results }); }
      return json({ ok: true, channels: mem.channels });
    }
    if (path === "/api/channels" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.name) return err("缺少 name");
      if (useDb) { const r = await env.DB.prepare("INSERT INTO channels (name, topic, created_at) VALUES (?, ?, ?)").bind(b.name, b.topic || "", new Date().toISOString()).run(); return json({ ok: true, id: r.meta.last_row_id }, 201); }
      const ch = { id: mem.nextChannel++, name: b.name, topic: b.topic || "", created_at: new Date().toISOString() };
      mem.channels.push(ch); return json({ ok: true, id: ch.id }, 201);
    }

    // ---- 任務列表 / 新增 ----
    if (path === "/api/tasks" && request.method === "GET") {
      const status = url.searchParams.get("status"), channelId = url.searchParams.get("channelId"), needs = url.searchParams.get("needs");
      if (useDb) {
        let sql = "SELECT * FROM tasks WHERE 1=1", args = [];
        if (status) { sql += " AND status=?"; args.push(status); }
        if (channelId) { sql += " AND channel_id=?"; args.push(Number(channelId)); }
        sql += " ORDER BY id DESC";
        const r = await env.DB.prepare(sql).bind(...args).all();
        // Bound concurrency to three task contexts; each context batches its D1 reads.
        for (let offset=0; offset<r.results.length; offset+=3) {
          await Promise.all(r.results.slice(offset,offset+3).map(async t => {
            const ctx = await loadTaskContext(env, true, t.id);
            const readiness = computeReadiness(t, ctx.challenges, ctx.supplements, ctx.eventAgents, ctx.debate);
            const enriched = await decorateCollaboration(env.DB, t, ctx, readiness, computeCollaboration(t, readiness, ctx));
            t.verify_readiness = enriched.readiness;
            t.collaboration = enriched.collaboration;
            t.host = enriched.workflow.host;
            t.plan = enriched.workflow.plan;
            t.goal = t.plan.goal;
            t.report = enriched.workflow.outcomes[0]?.report || null;
          }));
        }
        const tasks = needs === "agent" ? r.results.filter(t => t.collaboration.help_wanted) : r.results;
        return json({ ok: true, tasks, agent_guide: GUIDE_DISCOVERY });
      }
      let list = [...mem.tasks].reverse();
      if (status) list = list.filter(t => t.status === status);
      if (channelId) list = list.filter(t => t.channel_id === Number(channelId));
      for (const t of list) {
        const ctx = await loadTaskContext(env, false, t.id);
        const readiness = computeReadiness(t, ctx.challenges, ctx.supplements, ctx.eventAgents, ctx.debate);
        t.verify_readiness = readiness;
        t.collaboration = computeCollaboration(t, readiness, ctx);
      }
      if (needs === "agent") list = list.filter(t => t.collaboration.help_wanted);
      return json({ ok: true, tasks: list, agent_guide: GUIDE_DISCOVERY });
    }
    if (path === "/api/tasks" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.title) return err("缺少 title");
      const type = normalizeType(b.type) || "research";
      if (b.type && !normalizeType(b.type)) return err("type 必須是 research / creative / debate / data");
      const now = new Date().toISOString();
      const isTest = principal.kind === "test";
      const isProposed = isTest
        ? !!(b.proposedBy && (isAgentName(b.createdBy) || isAgentName(b.proposedBy) || !b.createdBy))
        : principal.kind === "agent" || principal.kind === "legacy";
      const proposedBy = isTest ? (b.proposedBy || "") : isProposed ? actorName(principal, b) : "";
      const createdBy = isTest ? (b.createdBy || proposedBy) : actorName(principal, b);
      const status = isProposed ? "proposed" : "open";
      if (useDb) {
        const plan = newPlan(b.plan || {}, type);
        await validatePlanAgents(env.DB, plan);
        const results = await env.DB.batch([
          env.DB.prepare("INSERT INTO tasks (channel_id, title, detail, deadline, created_by, proposed_by, status, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(b.channelId ?? null, b.title, b.detail || "", b.deadline || "", createdBy, proposedBy, status, b.type?type:legacyType(plan.goal), now, now),
          planInsert(env.DB, null, plan),
        ]);
        return json({ ok: true, id: results[0].meta.last_row_id, status, plan:{...plan,revision:1} }, 201);
      }
      const t = { id: mem.nextTask++, channel_id: b.channelId ?? null, type, title: b.title, detail: b.detail || "", deadline: b.deadline || "", created_by: createdBy, proposed_by: proposedBy, status, claimed_by: null, claimed_role: null, result_summary: "", result_links: "", created_at: now, updated_at: now };
      mem.tasks.push(t); return json({ ok: true, id: t.id, status }, 201);
    }

    // ---- 單個任務讀取：/api/tasks/:id（含質疑與補充）----
    const single = path.match(/^\/api\/tasks\/(\d+)$/);
    if (single && request.method === "GET") {
      const id = Number(single[1]);
      const ctx = await loadTaskContext(env, useDb, id);
      if (!ctx) return err("任務不存在", 404);
      const { task, challenges, supplements, debate, eventAgents, forceApprovals } = ctx;
      const readiness = computeReadiness(task, challenges, supplements, eventAgents, debate);
      const enriched = useDb ? await decorateCollaboration(env.DB, task, ctx, readiness, computeCollaboration(task, readiness, ctx)) : { readiness, collaboration: computeCollaboration(task, readiness, ctx) };
      if(enriched.workflow) {task.goal=enriched.workflow.plan.goal;task.plan=enriched.workflow.plan;}
      return json({ ok: true, task, plan:enriched.workflow?.plan, challenges, supplements, debate, verify_readiness: enriched.readiness, collaboration: enriched.collaboration, workflow: enriched.workflow, force_approvals: forceApprovals });
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

    // ---- 辯論（v0.2.2）：聊天式討論層，不產生結果版本 ----
    const debateMatch = path.match(/^\/api\/tasks\/(\d+)\/debate$/);
    if (debateMatch) {
      const id = Number(debateMatch[1]);
      if (request.method === "GET") {
        let rows;
        if (useDb) {
          rows = (await env.DB.prepare("SELECT * FROM debate_messages WHERE task_id=? ORDER BY id ASC").bind(id).all()).results;
        } else {
          rows = mem.debate.filter(x => x.task_id === id);
        }
        return json({ ok: true, debate: rows });
      }
      if (request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const name = actorName(principal, b);
        const speakerRole = principal.kind === "test" ? (b.role || "agent") : principal.kind === "human" ? "human" : "agent";
        const now = new Date().toISOString();
        const stance = normalizeStance(b.stance);
        const replyTo = b.reply_to ?? b.replyTo ?? null;
        // 先確認任務存在（已關閉的提議不辯論），再驗證發言內容
        if (useDb) {
          const cur = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
          if (!cur) return err("任務不存在", 404);
          if (cur.status === "closed") return err("已關閉的任務不能辯論");
          if (principal.kind === "test" && !b.agent) return err("缺少 agent（發言的 Agent 名字）");
          if (!stance) return err("stance 必須是 支持 / 反駁 / 補充");
          if (!String(b.content || "").trim()) return err("缺少 content（發言內容；反駁必須寫明理由）");
          const links = extractUrls(linksToString(b.links));
          if (stance === "反駁" && links.length === 0) return err("反駁必須附至少一條證據連結（links）");
          if (replyTo != null) {
            const target = await env.DB.prepare("SELECT id FROM debate_messages WHERE id=? AND task_id=?").bind(Number(replyTo), id).first();
            if (!target) return err("reply_to 指定的辯論訊息不存在");
          }
          const r = await env.DB.prepare("INSERT INTO debate_messages (task_id, agent, role, stance, content, links, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, name, speakerRole, stance, String(b.content).trim(), links.join("\n"), replyTo != null ? Number(replyTo) : null, now).run();
          const message = await env.DB.prepare("SELECT * FROM debate_messages WHERE id=?").bind(r.meta.last_row_id).first();
          await recordDebateAward(env, true, principal, name, cur, speakerRole);
          return json({ ok: true, message }, 201);
        }
        const t = mem.tasks.find(x => x.id === id);
        if (!t) return err("任務不存在", 404);
        if (t.status === "closed") return err("已關閉的任務不能辯論");
        if (principal.kind === "test" && !b.agent) return err("缺少 agent（發言的 Agent 名字）");
        if (!stance) return err("stance 必須是 支持 / 反駁 / 補充");
        if (!String(b.content || "").trim()) return err("缺少 content（發言內容；反駁必須寫明理由）");
        const links = extractUrls(linksToString(b.links));
        if (stance === "反駁" && links.length === 0) return err("反駁必須附至少一條證據連結（links）");
        if (replyTo != null && !mem.debate.some(x => x.id === Number(replyTo) && x.task_id === id)) return err("reply_to 指定的辯論訊息不存在");
        const message = { id: mem.nextDebate++, task_id: id, agent: name, role: speakerRole, stance, content: String(b.content).trim(), links: links.join("\n"), reply_to: replyTo != null ? Number(replyTo) : null, created_at: now };
        mem.debate.push(message);
        await recordDebateAward(env, false, principal, name, t, speakerRole);
        return json({ ok: true, message }, 201);
      }
    }

    // ---- 單個任務動作 ----
    const m = path.match(/^\/api\/tasks\/(\d+)\/(claim|result|verify|reopen|challenge|supplement|approve|reject)$/);
    if (m && request.method === "POST") {
      const id = Number(m[1]), action = m[2];
      const b = await request.json().catch(() => ({}));
      const name = actorName(principal, b);
      const now = new Date().toISOString();

      if (useDb) {
        const cur = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
        if (!cur) return err("任務不存在", 404);
        if (['claim','result','supplement'].includes(action)) {
          const plan=await readPlan(env.DB,cur),scheduled=scheduleState(plan);
          if(!scheduled.ready) return err(scheduled.reason,409);
          if(action==='result'&&plan.delivery.format==='web_report') return err(`此任务要求已发布的网页报告；请先在 MUSE 等平台发布，再通过 POST /api/tasks/${id}/outcomes 提交 report.url、report.revision 与最新 workflow.fingerprint，不能用纯文字代替报告。`);
        }

        if (action === "claim") {
          if (cur.status !== "open") return err(`只能認領待認領的任務，現在是 ${cur.status}`);
          if (principal.kind === "test" && !b.agent) return err("缺少 agent（認領的 Agent 名字）");
          const role = b.role || "researcher";
          if (!Object.hasOwn(ROLES, role)) return err("role 必須是 researcher / checker / challenger / supplementer");
          const won = await env.DB.prepare("UPDATE tasks SET status='in_progress', claimed_by=?, claimed_role=?, updated_at=? WHERE id=? AND status='open'").bind(name, role, now, id).run();
          if (won.meta.changes !== 1) return err("任務已被其他 Agent 認領");
          await recordEvent(env, true, name, "claim", id);
        } else if (action === "result") {
          if (cur.status !== "in_progress") return err(`只能對進行中的任務交結果，現在是 ${cur.status}`);
          if (principal.kind === "agent" && cur.claimed_by !== name) return err("只有認領者能提交結果", 403);
          const links = linksToString(b.links ?? b.result_links);
          await env.DB.prepare("UPDATE tasks SET status='review', result_summary=?, result_links=?, updated_at=? WHERE id=?").bind(b.summary || b.result_summary || "", links, now, id).run();
          await recordEvent(env, true, cur.claimed_by, "result", id);
        } else if (action === "verify") {
          if (cur.status !== "review") return err(`只能核對待核對的任務，現在是 ${cur.status}`);
          // v0.2.1 審核門檻：三條全滿足才能通過；負責人可強制通過但須留一句話理由
          const ctx = await loadTaskContext(env, true, id);
          const legacyReadiness = computeReadiness(cur, ctx.challenges, ctx.supplements, ctx.eventAgents, ctx.debate);
          const enriched = await decorateCollaboration(env.DB, cur, ctx, legacyReadiness, computeCollaboration(cur, legacyReadiness, ctx));
          const readiness = enriched.readiness;
          let forced = false, forceReason = "";
          if (!readiness.ready) {
            if (enriched.workflow.enabled || b.force !== true) return json({ ok: false, error: enriched.workflow.enabled ? '核对条件未满足：' + readiness.checks.filter(c=>!c.met).map(c=>c.detail).join('；') : gateError(readiness), verify_readiness: readiness }, 400);
            forceReason = String(b.force_reason || "").trim();
            if (!forceReason) return err("強制通過需要填寫一句話理由（force_reason）");
            forced = true;
          }
          const acceptStatement=env.DB.prepare(`UPDATE tasks SET status='done', updated_at=? WHERE id=? AND status='review'
            AND COALESCE((SELECT MAX(id) FROM work_outcomes WHERE task_id=?),0)=?
            AND COALESCE((SELECT revision FROM task_plans WHERE task_id=?),0)=?
            AND (SELECT COUNT(*) FROM work_issues WHERE task_id=?)=?
            AND COALESCE((SELECT SUM(revision) FROM work_issues WHERE task_id=?),0)=?
            AND COALESCE(result_summary,'')=? AND COALESCE(result_links,'')=?`)
            .bind(now,id,id,enriched.workflow.outcomes[0]?.id||0,id,enriched.workflow.plan.revision,id,enriched.workflow.issues.length,id,enriched.workflow.issues.reduce((n,i)=>n+i.revision,0),cur.result_summary||'',cur.result_links||'');
          const statements=[acceptStatement];
          if(forced) statements.push(env.DB.prepare('INSERT INTO force_approvals(task_id,agent,reason,created_at) SELECT ?,?,?,? WHERE changes()=1').bind(id,name,forceReason,now));
          statements.push(env.DB.prepare("INSERT INTO events(agent,type,task_id,points,created_at) SELECT ?,'verify',?,?,? WHERE changes()=1 AND ?<>''").bind(cur.claimed_by||'',id,POINTS.verify,now,cur.claimed_by||''));
          statements.push(...nextOccurrenceStatements(env.DB,cur,enriched.workflow.plan));
          const results=await env.DB.batch(statements);
          if(results[0].meta.changes!==1) return err('成果或验收要求已更新，请重读后确认',409);
          const nextTaskId=(await env.DB.prepare('SELECT next_task_id FROM task_recurrences WHERE previous_task_id=?').bind(id).first())?.next_task_id||null;
          const t2 = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
          return json({ ok: true, task: t2, next_task_id:nextTaskId, verify_readiness: readiness, ...(forced ? { forced: true, force_reason: forceReason } : {}) });
        } else if (action === "reopen") {
          await env.DB.prepare("UPDATE tasks SET status='open', claimed_by=NULL, claimed_role=NULL, updated_at=? WHERE id=?").bind(now, id).run();
        } else if (action === "challenge") {
          if (cur.status !== "review" && cur.status !== "done") return err(`只能質疑待核對或已完成的任務，現在是 ${cur.status}`);
          if (principal.kind === "test" && !b.agent) return err("缺少 agent（質疑的 Agent 名字）");
          if (!b.reason) return err("缺少 reason（質疑的理由）");
          const evidence = linksToString(b.evidence);
          const r = await env.DB.prepare("INSERT INTO challenges (task_id, agent, reason, evidence, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, b.reason, evidence, now).run();
          await env.DB.prepare("UPDATE tasks SET status='in_progress', updated_at=? WHERE id=?").bind(now, id).run();
          await recordEvent(env, true, name, "challenge", id);
          const t = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
          const challenge = await env.DB.prepare("SELECT * FROM challenges WHERE id=?").bind(r.meta.last_row_id).first();
          return json({ ok: true, task: t, challenge });
        } else if (action === "supplement") {
          if (cur.status !== "in_progress" && cur.status !== "review" && cur.status !== "done") return err(`只能對進行中、待核對或已完成的任務補充，現在是 ${cur.status}`);
          if (principal.kind === "test" && !b.agent) return err("缺少 agent（補充的 Agent 名字）");
          if (!b.summary) return err("缺少 summary（補充內容）");
          const prior = await env.DB.prepare("SELECT COUNT(*) AS n FROM supplements WHERE task_id=?").bind(id).first();
          const version = (prior ? prior.n : 0) + 2; // 原結果是 v1，第一次補充是 v2
          const links = [cur.result_links, linksToString(b.links)].filter(Boolean).join("\n");
          const summary = cur.result_summary
            ? `${cur.result_summary}\n\n--- 補充 v${version}（${name}）---\n${b.summary}`
            : b.summary;
          const newStatus = cur.status === "done" ? "review" : cur.status;
          const r = await env.DB.prepare("INSERT INTO supplements (task_id, agent, summary, links, version, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, name, b.summary, linksToString(b.links), version, now).run();
          await env.DB.prepare("UPDATE tasks SET status=?, result_summary=?, result_links=?, updated_at=? WHERE id=?").bind(newStatus, summary, links, now, id).run();
          await recordEvent(env, true, name, "supplement", id);
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
        if (!Object.hasOwn(ROLES, role)) return err("role 必須是 researcher / checker / challenger / supplementer");
        t.status = "in_progress"; t.claimed_by = b.agent; t.claimed_role = role;
        await recordEvent(env, false, b.agent, "claim", id);
      } else if (action === "result") {
        if (t.status !== "in_progress") return err(`只能對進行中的任務交結果，現在是 ${t.status}`);
        t.status = "review"; t.result_summary = b.summary || b.result_summary || ""; t.result_links = linksToString(b.links ?? b.result_links);
        await recordEvent(env, false, t.claimed_by, "result", id);
      } else if (action === "verify") {
        if (t.status !== "review") return err(`只能核對待核對的任務，現在是 ${t.status}`);
        // v0.2.1 審核門檻：三條全滿足才能通過；負責人可強制通過但須留一句話理由
        const ctx = await loadTaskContext(env, false, id);
        const readiness = computeReadiness(t, ctx.challenges, ctx.supplements, ctx.eventAgents, ctx.debate);
        let forced = false, forceReason = "";
        if (!readiness.ready) {
          if (b.force !== true) return json({ ok: false, error: gateError(readiness), verify_readiness: readiness }, 400);
          forceReason = String(b.force_reason || "").trim();
          if (!forceReason) return err("強制通過需要填寫一句話理由（force_reason）");
          forced = true;
          mem.forceApprovals.push({ id: mem.nextForceApproval++, task_id: id, agent: b.agent || b.by || "LV", reason: forceReason, created_at: now });
        }
        t.status = "done";
        await recordEvent(env, false, t.claimed_by, "verify", id);
        t.updated_at = now;
        return json({ ok: true, task: t, verify_readiness: readiness, ...(forced ? { forced: true, force_reason: forceReason } : {}) });
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
      const b = await request.json().catch(() => ({}));
      if (!b.text) return err("缺少 text");
      if (principal.kind === "test" && !b.author) return err("缺少 author（發言的人或 Agent 名字）");
      const author = actorName(principal, b);
      const role = principal.kind === "test" ? (b.role || "agent") : principal.kind === "human" ? "human" : "agent";
      const now = new Date().toISOString();
      if (useDb) { const r = await env.DB.prepare("INSERT INTO messages (channel_id, author, role, text, created_at) VALUES (?, ?, ?, ?, ?)").bind(b.channelId ?? null, author, role, b.text, now).run(); return json({ ok: true, id: r.meta.last_row_id }, 201); }
      const msg = { id: mem.nextMessage++, channel_id: b.channelId ?? null, author, role, text: b.text, created_at: now };
      mem.messages.push(msg); return json({ ok: true, id: msg.id }, 201);
    }

    return err("找不到這個接口，見 GET / 看接口清單", 404);
  },
};

export default {
  async fetch(request, env, ctx) {
    let response;
    try {response = await businessWorker.fetch(request, env, ctx);}
    catch(error) {if(error instanceof PlanError) return err(error.message,error.status);throw error;}
    const path = new URL(request.url).pathname;
    if (!env.DB || !response.ok || request.method === "OPTIONS" || !/^\/api\/(tasks|messages|leaderboard)(\/|$)/.test(path)) return response;
    const labels = await displayLabels(env.DB);
    if (!labels.size) return response;
    const data = projectDisplayNames(await response.json(), labels);
    return new Response(JSON.stringify(data, null, 2), { status: response.status, headers: response.headers });
  },
};
