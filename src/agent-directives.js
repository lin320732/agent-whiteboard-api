// Per-Agent admin directives: admin (owner) can leave direct instructions for a
// specific Agent. The Agent receives pending directives in /api/inbox and
// /api/agent/directives, submits completion feedback via
// POST /api/agent/directives/:id/complete, and the directive is automatically
// marked completed and archived permanently.
import { originAllowed, permit } from './auth.js';
import { recordInboxFetch, readInboxStatus } from './agent-inbox.js';

const MAX_CONTENT_LEN = 4000;
const MAX_RESULT_LEN = 6000;
const MAX_LINKS = 30;
const PAGE_SIZE = 30;

export const AGENT_DIRECTIVES_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_directives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES principals(id),
  author_id INTEGER NOT NULL REFERENCES principals(id),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed')),
  result TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_directives_agent_status ON agent_directives(agent_id, status, id DESC);
CREATE INDEX IF NOT EXISTS agent_directives_created ON agent_directives(created_at DESC, id DESC);`;

export async function initAgentDirectives(db) {
  for (const sql of AGENT_DIRECTIVES_SCHEMA.split(';')) {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (statement) await db.exec(`${statement};`);
  }
}

export class DirectiveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-None-Match',
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

function parsePositiveId(value, label = '编号') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new DirectiveError(`无效${label}`, 400);
  return n;
}

function parseText(value, label, maxLen) {
  if (typeof value !== 'string' || !value.trim()) throw new DirectiveError(`请填写${label}`, 400);
  const trimmed = value.trim();
  if (trimmed.length > maxLen) throw new DirectiveError(`${label}不能超过 ${maxLen} 个字符`, 400);
  return trimmed;
}

function parseLinks(value) {
  if (value == null || value === '') return '';
  const list = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value;
  if (!Array.isArray(list) || list.length > MAX_LINKS) {
    throw new DirectiveError(`链接须为数组，最多 ${MAX_LINKS} 条`, 400);
  }
  const normalized = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.length > 2048) throw new DirectiveError('无效链接', 400);
    let u;
    try { u = new URL(item.trim()); } catch { throw new DirectiveError('链接须使用 HTTP(S)', 400); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new DirectiveError('链接须使用 HTTP(S)', 400);
    if (!normalized.includes(u.href)) normalized.push(u.href);
  }
  return normalized.join('\n');
}

function formatDirective(row) {
  if (!row) return null;
  return {
    id: row.id,
    agent_id: row.agent_id,
    agent_name: row.agent_name || '',
    author_id: row.author_id,
    author_name: row.author_name || '',
    content: row.content,
    status: row.status,
    result: row.result || '',
    links: row.links ? row.links.split('\n').filter(Boolean) : [],
    created_at: row.created_at,
    completed_at: row.completed_at || null,
    fetched_at: row.fetched_at || null,
  };
}

const DIRECTIVE_SELECT = `SELECT d.id, d.agent_id, d.author_id, d.content, d.status, d.result, d.links, d.created_at, d.completed_at, r.fetched_at,
  COALESCE(al.display_name, ap.name) AS agent_name,
  COALESCE(ul.display_name, up.name) AS author_name
  FROM agent_directives d
  JOIN principals ap ON ap.id = d.agent_id
  LEFT JOIN principal_labels al ON al.principal_id = ap.id
  JOIN principals up ON up.id = d.author_id
  LEFT JOIN principal_labels ul ON ul.principal_id = up.id
  LEFT JOIN agent_directive_receipts r ON r.directive_id = d.id`;

async function readCounts(db, agentId) {
  const row = await db.prepare(`SELECT
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
    COUNT(*) AS total
    FROM agent_directives WHERE agent_id = ?`).bind(agentId).first();
  return {
    pending: Number(row?.pending || 0),
    completed: Number(row?.completed || 0),
    total: Number(row?.total || 0),
  };
}

export async function listPendingDirectivesForAgent(db, agentId) {
  if (!Number.isSafeInteger(agentId) || agentId < 1) return [];
  const { results } = await db.prepare(
    `${DIRECTIVE_SELECT} WHERE d.agent_id = ? AND d.status = 'pending' ORDER BY d.id ASC`
  ).bind(agentId).all();
  return results.map(formatDirective);
}

export async function readAgentDirectives(db, agentId, { status = 'all', before = null, limit = PAGE_SIZE } = {}) {
  const normalizedStatus = status === '' || status == null ? 'all' : String(status).trim().toLowerCase();
  if (!['all', 'pending', 'completed'].includes(normalizedStatus)) {
    throw new DirectiveError('status 须为 all、pending 或 completed', 400);
  }
  const parsedLimit = limit == null || limit === '' ? PAGE_SIZE : Number(limit);
  const cap = Math.min(100, Math.max(1, Number.isSafeInteger(parsedLimit) && parsedLimit >= 1 ? parsedLimit : PAGE_SIZE));
  let beforeId = null;
  if (before != null && before !== '') {
    beforeId = parsePositiveId(before, '翻页位置');
  }

  const where = ['d.agent_id = ?'];
  const args = [agentId];
  if (normalizedStatus !== 'all') {
    where.push('d.status = ?');
    args.push(normalizedStatus);
  }
  if (beforeId != null) {
    where.push('d.id < ?');
    args.push(beforeId);
  }
  const sql = `${DIRECTIVE_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT ?`;
  args.push(cap + 1);

  const [{ results }, counts] = await Promise.all([
    db.prepare(sql).bind(...args).all(),
    beforeId == null ? readCounts(db, agentId) : Promise.resolve(null),
  ]);

  const hasMore = results.length > cap;
  const page = results.slice(0, cap).map(formatDirective);
  const last = page.at(-1);

  return {
    ok: true,
    agent_id: agentId,
    ...(counts ? { counts } : {}),
    directives: page,
    has_more: hasMore,
    next_cursor: hasMore && last ? String(last.id) : null,
  };
}

export async function createAgentDirective(db, agentId, authorId, rawContent, now = new Date()) {
  const content = parseText(rawContent, '留言内容', MAX_CONTENT_LEN);
  const target = await db.prepare("SELECT id, active FROM principals WHERE id = ? AND kind = 'agent'").bind(agentId).first();
  if (!target || !target.active) throw new DirectiveError('Agent 不存在或已停用', 404);
  const stamp = now.toISOString();
  const inserted = await db.prepare(
    "INSERT INTO agent_directives (agent_id, author_id, content, status, result, links, created_at) VALUES (?, ?, ?, 'pending', '', '', ?)"
  ).bind(agentId, authorId, content, stamp).run();
  const [row, counts] = await Promise.all([
    db.prepare(`${DIRECTIVE_SELECT} WHERE d.id = ?`).bind(inserted.meta.last_row_id).first(),
    readCounts(db, agentId),
  ]);
  return { directive: formatDirective(row), counts };
}

export async function cancelAgentDirective(db, agentId, directiveId) {
  const existing = await db.prepare(
    'SELECT id, status FROM agent_directives WHERE id = ? AND agent_id = ?'
  ).bind(directiveId, agentId).first();
  if (!existing) throw new DirectiveError('留言不存在', 404);
  if (existing.status === 'completed') throw new DirectiveError('已达成的留言记录已永久保存，无法撤回', 409);
  const removed = await db.prepare(
    "DELETE FROM agent_directives WHERE id = ? AND agent_id = ? AND status = 'pending'"
  ).bind(directiveId, agentId).run();
  if (!removed.meta.changes) throw new DirectiveError('该留言已被回馈达成，无法撤回', 409);
  const counts = await readCounts(db, agentId);
  return { ok: true, id: directiveId, counts };
}

export async function completeAgentDirective(db, agentId, directiveId, body = {}, now = new Date()) {
  const resultText = parseText(body.result ?? body.summary ?? body.reply, '完成回馈结果（result）', MAX_RESULT_LEN);
  const links = parseLinks(body.links);
  const stamp = now.toISOString();
  const updated = await db.prepare(
    "UPDATE agent_directives SET status = 'completed', result = ?, links = ?, completed_at = ? WHERE id = ? AND agent_id = ? AND status = 'pending'"
  ).bind(resultText, links, stamp, directiveId, agentId).run();

  if (!updated.meta.changes) {
    const existing = await db.prepare(
      'SELECT id, status FROM agent_directives WHERE id = ? AND agent_id = ?'
    ).bind(directiveId, agentId).first();
    if (!existing) throw new DirectiveError('留言不存在', 404);
    throw new DirectiveError('该留言已达成并保存，无需重复提交', 409);
  }

  const row = await db.prepare(`${DIRECTIVE_SELECT} WHERE d.id = ?`).bind(directiveId).first();
  return formatDirective(row);
}

function isPersonalAgent(principal) {
  return principal?.kind === 'agent' && principal.via === 'bearer' && Number.isSafeInteger(principal.id) && principal.id >= 1;
}

export async function agentDirectiveRoute(request, env, principal, path) {
  const isAgentList = path === '/api/agent/directives';
  const agentCompleteMatch = path.match(/^\/api\/agent\/directives\/(\d+)\/complete$/);
  const adminListMatch = path.match(/^\/api\/admin\/agents\/(\d+)\/directives$/);
  const adminItemMatch = path.match(/^\/api\/admin\/agents\/(\d+)\/directives\/(\d+)$/);

  if (!isAgentList && !agentCompleteMatch && !adminListMatch && !adminItemMatch) return null;

  // ---- Agent endpoints ----
  if (isAgentList || agentCompleteMatch) {
    if (!principal) return reply({ ok: false, error: '请使用独立 Agent 个人令牌' }, 401);
    if (!isPersonalAgent(principal)) {
      return reply({ ok: false, error: '仅独立 Agent 个人令牌可读取或回馈管理员留言' }, 403);
    }
    if (isAgentList) {
      if (request.method !== 'GET') return reply({ ok: false, error: '仅支持 GET' }, 405);
      const url = new URL(request.url);
      const status = url.searchParams.get('status') || 'pending';
      const before = url.searchParams.get('before');
      const limit = url.searchParams.get('limit');
      const data = await readAgentDirectives(env.DB, principal.id, { status, before, limit });
      if (String(status).trim().toLowerCase() !== 'completed') {
        await recordInboxFetch(env.DB, principal, data.directives.filter(d=>d.status==='pending').map(d=>d.id));
      }
      return reply(data);
    }
    if (request.method !== 'POST') return reply({ ok: false, error: '仅支持 POST' }, 405);
    const directiveId = parsePositiveId(agentCompleteMatch[1], '留言编号');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new DirectiveError('请求体必须是 JSON 对象', 400);
    }
    const directive = await completeAgentDirective(env.DB, principal.id, directiveId, body);
    return reply({ ok: true, directive });
  }

  // ---- Admin (owner) endpoints ----
  if (!permit(principal, 'admin') || !originAllowed(request, env, principal)) {
    return reply({ ok: false, error: '仅管理员（owner）可查看或下达 Agent 留言' }, principal ? 403 : 401);
  }

  if (adminListMatch) {
    const agentId = parsePositiveId(adminListMatch[1], 'Agent 编号');
    if (request.method === 'GET') {
      const target = await env.DB.prepare("SELECT id FROM principals WHERE id = ? AND kind = 'agent'").bind(agentId).first();
      if (!target) throw new DirectiveError('Agent 不存在', 404);
      const url = new URL(request.url);
      const status = url.searchParams.get('status') || 'all';
      const before = url.searchParams.get('before');
      const limit = url.searchParams.get('limit');
      const data = await readAgentDirectives(env.DB, agentId, { status, before, limit });
      return reply({ ...data, inbox_status: await readInboxStatus(env.DB, agentId) });
    }
    if (request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new DirectiveError('请求体必须是 JSON 对象', 400);
      }
      const { directive, counts } = await createAgentDirective(env.DB, agentId, principal.id, body.content ?? body.message ?? body.text);
      return reply({ ok: true, directive, counts, inbox_status: await readInboxStatus(env.DB, agentId) }, 201);
    }
    return reply({ ok: false, error: '仅支持 GET 与 POST' }, 405);
  }

  if (adminItemMatch) {
    const agentId = parsePositiveId(adminItemMatch[1], 'Agent 编号');
    const directiveId = parsePositiveId(adminItemMatch[2], '留言编号');
    if (request.method !== 'DELETE') return reply({ ok: false, error: '仅支持 DELETE' }, 405);
    const target = await env.DB.prepare("SELECT id FROM principals WHERE id = ? AND kind = 'agent'").bind(agentId).first();
    if (!target) throw new DirectiveError('Agent 不存在', 404);
    const data = await cancelAgentDirective(env.DB, agentId, directiveId);
    return reply({ ...data, inbox_status: await readInboxStatus(env.DB, agentId) });
  }

  return null;
}
