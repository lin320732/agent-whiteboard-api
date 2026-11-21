import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

export function createMemoryR2() {
  const store = new Map();
  const stats = { headCalls: 0, getCalls: 0 };
  const metadataOf = entry => ({
    key: entry.key,
    size: entry.size,
    httpEtag: entry.httpEtag,
    httpMetadata: entry.httpMetadata,
    customMetadata: entry.customMetadata,
    uploaded: entry.uploaded,
  });
  return {
    store,
    stats,
    async put(key, value, options = {}) {
      let bytes;
      if (value instanceof Uint8Array) bytes = new Uint8Array(value);
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (typeof value === 'string') bytes = new TextEncoder().encode(value);
      else bytes = new Uint8Array(await new Response(value).arrayBuffer());
      const entry = {
        key,
        bytes,
        size: bytes.byteLength,
        httpEtag: `"etag-${key}-${bytes.byteLength}"`,
        httpMetadata: { ...(options.httpMetadata || {}) },
        customMetadata: { ...(options.customMetadata || {}) },
        uploaded: new Date(),
      };
      store.set(key, entry);
      return entry;
    },
    async head(key) {
      stats.headCalls++;
      const entry = store.get(key);
      return entry ? metadataOf(entry) : null;
    },
    async get(key, options = {}) {
      stats.getCalls++;
      const entry = store.get(key);
      if (!entry) return null;
      let slice = entry.bytes;
      let rangeMeta = undefined;
      if (options?.range) {
        const r = options.range;
        let start = 0;
        let end = entry.size;
        if (typeof r.suffix === 'number') {
          if (r.suffix <= 0) throw new Error('R2 mock: invalid suffix range');
          start = Math.max(0, entry.size - r.suffix);
        } else {
          start = r.offset ?? 0;
          end = r.length != null ? start + r.length : entry.size;
        }
        if (start < 0 || start >= entry.size || end <= start || end > entry.size) {
          throw new Error(`R2 mock: range out of bounds (${start}-${end} of ${entry.size})`);
        }
        slice = entry.bytes.subarray(start, end);
        rangeMeta = { offset: start, length: slice.byteLength };
      }
      return {
        ...metadataOf(entry),
        ...(rangeMeta ? { range: rangeMeta } : {}),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        }),
        async arrayBuffer() {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
        },
        async text() {
          return new TextDecoder().decode(slice);
        },
      };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

export async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const DB = { sqlite, exec: async sql => sqlite.exec(sql), batch(statements) {
    sqlite.exec('BEGIN');
    try { const results=statements.map(s=>s.execute()); sqlite.exec('COMMIT'); return results; }
    catch(e) {sqlite.exec('ROLLBACK'); throw e;}
  }, prepare(sql) {
    let args = [];
    return { execute() { const s=sqlite.prepare(sql); if(s.columns().length) return {results:s.all(...args)}; const r=s.run(...args); return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}; }, bind(...v) { args = v; return this; }, async first() { return sqlite.prepare(sql).get(...args) || null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, run() { const r = sqlite.prepare(sql).run(...args); return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}; } };
  }};
  const FILES = createMemoryR2();
  const env = { DB, FILES, BOOTSTRAP_KEY:'test-bootstrap', API_KEY:'test-legacy', BOARD_ORIGIN:'https://board.test', ALLOW_PUBLIC_READ:'true' };
  async function request(method, path, body, auth = {}) {
    const r = await worker.fetch(new Request(`https://board.test${path}`, {method,headers:{'Content-Type':'application/json',...auth},body:body === undefined ? undefined : JSON.stringify(body)}),env,{});
    return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')};
  }
  const boot=await request('POST','/api/admin/bootstrap',{}, {Authorization:'Bearer test-bootstrap'});
  const login=await request('POST','/api/auth/login',{username:'owner',password:boot.data.password});
  const admin={Cookie:login.cookie.split(';')[0],Origin:'https://board.test'};
  const agents=[];
  for(const name of ['Host','Worker','Checker']) {
    const r=await request('POST','/api/admin/agents',{username:name.toLowerCase(),name},admin);
    assert.equal(r.status,201);
    agents.push({id:r.data.id,name,auth:{Authorization:`Bearer ${r.data.token}`}});
  }
  return {DB,FILES,env,request,admin,agents,host:agents[0],worker:agents[1],checker:agents[2]};
}
