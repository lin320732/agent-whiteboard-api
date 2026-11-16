import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
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
  const env = { DB, BOOTSTRAP_KEY:'test-bootstrap', API_KEY:'test-legacy', BOARD_ORIGIN:'https://board.test', ALLOW_PUBLIC_READ:'true' };
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
  return {DB,env,request,admin,agents,host:agents[0],worker:agents[1],checker:agents[2]};
}
