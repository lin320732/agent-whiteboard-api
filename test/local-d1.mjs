// Minimal D1 stand-in backed by node:sqlite, so the real SQL (CAS, batch,
// meta.changes) can be exercised locally without wrangler or a Cloudflare account.
import { DatabaseSync } from 'node:sqlite';

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async first(column) {
    await this.db.tick();
    const row = this.raw(this.sql, this.params).rows[0];
    if (row == null) return null;
    return column ? row[column] ?? null : { ...row };
  }
  async all() {
    await this.db.tick();
    const { rows } = this.raw(this.sql, this.params);
    return { success: true, results: rows.map(row => ({ ...row })), meta: {} };
  }
  async run() {
    await this.db.tick();
    const { changes, lastInsertRowid } = this.raw(this.sql, this.params);
    return { success: true, meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
  }
  // Synchronous variant shared by batch(); returns raw sqlite summary.
  static isRead(sql) { return /^\s*(SELECT|PRAGMA|WITH)/i.test(sql); }
  raw(sql, params) {
    const statement = this.db.connection.prepare(sql);
    if (Statement.isRead(sql)) return { rows: statement.all(...params), changes: 0, lastInsertRowid: 0 };
    return statement.run(...params);
  }
}

export class LocalD1 {
  constructor({ latencyMs = 2 } = {}) {
    this.connection = new DatabaseSync(':memory:');
    this.latencyMs = latencyMs;
  }
  // Yield between every statement so concurrent requests really interleave.
  async tick() {
    if (this.latencyMs > 0) await new Promise(resolve => setTimeout(resolve, this.latencyMs));
  }
  prepare(sql) { return new Statement(this, sql, []); }
  async exec(sql) {
    await this.tick();
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      this.connection.exec(statement.endsWith(';') ? statement : `${statement};`);
    }
  }
  async batch(statements) {
    await this.tick();
    this.connection.exec('BEGIN');
    try {
      const results = statements.map(statement => {
        const out = statement.raw(statement.sql, statement.params);
        const meta = { changes: Number(out.changes), last_row_id: Number(out.lastInsertRowid) };
        return Statement.isRead(statement.sql)
          ? { success: true, results: out.rows.map(row => ({ ...row })), meta }
          : { success: true, results: [], meta };
      });
      this.connection.exec('COMMIT');
      return results;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }
}
