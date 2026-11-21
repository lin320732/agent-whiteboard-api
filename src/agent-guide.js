import { hashSecret, originAllowed, permit } from './auth.js';
import { GUIDE_BOOTSTRAP, GUIDE_TEXT } from './agent-guide-content.js';

export const GUIDE_DISCOVERY=Object.freeze({url:'/api/agent-guide',read_before_each_poll:true,authentication:'personal_bearer_token'});
export const GUIDE_SCHEMA='CREATE TABLE IF NOT EXISTS agent_guide_revisions (id INTEGER PRIMARY KEY, instructions TEXT NOT NULL, author_id INTEGER NOT NULL, created_at TEXT NOT NULL);';
// Per-Agent instructions live in their own table so the shared revision table and
// its history stay untouched, and every statement stays CREATE IF NOT EXISTS.
export const GUIDE_PERSONAL_SCHEMA=`CREATE TABLE IF NOT EXISTS agent_guide_personal_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, principal_id INTEGER NOT NULL, revision INTEGER NOT NULL, instructions TEXT NOT NULL, author_id INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(principal_id, revision));
  CREATE INDEX IF NOT EXISTS agent_guide_personal_latest ON agent_guide_personal_revisions(principal_id, revision DESC);`;
function response(data,status=200,etag=null) {
  const headers={'Content-Type':'application/json','Cache-Control':'private, no-cache','Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'ETag'};
  if(etag) headers.ETag=etag;
  return new Response(data===null?null:JSON.stringify(data),{status,headers});
}
const error=(message,status)=>response({ok:false,error:message},status);
export const initAgentGuide=async db=>{
  await db.exec(GUIDE_SCHEMA);
  for(const statement of GUIDE_PERSONAL_SCHEMA.split(';').map(sql=>sql.replace(/\s+/g,' ').trim()).filter(Boolean)) await db.exec(`${statement};`);
};
async function latestGlobal(db) {
  return db.prepare('SELECT * FROM agent_guide_revisions ORDER BY id DESC LIMIT 1').first();
}
async function latestPersonal(db,principalId) {
  if(principalId==null) return null;
  return db.prepare('SELECT * FROM agent_guide_personal_revisions WHERE principal_id=? ORDER BY revision DESC LIMIT 1').bind(principalId).first();
}
async function currentGuide(db, principalId=null) {
  const row=await latestGlobal(db), personal=await latestPersonal(db,principalId);
  const instructions=row?.instructions||'', own=personal?.instructions||'';
  // Built-in guide, then the shared instructions, then this Agent's own ones, so a
  // later section can be more specific without rewriting the shared text.
  const sections=[GUIDE_TEXT];
  if(instructions) sections.push('## 管理员目前工作指示','',instructions,'');
  if(own) sections.push('## 管理员给你的工作指示','',own,'');
  const shared={revision:row?.id||0,updated_at:row?.created_at||null};
  // Keep the original fields for clients that display shared-instruction history.
  const guide={ok:true,revision:shared.revision,updated_at:shared.updated_at,shared,instructions,
    agent_id:personal?.principal_id||null,
    personal:personal?{instructions:own,revision:personal.revision,updated_at:personal.created_at}:null,
    markdown:sections.join('\n'),bootstrap:GUIDE_BOOTSTRAP,agent_guide:GUIDE_DISCOVERY,poll_interval_seconds:900,
    entrypoints:{inbox:'/api/inbox',directives:'/api/agent/directives',help_wanted:'/api/tasks?needs=agent',participants:'/api/participants',channels:'/api/channels',messages:'/api/messages',files:'/api/files'}};
  // The version also serves as the validator for the complete JSON response.
  return {...guide,version:await hashSecret(JSON.stringify(guide))};
}
async function activeAgent(db,id) {
  if(!Number.isSafeInteger(id)||id<=0) return null;
  return db.prepare("SELECT id FROM principals WHERE id=? AND kind='agent' AND active=1").bind(id).first();
}
function parseAgentId(body) {
  if(body.agent_id==null||body.agent_id==='') return {id:null};
  const id=Number(body.agent_id);
  return Number.isSafeInteger(id)&&id>0?{id}:{error:'Agent 编号无效'};
}
async function publishGlobal(db,principal,instructions,current) {
  if(instructions===current.instructions) return current;
  // Atomic compare-and-append: two editors with the same revision cannot both win.
  const inserted=await db.prepare(`INSERT INTO agent_guide_revisions(id,instructions,author_id,created_at)
    SELECT ?,?,?,? WHERE COALESCE((SELECT MAX(id) FROM agent_guide_revisions),0)=?`)
    .bind(current.shared.revision+1,instructions,principal.id,new Date().toISOString(),current.shared.revision).run();
  return inserted.meta.changes?currentGuide(db):null;
}
async function publishPersonal(db,principal,agentId,instructions,current) {
  const base=current.personal?.revision||0;
  if(instructions===(current.personal?.instructions||'')) return current;
  if(!instructions) {
    await db.prepare('DELETE FROM agent_guide_personal_revisions WHERE principal_id=?').bind(agentId).run();
    return currentGuide(db,agentId);
  }
  const inserted=await db.prepare(`INSERT INTO agent_guide_personal_revisions(principal_id,revision,instructions,author_id,created_at)
    SELECT ?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM agent_guide_personal_revisions WHERE principal_id=?),0)=?`)
    .bind(agentId,base+1,instructions,principal.id,new Date().toISOString(),agentId,base).run();
  return inserted.meta.changes?currentGuide(db,agentId):null;
}
export async function agentGuideRoute(request,env,principal,path) {
  if(!['/api/agent-guide','/api/admin/agent-guide'].includes(path)) return null;
  if(!principal?.id) return error('请使用个人账号或独立 Agent 令牌',401);
  if(!originAllowed(request,env,principal)) return error('来源不符',403);
  const url=new URL(request.url);
  if(path==='/api/agent-guide'&&request.method==='GET') {
    const guide=await currentGuide(env.DB,principal.kind==='agent'?principal.id:null),etag=`"${guide.version}"`;
    const matches=(request.headers.get('If-None-Match')||'').split(',').map(s=>s.trim().replace(/^W\//,''));
    if(matches.includes(etag)||matches.includes('*')) return response(null,304,etag);
    return response(guide,200,etag);
  }
  if(path==='/api/admin/agent-guide'&&request.method==='GET') {
    if(!permit(principal,'admin')) return error('只有登录的管理员能读取指定 Agent 的指南',403);
    const {id:agentId,error:invalid}=parseAgentId({agent_id:url.searchParams.get('agent_id')});
    if(invalid) return error(invalid,400);
    if(agentId&&!await activeAgent(env.DB,agentId)) return error('Agent 不存在或已停用',404);
    const guide=await currentGuide(env.DB,agentId);
    return response(guide,200,`"${guide.version}"`);
  }
  if(path==='/api/admin/agent-guide'&&request.method==='POST') {
    if(!permit(principal,'admin')) return error('只有登录的管理员能发布指南',403);
    const body=await request.json().catch(()=>null);
    if(!body||typeof body.instructions!=='string'||body.instructions.length>12000||typeof body.version!=='string') return error('请提交当前版本和最多 12000 字的工作指示',400);
    const {id:agentId,error:invalid}=parseAgentId(body);
    if(invalid) return error(invalid,400);
    if(agentId&&!await activeAgent(env.DB,agentId)) return error('Agent 不存在或已停用',404);
    const current=await currentGuide(env.DB,agentId);
    if(body.version!==current.version) return error('指南已由其他管理员更新，请先读取最新版再发布；你的草稿仍保留。',409);
    const instructions=body.instructions.trim();
    const published=agentId?await publishPersonal(env.DB,principal,agentId,instructions,current):await publishGlobal(env.DB,principal,instructions,current);
    if(!published) return error('指南已更新，请先读取最新版再发布；你的草稿仍保留。',409);
    return response(published,200,`"${published.version}"`);
  }
  return error('不支持此方法',405);
}
