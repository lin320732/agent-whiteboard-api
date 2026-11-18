export const VISIT_RETENTION_DAYS = 30;
const RETENTION_MS = VISIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;

// Only a verified identity and server time are stored. No request headers,
// credentials, IP addresses, query parameters or submitted content enter this log.
export const AGENT_VISITS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES principals(id),
  visited_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_visits_recent ON agent_visits(agent_id, visited_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_visits_expiry ON agent_visits(visited_at);`;

export async function initAgentVisits(db) {
  for (const sql of AGENT_VISITS_SCHEMA.split(';')) {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (statement) await db.exec(statement + ';');
  }
}

export function visitCutoff(now = new Date()) {
  return new Date(now.getTime() - RETENTION_MS).toISOString();
}

export function pruneAgentVisits(db, now = new Date()) {
  return db.prepare('DELETE FROM agent_visits WHERE visited_at < ?').bind(visitCutoff(now)).run();
}

export async function recordAgentVisit(db, principal, now = new Date()) {
  if (principal?.kind !== 'agent' || principal.via !== 'bearer' || !Number.isSafeInteger(principal.id) || principal.id < 1) return;
  await db.batch([
    db.prepare('DELETE FROM agent_visits WHERE visited_at < ?').bind(visitCutoff(now)),
    db.prepare('INSERT INTO agent_visits (agent_id, visited_at) VALUES (?, ?)').bind(principal.id, now.toISOString()),
  ]);
}

export class VisitCursorError extends Error {}

export async function readAgentVisits(db, agentId, {before, now = new Date()} = {}) {
  let cursor;
  if (before != null) {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z),(\d+)$/.exec(before);
    if (!match || !Number.isFinite(Date.parse(match[1])) || new Date(match[1]).toISOString() !== match[1] || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) throw new VisitCursorError('到访记录的翻页位置无效，请刷新记录');
    cursor = {at:match[1], id:Number(match[2])};
  }
  const cutoff = visitCutoff(now);
  await pruneAgentVisits(db, now);
  const args = [agentId, cutoff];
  let sql = 'SELECT id, visited_at FROM agent_visits WHERE agent_id=? AND visited_at >= ?';
  if (cursor) {
    sql += ' AND (visited_at < ? OR (visited_at = ? AND id < ?))';
    args.push(cursor.at, cursor.at, cursor.id);
  }
  sql += ' ORDER BY visited_at DESC, id DESC LIMIT ?';
  args.push(PAGE_SIZE + 1);
  const {results} = await db.prepare(sql).bind(...args).all();
  const visits = results.slice(0, PAGE_SIZE), last = visits.at(-1);
  // Count only when a person opens or refreshes the history. Background account
  // refreshes use an indexed latest-visit lookup, and later pages need no recount.
  const total = cursor ? null : await db.prepare('SELECT COUNT(*) AS n FROM agent_visits WHERE agent_id=? AND visited_at >= ?').bind(agentId,cutoff).first();
  return {ok:true, agent_id:agentId, retention_days:VISIT_RETENTION_DAYS, timezone:'Asia/Shanghai', cutoff_at:cutoff, total_requests:total?.n??null, visits,
    next_cursor:results.length > PAGE_SIZE ? `${last.visited_at},${last.id}` : null};
}
