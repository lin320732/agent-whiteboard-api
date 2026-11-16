import { hashSecret, originAllowed, permit } from './auth.js';
import { GUIDE_TEXT } from './agent-guide-content.js';

export const GUIDE_DISCOVERY=Object.freeze({url:'/api/agent-guide',read_before_each_poll:true,authentication:'personal_bearer_token'});
export const GUIDE_SCHEMA='CREATE TABLE IF NOT EXISTS agent_guide_revisions (id INTEGER PRIMARY KEY, instructions TEXT NOT NULL, author_id INTEGER NOT NULL, created_at TEXT NOT NULL);';
export const initAgentGuide=db=>db.exec(GUIDE_SCHEMA);
const BOOTSTRAP='每轮工作前，请用你自己的白板令牌读取 https://agent-whiteboard-api.penzibdc.workers.dev/api/agent-guide ，按照返回的最新 markdown 指南行动。先处理 /api/inbox，再查看 /api/tasks?needs=agent；无需等待我重复发送规则。';
function response(data,status=200,etag=null) {
  const headers={'Content-Type':'application/json','Cache-Control':'private, no-cache','Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'ETag'};
  if(etag) headers.ETag=etag;
  return new Response(data===null?null:JSON.stringify(data),{status,headers});
}
const error=(message,status)=>response({ok:false,error:message},status);
async function currentGuide(db) {
  const row=await db.prepare('SELECT * FROM agent_guide_revisions ORDER BY id DESC LIMIT 1').first();
  const instructions=row?.instructions||'';
  // Include the revision even when a previously used text is published again.
  const version=await hashSecret(JSON.stringify([GUIDE_TEXT,row?.id||0,instructions]));
  const markdown=instructions?GUIDE_TEXT+'\n\n## 管理员目前工作指示\n\n'+instructions+'\n':GUIDE_TEXT;
  return {ok:true,version,revision:row?.id||0,updated_at:row?.created_at||null,instructions,markdown,bootstrap:BOOTSTRAP,agent_guide:GUIDE_DISCOVERY,poll_interval_seconds:900,entrypoints:{inbox:'/api/inbox',help_wanted:'/api/tasks?needs=agent',participants:'/api/participants',topics:'/api/topics'}};
}
export async function agentGuideRoute(request,env,principal,path) {
  if(!['/api/agent-guide','/api/admin/agent-guide'].includes(path)) return null;
  if(!principal?.id) return error('请使用个人账号或独立 Agent 令牌',401);
  if(!originAllowed(request,env,principal)) return error('来源不符',403);
  if(path==='/api/agent-guide'&&request.method==='GET') {
    const guide=await currentGuide(env.DB),etag=`"${guide.version}"`;
    const matches=(request.headers.get('If-None-Match')||'').split(',').map(s=>s.trim().replace(/^W\//,''));
    if(matches.includes(etag)||matches.includes('*')) return response(null,304,etag);
    return response(guide,200,etag);
  }
  if(path==='/api/admin/agent-guide'&&request.method==='POST') {
    if(!permit(principal,'admin')) return error('只有登录的管理员能发布指南',403);
    const body=await request.json().catch(()=>null);
    if(!body||typeof body.instructions!=='string'||body.instructions.length>12000||typeof body.version!=='string') return error('请提交当前版本和最多 12000 字的工作指示',400);
    const current=await currentGuide(env.DB);
    if(body.version!==current.version) return error('指南已由其他管理员更新，请先读取最新版再发布；你的草稿仍保留。',409);
    const instructions=body.instructions.trim();
    if(instructions===current.instructions) return response(current,200,`"${current.version}"`);
    // Atomic compare-and-append: two editors with the same revision cannot both win.
    const inserted=await env.DB.prepare(`INSERT INTO agent_guide_revisions(id,instructions,author_id,created_at)
      SELECT ?,?,?,? WHERE COALESCE((SELECT MAX(id) FROM agent_guide_revisions),0)=?`)
      .bind(current.revision+1,instructions,principal.id,new Date().toISOString(),current.revision).run();
    if(!inserted.meta.changes) return error('指南已更新，请先读取最新版再发布；你的草稿仍保留。',409);
    const published=await currentGuide(env.DB);
    return response(published,200,`"${published.version}"`);
  }
  return error('不支持此方法',405);
}
