// A successful mailbox response is evidence of fetching, not of execution or
// human-style reading. Keep this separate from general authenticated visits.
export const INBOX_TIMEOUT_SECONDS = 30 * 60;
export const AGENT_INBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_inbox_state (
  agent_id INTEGER PRIMARY KEY REFERENCES principals(id),
  last_inbox_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_directive_receipts (
  directive_id INTEGER PRIMARY KEY REFERENCES agent_directives(id) ON DELETE CASCADE,
  fetched_at TEXT NOT NULL
);`;

export async function initAgentInbox(db) {
  for (const sql of AGENT_INBOX_SCHEMA.split(';')) {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (statement) await db.exec(statement + ';');
  }
}

export async function recordInboxFetch(db, principal, directiveIds, now = new Date()) {
  if (principal?.kind !== 'agent' || principal.via !== 'bearer' || !Number.isSafeInteger(principal.id) || principal.id < 1) return;
  const stamp = now.toISOString();
  await db.batch([
    db.prepare(`INSERT INTO agent_inbox_state (agent_id, last_inbox_at) VALUES (?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET last_inbox_at = MAX(agent_inbox_state.last_inbox_at, excluded.last_inbox_at)`)
      .bind(principal.id, stamp),
    // Record only the actual returned IDs. A new arrival during a poll, a
    // filtered page or a short page must never acknowledge unseen directives.
    db.prepare(`INSERT INTO agent_directive_receipts (directive_id, fetched_at)
      SELECT id, ? FROM agent_directives WHERE agent_id = ? AND status = 'pending'
      AND id IN (SELECT value FROM json_each(?)) ON CONFLICT(directive_id) DO NOTHING`)
      .bind(stamp, principal.id, JSON.stringify(directiveIds)),
  ]);
}

// Both admin list and detail use the indexed pending queue and receipt PKs;
// they never scan visit history or issue a query per Agent in the list.
export const INBOX_STATUS_FIELDS = `
  s.last_inbox_at,
  (SELECT COUNT(*) FROM agent_directives d LEFT JOIN agent_directive_receipts r ON r.directive_id=d.id
    WHERE d.agent_id=p.id AND d.status='pending' AND r.directive_id IS NULL) AS unfetched_directives,
  (SELECT MIN(d.created_at) FROM agent_directives d LEFT JOIN agent_directive_receipts r ON r.directive_id=d.id
    WHERE d.agent_id=p.id AND d.status='pending' AND r.directive_id IS NULL) AS oldest_unfetched_directive_at`;

export function summarizeInboxStatus(row, now = new Date()) {
  const oldest = row.oldest_unfetched_directive_at || null;
  const unfetched = Number(row.unfetched_directives || 0);
  return {
    last_inbox_at: row.last_inbox_at || null,
    unfetched_directives: unfetched,
    oldest_unfetched_directive_at: oldest,
    inbox_timeout_seconds: INBOX_TIMEOUT_SECONDS,
    inbox_overdue: !!row.active && unfetched > 0 && Number.isFinite(Date.parse(oldest))
      && now.getTime() - Date.parse(oldest) >= INBOX_TIMEOUT_SECONDS * 1000,
  };
}

export async function readInboxStatus(db, agentId, now = new Date()) {
  const row = await db.prepare(`SELECT p.active, ${INBOX_STATUS_FIELDS}
    FROM principals p LEFT JOIN agent_inbox_state s ON s.agent_id=p.id WHERE p.id=?`)
    .bind(agentId).first();
  return summarizeInboxStatus(row || {}, now);
}
