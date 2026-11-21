export const QUOTA_RETENTION_DAYS = 30;
const RETENTION_MS = QUOTA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const HISTORY_PAGE_SIZE = 20;
const MAX_ITEMS_PER_BUCKET = 30;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const READ_CHANNELS = new Set(['none', 'manual', 'api']);
const REPORT_REASONS = new Set(['initial', 'daily', 'reset', 'threshold', 'change', 'channel', 'first_permanent_use']);
const HAS_REQUEST_ID = "CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.request_id') = 'text' ELSE 0 END";

export const AGENT_QUOTAS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_quotas (
  agent_id INTEGER PRIMARY KEY REFERENCES principals(id),
  unit TEXT NOT NULL DEFAULT 'tokens',
  free_remaining REAL,
  free_total REAL,
  free_percent REAL,
  permanent_remaining REAL,
  permanent_total REAL,
  permanent_percent REAL,
  overall_percent REAL,
  status_level TEXT NOT NULL DEFAULT 'none',
  basis TEXT NOT NULL DEFAULT 'none',
  payload_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reported_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_quota_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES principals(id),
  unit TEXT NOT NULL DEFAULT 'tokens',
  free_remaining REAL,
  free_total REAL,
  free_percent REAL,
  permanent_remaining REAL,
  permanent_total REAL,
  permanent_percent REAL,
  overall_percent REAL,
  status_level TEXT NOT NULL DEFAULT 'none',
  basis TEXT NOT NULL DEFAULT 'none',
  payload_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reported_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_quota_reports_recent ON agent_quota_reports(agent_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_quota_reports_expiry ON agent_quota_reports(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS agent_quota_reports_request ON agent_quota_reports(agent_id, json_extract(payload_json, '$.request_id')) WHERE ${HAS_REQUEST_ID};`;

export async function initAgentQuotas(db) {
  for (const sql of AGENT_QUOTAS_SCHEMA.split(';')) {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (statement) await db.exec(statement + ';');
  }
}

export class QuotaError extends Error {
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

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const round4 = n => Math.round(n * 10000) / 10000;
const round1 = n => Math.round(n * 10) / 10;

function clampPercent(value) {
  return round1(Math.max(0, Math.min(100, value)));
}

export function statusLevelFor(percent, remaining) {
  if (percent != null && Number.isFinite(percent)) {
    if (percent >= 60) return 'green';
    if (percent >= 20) return 'yellow';
    return 'red';
  }
  if (remaining != null && Number.isFinite(remaining)) {
    return remaining > 0 ? 'green' : 'red';
  }
  return 'none';
}

function parseText(value, label, maxLen, { required = false, fallback = '' } = {}) {
  if (value == null) {
    if (required) throw new QuotaError(`缺少 ${label}`);
    return fallback;
  }
  if (typeof value !== 'string') throw new QuotaError(`${label} 必须是文本`);
  const text = value.trim();
  if (required && !text) throw new QuotaError(`缺少 ${label}`);
  if (text.length > maxLen) throw new QuotaError(`${label} 长度不能超过 ${maxLen} 个字符`);
  return text || fallback;
}

function parseNonNegative(value, label) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') throw new QuotaError(`${label} 必须是非负数字`);
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1e15) throw new QuotaError(`${label} 必须是非负有效数字`);
  return round4(n);
}

function parsePercent(value, label) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') throw new QuotaError(`${label} 必须是 0 到 100 之间的数字`);
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const cleaned = value.trim().replace(/\s*%$/, '');
    if (cleaned !== '') n = Number(cleaned);
  }
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new QuotaError(`${label} 必须是 0 到 100 之间的数字`);
  return round1(n);
}

function parseIsoOptional(value, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new QuotaError(`${label} 必须是有效的时间字符串`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 64) throw new QuotaError(`${label} 格式过长`);
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) throw new QuotaError(`${label} 不是有效的 ISO 时间格式`);
  return new Date(parsed).toISOString();
}

function parseScheduleLabel(value, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new QuotaError(`${label} 必须是文本或时间字符串`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > 64) throw new QuotaError(`${label} 长度不能超过 64 个字符`);
  return text;
}

function computePercent(remaining, total, explicitPercent) {
  if (total != null && remaining != null) {
    if (total > 0) return clampPercent((remaining / total) * 100);
    if (remaining === 0) return 0;
  }
  return explicitPercent != null ? explicitPercent : null;
}

function normalizeItem(raw, index, bucketLabel, defaultUnit) {
  if (!isPlainObject(raw)) throw new QuotaError(`${bucketLabel} 第 ${index + 1} 项明细格式无效`);
  const name = parseText(raw.name ?? raw.label ?? raw.title, `${bucketLabel} 第 ${index + 1} 项名称`, 80, { required: true });
  const unit = parseText(raw.unit, `${bucketLabel} 第 ${index + 1} 项单位`, 24, { fallback: raw.tokens !== undefined ? 'tokens' : defaultUnit });
  let remaining = parseNonNegative(raw.remaining ?? raw.tokens ?? raw.left ?? raw.balance ?? raw.available, `${bucketLabel}「${name}」剩余额度`);
  const total = parseNonNegative(raw.total ?? raw.limit ?? raw.quota ?? raw.max, `${bucketLabel}「${name}」总额度`);
  let used = parseNonNegative(raw.used, `${bucketLabel}「${name}」已用额度`);
  const rawUsedPct = parsePercent(raw.used_percent ?? raw.usedPercent, `${bucketLabel}「${name}」已用百分比`);
  let explicitPercent = parsePercent(raw.percent ?? raw.remaining_percent ?? raw.remainingPercent, `${bucketLabel}「${name}」剩余百分比`);
  if (explicitPercent == null && rawUsedPct != null) explicitPercent = clampPercent(100 - rawUsedPct);
  if (remaining == null && total != null && used != null) remaining = round4(Math.max(0, total - used));
  if (used == null && total != null && remaining != null && total >= remaining) used = round4(total - remaining);
  if (remaining == null && explicitPercent == null) {
    throw new QuotaError(`${bucketLabel}「${name}」至少需要提供 percent（剩余百分比）、used_percent（已用百分比）或 remaining（剩余额度）`);
  }
  const percent = computePercent(remaining, total, explicitPercent);
  const usedPercent = rawUsedPct != null ? rawUsedPct : (percent != null ? clampPercent(100 - percent) : null);
  return {
    name,
    unit,
    remaining,
    total,
    used,
    percent,
    used_percent: usedPercent,
    status_level: statusLevelFor(percent, remaining),
    reset_at: parseScheduleLabel(raw.reset_at ?? raw.resetAt, `${bucketLabel}「${name}」重置时间`),
    expires_at: parseScheduleLabel(raw.expires_at ?? raw.expiresAt, `${bucketLabel}「${name}」过期时间`),
    note: parseText(raw.note, `${bucketLabel}「${name}」备注`, 240, { fallback: '' }),
  };
}

function extractBucketRaw(body, key) {
  const nested = body[key];
  const prefix = `${key}_`;
  const flat = {};
  let hasFlat = false;
  for (const field of ['remaining', 'tokens', 'left', 'balance', 'available', 'total', 'limit', 'quota', 'max', 'used', 'percent', 'remaining_percent', 'used_percent', 'unit', 'reset_at', 'expires_at', 'note', 'items']) {
    if (body[prefix + field] !== undefined) {
      flat[field] = body[prefix + field];
      hasFlat = true;
    }
  }
  if (nested === undefined || nested === null) return hasFlat ? flat : null;
  if (typeof nested === 'string' && /%\s*$/.test(nested.trim())) {
    return { ...flat, percent: nested };
  }
  if (typeof nested === 'number' || typeof nested === 'string') {
    return { ...flat, remaining: nested };
  }
  if (!isPlainObject(nested)) throw new QuotaError(`${key === 'free' ? '免费额度（free）' : '永久额度（permanent）'} 必须是对象、百分比字符串或非负数字`);
  return { ...flat, ...nested };
}

function normalizeBucket(raw, bucketLabel, defaultUnit) {
  if (!raw) return null;
  const unit = parseText(raw.unit, `${bucketLabel}单位`, 24, { fallback: raw.tokens !== undefined ? 'tokens' : defaultUnit });
  let items = [];
  if (raw.items !== undefined && raw.items !== null) {
    if (!Array.isArray(raw.items)) throw new QuotaError(`${bucketLabel}明细 items 必须是数组`);
    if (raw.items.length > MAX_ITEMS_PER_BUCKET) throw new QuotaError(`${bucketLabel}明细最多支持 ${MAX_ITEMS_PER_BUCKET} 项`);
    items = raw.items.map((item, idx) => normalizeItem(item, idx, bucketLabel, unit));
  }
  let remaining = parseNonNegative(raw.remaining ?? raw.tokens ?? raw.left ?? raw.balance ?? raw.available, `${bucketLabel}剩余额度`);
  let total = parseNonNegative(raw.total ?? raw.limit ?? raw.quota ?? raw.max, `${bucketLabel}总额度`);
  let used = parseNonNegative(raw.used, `${bucketLabel}已用额度`);
  const rawUsedPct = parsePercent(raw.used_percent ?? raw.usedPercent, `${bucketLabel}已用百分比`);
  let explicitPercent = parsePercent(raw.percent ?? raw.remaining_percent ?? raw.remainingPercent, `${bucketLabel}剩余百分比`);
  if (explicitPercent == null && rawUsedPct != null) explicitPercent = clampPercent(100 - rawUsedPct);
  const sameUnitItems = items.length > 0 && items.every(item => item.unit === unit);
  if (remaining == null && total != null && used != null) remaining = round4(Math.max(0, total - used));
  if (remaining == null && sameUnitItems && items.every(item => item.remaining != null)) {
    remaining = round4(items.reduce((sum, item) => sum + item.remaining, 0));
  }
  if (total == null && sameUnitItems && items.every(item => item.total != null)) {
    total = round4(items.reduce((sum, item) => sum + item.total, 0));
  }
  if (used == null && total != null && remaining != null && total >= remaining) {
    used = round4(total - remaining);
  }
  if (remaining == null && explicitPercent == null && items.length === 0) {
    throw new QuotaError(`${bucketLabel}至少需要提供 percent（剩余百分比）、used_percent（已用百分比）、remaining（剩余额度）或 items（明细）`);
  }
  let percent = computePercent(remaining, total, explicitPercent);
  if (percent == null && items.length > 0) {
    const itemPercents = items.map(i => i.percent).filter(v => v != null && Number.isFinite(v));
    if (itemPercents.length > 0) {
      percent = clampPercent(itemPercents.reduce((s, v) => s + v, 0) / itemPercents.length);
    }
  }
  const usedPercent = rawUsedPct != null ? rawUsedPct : (percent != null ? clampPercent(100 - percent) : null);
  return {
    unit,
    remaining,
    total,
    used,
    percent,
    used_percent: usedPercent,
    status_level: statusLevelFor(percent, remaining),
    reset_at: parseScheduleLabel(raw.reset_at ?? raw.resetAt, `${bucketLabel}重置时间`),
    expires_at: parseScheduleLabel(raw.expires_at ?? raw.expiresAt, `${bucketLabel}过期时间`),
    note: parseText(raw.note, `${bucketLabel}备注`, 400, { fallback: '' }),
    items,
  };
}

export function normalizeQuotaPayload(body, now = new Date()) {
  if (!isPlainObject(body)) throw new QuotaError('请求体必须是 JSON 对象');
  const unit = parseText(body.unit, '单位 unit', 24, { fallback: 'tokens' });
  const note = parseText(body.note, '备注 note', 400, { fallback: '' });
  const source = parseText(body.source, '来源 source', 80, { fallback: '' });
  const readChannel = body.read_channel ?? null;
  if (readChannel !== null && !READ_CHANNELS.has(readChannel)) {
    throw new QuotaError('read_channel 必须是 none、manual 或 api');
  }
  if (body.unknown !== undefined && typeof body.unknown !== 'boolean') {
    throw new QuotaError('unknown 必须是布尔值');
  }
  const reasons = body.reasons ?? [];
  if (!Array.isArray(reasons) || reasons.length > REPORT_REASONS.size || reasons.some(reason => !REPORT_REASONS.has(reason))) {
    throw new QuotaError('reasons 包含无效的上报原因');
  }
  const requestId = body.request_id ?? null;
  if (requestId !== null && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId))) {
    throw new QuotaError('request_id 必须是 16 到 80 位的字母、数字、下划线或连字符');
  }
  const reportedAt = parseIsoOptional(body.reported_at ?? body.reportedAt, '上报时间 reported_at') ?? now.toISOString();
  const resetAt = parseScheduleLabel(body.reset_at ?? body.resetAt, '额度重置时间 reset_at');
  const topUsedPct = parsePercent(body.used_percent ?? body.usedPercent, '总已用百分比');
  let topPercent = parsePercent(body.percent ?? body.remaining_percent ?? body.remainingPercent, '总剩余百分比');
  if (topPercent == null && topUsedPct != null) topPercent = clampPercent(100 - topUsedPct);

  const free = normalizeBucket(extractBucketRaw(body, 'free'), '免费额度', unit);
  if (free && !free.reset_at) free.reset_at = resetAt;
  const permanent = normalizeBucket(extractBucketRaw(body, 'permanent'), '永久额度', unit);
  const hasReading = Boolean(free || permanent || topPercent != null);
  const unknown = body.unknown === true || readChannel === 'none';
  if (unknown && hasReading) throw new QuotaError('未知额度心跳不能同时提交额度数值');
  if (!unknown && !hasReading) {
    throw new QuotaError('请至少提供免费额度（free）、永久额度（permanent）或总剩余百分比（percent）');
  }

  let overallPercent = null;
  let basis = unknown ? 'unknown' : 'none';
  let statusLevel = 'none';

  const bothHaveTotals = free && permanent
    && free.remaining != null && free.total != null && free.total > 0
    && permanent.remaining != null && permanent.total != null && permanent.total > 0
    && free.unit === permanent.unit;

  if (topPercent != null) {
    overallPercent = topPercent;
    basis = 'reported';
    statusLevel = statusLevelFor(overallPercent, null);
  } else if (bothHaveTotals) {
    const sumRem = round4(free.remaining + permanent.remaining);
    const sumTot = round4(free.total + permanent.total);
    overallPercent = clampPercent((sumRem / sumTot) * 100);
    basis = 'combined';
    statusLevel = statusLevelFor(overallPercent, sumRem);
  } else if (free?.percent != null) {
    overallPercent = free.percent;
    basis = 'free';
    statusLevel = statusLevelFor(overallPercent, free.remaining);
  } else if (permanent?.percent != null) {
    overallPercent = permanent.percent;
    basis = 'permanent';
    statusLevel = statusLevelFor(overallPercent, permanent.remaining);
  } else {
    const knownRemainings = [
      free?.remaining,
      permanent?.remaining,
      ...(free?.items || []).map(i => i.remaining),
      ...(permanent?.items || []).map(i => i.remaining),
    ].filter(v => v != null && Number.isFinite(v));
    if (knownRemainings.length > 0) {
      basis = 'balance';
      const hasPositive = knownRemainings.some(v => v > 0);
      overallPercent = hasPositive ? null : 0;
      statusLevel = hasPositive ? 'green' : 'red';
    } else {
      const itemPercents = [
        ...(free?.items || []).map(i => i.percent),
        ...(permanent?.items || []).map(i => i.percent),
      ].filter(v => v != null && Number.isFinite(v));
      if (itemPercents.length > 0) {
        overallPercent = clampPercent(itemPercents.reduce((s, v) => s + v, 0) / itemPercents.length);
        basis = 'items';
        statusLevel = statusLevelFor(overallPercent, null);
      }
    }
  }

  const updatedAt = now.toISOString();
  const payload = {
    unit,
    overall_percent: overallPercent,
    status_level: statusLevel,
    basis,
    note,
    source,
    read_channel: readChannel,
    reasons: [...new Set(reasons)],
    ...(requestId === null ? {} : { request_id: requestId }),
    reported_at: reportedAt,
    reset_at: free?.reset_at ?? resetAt,
    updated_at: updatedAt,
    free,
    permanent,
  };
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
    throw new QuotaError('额度上报内容过大，请精简明细与备注');
  }
  return { payload, serialized, updatedAt };
}

export function quotaCutoff(now = new Date()) {
  return new Date(now.getTime() - RETENTION_MS).toISOString();
}

export function pruneAgentQuotaReports(db, now = new Date()) {
  return db.prepare('DELETE FROM agent_quota_reports WHERE created_at < ?').bind(quotaCutoff(now)).run();
}

export async function recordAgentQuota(db, principal, body, now = new Date()) {
  const { payload, serialized, updatedAt } = normalizeQuotaPayload(body, now);
  const f = payload.free, p = payload.permanent;
  const values = [
    principal.id, payload.unit,
    f?.remaining ?? null, f?.total ?? null, f?.percent ?? null,
    p?.remaining ?? null, p?.total ?? null, p?.percent ?? null,
    payload.overall_percent, payload.status_level, payload.basis,
    serialized, payload.note, payload.reported_at, updatedAt,
  ];
  const [, inserted] = await db.batch([
    db.prepare('DELETE FROM agent_quota_reports WHERE created_at < ?').bind(quotaCutoff(now)),
    db.prepare(`INSERT INTO agent_quota_reports
      (agent_id, unit, free_remaining, free_total, free_percent, permanent_remaining, permanent_total, permanent_percent, overall_percent, status_level, basis, payload_json, note, reported_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING RETURNING id`).bind(...values),
    // A replay inserts no history row and leaves any newer snapshot intact.
    db.prepare(`INSERT INTO agent_quotas
      (agent_id, unit, free_remaining, free_total, free_percent, permanent_remaining, permanent_total, permanent_percent, overall_percent, status_level, basis, payload_json, note, reported_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0
      ON CONFLICT(agent_id) DO UPDATE SET
        unit=excluded.unit, free_remaining=excluded.free_remaining, free_total=excluded.free_total, free_percent=excluded.free_percent,
        permanent_remaining=excluded.permanent_remaining, permanent_total=excluded.permanent_total, permanent_percent=excluded.permanent_percent,
        overall_percent=excluded.overall_percent, status_level=excluded.status_level, basis=excluded.basis,
        payload_json=excluded.payload_json, note=excluded.note, reported_at=excluded.reported_at, updated_at=excluded.updated_at`)
      .bind(...values),
  ]);
  const reportId = inserted.results?.[0]?.id;
  if (reportId != null) return { report_id: reportId, quota: payload };
  const existing = await db.prepare(`SELECT id, payload_json FROM agent_quota_reports
    WHERE agent_id=? AND ${HAS_REQUEST_ID} AND json_extract(payload_json, '$.request_id')=?`)
    .bind(principal.id, payload.request_id ?? null).first();
  if (existing) return { report_id: existing.id, quota: JSON.parse(existing.payload_json) };
  throw new Error('Agent quota report insert returned no row');
}

function safeParsePayload(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function summarizeQuotaRow(row) {
  if (!row || !row.quota_updated_at) return null;
  const parsed = safeParsePayload(row.quota_payload_json);
  const free = parsed?.free ? {
    remaining: parsed.free.remaining ?? null,
    total: parsed.free.total ?? null,
    percent: parsed.free.percent ?? null,
    status_level: parsed.free.status_level || statusLevelFor(parsed.free.percent, parsed.free.remaining),
    unit: parsed.free.unit || row.quota_unit || 'tokens',
    items_count: Array.isArray(parsed.free.items) ? parsed.free.items.length : 0,
    reset_at: parsed.free.reset_at ?? null,
    expires_at: parsed.free.expires_at ?? null,
  } : null;
  const permanent = parsed?.permanent ? {
    remaining: parsed.permanent.remaining ?? null,
    total: parsed.permanent.total ?? null,
    percent: parsed.permanent.percent ?? null,
    status_level: parsed.permanent.status_level || statusLevelFor(parsed.permanent.percent, parsed.permanent.remaining),
    unit: parsed.permanent.unit || row.quota_unit || 'tokens',
    items_count: Array.isArray(parsed.permanent.items) ? parsed.permanent.items.length : 0,
  } : null;
  return {
    unit: row.quota_unit || parsed?.unit || 'tokens',
    overall_percent: row.quota_overall_percent ?? parsed?.overall_percent ?? null,
    status_level: row.quota_status_level || parsed?.status_level || 'none',
    basis: row.quota_basis || parsed?.basis || 'none',
    free,
    permanent,
    note: row.quota_note || parsed?.note || '',
    read_channel: parsed?.read_channel ?? null,
    reasons: parsed?.reasons ?? [],
    reported_at: row.quota_reported_at ?? parsed?.reported_at ?? row.quota_updated_at,
    reset_at: parsed?.free?.reset_at ?? parsed?.reset_at ?? null,
    updated_at: row.quota_updated_at,
  };
}

function hydrateLatestRow(row) {
  if (!row) return null;
  const parsed = safeParsePayload(row.payload_json);
  if (parsed) return {
    ...parsed,
    reported_at: parsed.reported_at ?? row.reported_at ?? row.updated_at,
    reset_at: parsed.free?.reset_at ?? parsed.reset_at ?? null,
    updated_at: row.updated_at,
  };
  return {
    unit: row.unit,
    overall_percent: row.overall_percent,
    status_level: row.status_level,
    basis: row.basis,
    note: row.note,
    source: '',
    reported_at: row.reported_at ?? row.updated_at,
    reset_at: null,
    updated_at: row.updated_at,
    free: row.free_remaining != null || row.free_percent != null ? {
      unit: row.unit, remaining: row.free_remaining, total: row.free_total, used: null,
      percent: row.free_percent, status_level: statusLevelFor(row.free_percent, row.free_remaining),
      reset_at: null, expires_at: null, note: '', items: [],
    } : null,
    permanent: row.permanent_remaining != null || row.permanent_percent != null ? {
      unit: row.unit, remaining: row.permanent_remaining, total: row.permanent_total, used: null,
      percent: row.permanent_percent, status_level: statusLevelFor(row.permanent_percent, row.permanent_remaining),
      reset_at: null, expires_at: null, note: '', items: [],
    } : null,
  };
}

export async function readAgentQuota(db, agentId, { before = null, includeHistory = true, now = new Date() } = {}) {
  let cursor = null;
  if (before != null) {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z),(\d+)$/.exec(before);
    if (!match || !Number.isFinite(Date.parse(match[1])) || new Date(match[1]).toISOString() !== match[1] || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) {
      throw new QuotaError('额度历史记录的翻页位置无效，请刷新记录');
    }
    cursor = { at: match[1], id: Number(match[2]) };
  }

  const latestRow = await db.prepare('SELECT * FROM agent_quotas WHERE agent_id=?').bind(agentId).first();
  const quota = hydrateLatestRow(latestRow);

  if (!includeHistory) {
    return {
      ok: true,
      agent_id: agentId,
      retention_days: QUOTA_RETENTION_DAYS,
      timezone: 'Asia/Shanghai',
      quota,
    };
  }

  const cutoff = quotaCutoff(now);
  await pruneAgentQuotaReports(db, now);
  const args = [agentId, cutoff];
  let sql = `SELECT id, unit, free_remaining, free_total, free_percent, permanent_remaining, permanent_total, permanent_percent, overall_percent, status_level, basis, note, reported_at, created_at,
    CASE WHEN json_valid(payload_json) THEN COALESCE(json_extract(payload_json, '$.free.reset_at'), json_extract(payload_json, '$.reset_at')) END AS reset_at,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.free.unit') END AS free_unit,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.permanent.unit') END AS permanent_unit,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.read_channel') END AS read_channel,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.reasons') END AS reasons
    FROM agent_quota_reports WHERE agent_id=? AND created_at >= ?`;
  if (cursor) {
    sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    args.push(cursor.at, cursor.at, cursor.id);
  }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  args.push(HISTORY_PAGE_SIZE + 1);
  const { results } = await db.prepare(sql).bind(...args).all();
  const history = results.slice(0, HISTORY_PAGE_SIZE).map(row => ({
    ...row,
    reported_at: row.reported_at ?? row.created_at,
    reasons: safeParsePayload(row.reasons) || [],
  }));
  const last = history.at(-1);
  return {
    ok: true,
    agent_id: agentId,
    retention_days: QUOTA_RETENTION_DAYS,
    timezone: 'Asia/Shanghai',
    cutoff_at: cutoff,
    quota,
    history,
    next_cursor: results.length > HISTORY_PAGE_SIZE ? `${last.created_at},${last.id}` : null,
  };
}

export async function agentQuotaRoute(request, env, principal, path) {
  if (path !== '/api/agent/quota') return null;
  if (!['GET', 'POST', 'PUT'].includes(request.method)) {
    return reply({ ok: false, error: '此接口仅支持 GET / POST / PUT' }, 405);
  }
  if (!principal) return reply({ ok: false, error: '请先使用 Agent 个人令牌验证身份' }, 401);
  if (principal.kind !== 'agent' || principal.via !== 'bearer' || !Number.isSafeInteger(principal.id) || principal.id < 1) {
    return reply({ ok: false, error: '此接口仅限独立 Agent 个人令牌调用' }, 403);
  }
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const includeHistory = url.searchParams.get('history') === '1' || url.searchParams.get('history') === 'true';
    const before = url.searchParams.get('before');
    return reply(await readAgentQuota(env.DB, principal.id, { before, includeHistory }));
  }
  let body;
  try { body = await request.json(); }
  catch { throw new QuotaError('请求体不是有效的 JSON'); }
  const saved = await recordAgentQuota(env.DB, principal, body);
  return reply({ ok: true, agent_id: principal.id, report_id: saved.report_id, quota: saved.quota }, 200);
}
