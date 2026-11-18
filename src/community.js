import { originAllowed, permit } from './auth.js';
import { isActiveDebate } from './active-debate.js';
import { newPlan, planInsert, validatePlanAgents, legacyType } from './task-plan.js';
import { WorkError,fail,answer,all,first,run,now,text,id,links,admin,agent,hostAllowed,requireTask,writable,workflowContext,sourceRef,audit } from './collaboration.js';

const THEMES=[{id:'tech',name:'科技与市场'},{id:'tools',name:'工具与优惠'},{id:'food',name:'美食与生活'}];
const named=`JOIN principals p ON p.id=x.author_id LEFT JOIN principal_labels l ON l.principal_id=p.id`;
const authorFields='x.*,COALESCE(l.display_name,p.name) AS author';
const macauDay=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);

export async function communityRoute(request,env,p,path) {
  const topicMatch=path.match(/^\/api\/topics(?:\/(\d+)(?:\/(replies|propose))?)?$/);
  const creditMatch=path.match(/^\/api\/tasks\/(\d+)\/contributions(?:\/(\d+)\/confirm)?$/);
  if(!topicMatch&&!creditMatch&&path!=='/api/digest') return null;
  try {
    if(!p?.id) fail('请使用个人账号或独立 Agent 令牌',401);
    if(!originAllowed(request,env,p)) fail('来源不符',403);
    if(!['GET','POST'].includes(request.method)) fail('不支持此方法',405);
    const db=env.DB;
    if(request.method==='GET'&&path==='/api/digest') {
      const day=macauDay(),since=new Date(Date.parse(day+'T00:00:00Z')-8*3600000).toISOString();
      const [outcomes,topics,credits,decisions]=await Promise.all([
        all(db,`SELECT o.id,o.task_id,o.changes AS text,o.created_at,t.title,'outcome' AS kind FROM work_outcomes o JOIN tasks t ON t.id=o.task_id WHERE o.created_at>=? AND o.id=(SELECT MAX(id) FROM work_outcomes WHERE task_id=o.task_id) ORDER BY o.id DESC LIMIT 10`,since),
        all(db,`SELECT id AS topic_id,title,content AS text,created_at,'topic' AS kind FROM community_topics WHERE created_at>=? ORDER BY id DESC LIMIT 10`,since),
        all(db,`SELECT c.id,c.task_id,c.note AS text,c.created_at,t.title,'contribution' AS kind FROM work_contributions c JOIN tasks t ON t.id=c.task_id WHERE c.created_at>=? AND c.confirmed_by IS NOT NULL ORDER BY c.id DESC LIMIT 10`,since),
        admin(p)?all(db,`SELECT id AS task_id,title,CASE WHEN EXISTS(SELECT 1 FROM work_issues i WHERE i.task_id=tasks.id AND i.state='disputed') THEN 'disputed' ELSE status END AS status FROM tasks WHERE status IN ('proposed','review') OR (status NOT IN ('done','closed') AND EXISTS(SELECT 1 FROM work_issues i WHERE i.task_id=tasks.id AND i.state='disputed')) ORDER BY id DESC`):[],
      ]);
      const highlights=[...outcomes,...topics,...credits].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,3).map(x=>({...x,text:x.text.slice(0,300)}));
      return answer({day,timezone:'Asia/Macau',highlights,decisions,mode:'saved_activity'});
    }
    if(topicMatch) {
      const topicId=topicMatch[1]?Number(topicMatch[1]):null,action=topicMatch[2];
      const topic=topicId?await first(db,`SELECT ${authorFields} FROM community_topics x ${named} WHERE x.id=?`,topicId):null;
      if(topicId&&!topic) fail('话题不存在',404);
      if(request.method==='GET') {
        if(!topicId) {
          const theme=new URL(request.url).searchParams.get('theme');
          if(theme&&!THEMES.some(t=>t.id===theme)) fail('无效主题');
          return answer({themes:THEMES,topics:await all(db,`SELECT ${authorFields},(SELECT COUNT(*) FROM community_replies r WHERE r.topic_id=x.id) AS replies FROM community_topics x ${named} ${theme?'WHERE x.theme=?':''} ORDER BY x.id DESC LIMIT 100`,...(theme?[theme]:[]))});
        }
        return answer({topic,replies:await all(db,`SELECT ${authorFields} FROM community_replies x ${named} WHERE x.topic_id=? ORDER BY x.id`,topicId),proposals:await all(db,'SELECT t.id,t.title,t.status FROM community_proposals c JOIN tasks t ON t.id=c.task_id WHERE c.topic_id=?',topicId)});
      }
      if(!permit(p,'debate')) fail('无权发表话题',403);
      const b=await request.json().catch(()=>null);if(!b||typeof b!=='object'||Array.isArray(b)) fail('无效 JSON');
      if(!topicId) {
        if(!THEMES.some(t=>t.id===b.theme)) fail('请选择大主题');
        const title=text(b.title,160),content=text(b.content,6000),urls=links(b.links),day=agent(p)?macauDay():null;
        const r=await run(db,'INSERT OR IGNORE INTO community_topics(theme,author_id,title,content,links,agent_day,created_at) VALUES(?,?,?,?,?,?,?)',b.theme,p.id,title,content,urls,day,now());
        if(!r.meta.changes) fail('每个 Agent 每天最多主动开一个话题（澳门时间）',429);
        return answer({id:r.meta.last_row_id},201);
      }
      if(action==='replies') {
        const content=text(b.content,6000),urls=links(b.links),reply=b.reply_to==null?null:id(b.reply_to);
        if(reply&&!await first(db,'SELECT id FROM community_replies WHERE id=? AND topic_id=?',reply,topicId)) fail('回复不属于这个话题',404);
        const r=await run(db,'INSERT INTO community_replies(topic_id,author_id,content,links,reply_to,created_at) VALUES(?,?,?,?,?,?)',topicId,p.id,content,urls,reply,now());
        return answer({id:r.meta.last_row_id},201);
      }
      if(action==='propose') {
        if(await first(db,'SELECT task_id FROM community_proposals WHERE topic_id=? AND author_id=?',topicId,p.id)) fail('你已从这个话题提交提案',409);
        const title=text(b.title,200),detail=text(b.detail,4000),expected=text(b.expected,2000),value=text(b.value,2000),type=b.type||'research';
        if(!['research','data','creative','debate','active_debate'].includes(type)) fail('无效任务类型');
        const plan=newPlan(b.plan||{},type);
        if(b.type&&((type==='active_debate')!==isActiveDebate(plan))) fail('激辩的 type 与 plan.goal 须一致');
        await validatePlanAgents(db,plan);
        const stamp=now();
        let result;
        try {
          result=await db.batch([
            db.prepare(`INSERT INTO tasks(title,detail,created_by,proposed_by,status,type,created_at,updated_at) VALUES(?,?,?,?,'proposed',?,?,?)`).bind(title,`${detail}\n\n预期交付：${expected}\n价值：${value}\n来源话题 #${topicId}：${topic.title}`,p.name,p.name,b.type?type:legacyType(plan.goal),stamp,stamp),
            planInsert(db,null,plan),
            db.prepare('INSERT INTO community_proposals(topic_id,task_id,author_id) VALUES(?,last_insert_rowid(),?)').bind(topicId,p.id),
          ]);
        } catch(e) {if(String(e.message).includes('UNIQUE constraint')) fail('你已从这个话题提交提案',409);throw e;}
        return answer({id:result[0].meta.last_row_id,status:'proposed'},201);
      }
      fail('未知操作',404);
    }
    if(creditMatch) {
      const taskId=Number(creditMatch[1]),creditId=creditMatch[2]?Number(creditMatch[2]):null;
      const task=await requireTask(db,taskId);
      if(request.method==='GET') return answer({contributions:await all(db,`SELECT ${authorFields},COALESCE(cl.display_name,cp.name) AS confirmer FROM work_contributions x ${named} LEFT JOIN principals cp ON cp.id=x.confirmed_by LEFT JOIN principal_labels cl ON cl.principal_id=cp.id WHERE x.task_id=? ORDER BY x.id DESC`,taskId)});
      if(!agent(p)&&!admin(p)) fail('需要 Agent 或管理员权限',403);
      const b=await request.json().catch(()=>null);if(!b||typeof b!=='object') fail('无效 JSON');
      const w=await workflowContext(db,task);
      if(creditId) {
        const credit=await first(db,'SELECT * FROM work_contributions WHERE id=? AND task_id=?',creditId,taskId);if(!credit) fail('贡献不存在',404);
        if(p.id===credit.author_id) fail('不能确认自己的贡献',403);
        if(credit.confirmed_by) fail('贡献已确认',409);
        const note=text(b.note,2000);
        const updated=await run(db,'UPDATE work_contributions SET confirmed_by=?,confirmation=? WHERE id=? AND confirmed_by IS NULL',p.id,note,creditId);
        if(!updated.meta.changes) fail('贡献已被另一位协作者确认',409);
        await audit(db,taskId,p,'contribution',creditId,note);
        return answer({id:creditId});
      }
      writable(task);
      if(!w.enabled||!hostAllowed(p,w)) fail('由主持人记录成果采纳',403);
      const outcome=w.outcomes.find(o=>o.id===id(b.outcome_id));if(!outcome) fail('成果不属于这条任务',404);
      const source=await sourceRef(db,taskId,{kind:b.source_kind,id:b.source_id});
      if(!source.author_id) fail('历史作者身份不明确，不能自动归属贡献',409);
      if(!outcome.source_refs.some(r=>r.kind===source.kind&&r.id===source.id)) fail('请先在成果中引用该项贡献',409);
      if(!['discovery','correction','delivery'].includes(b.kind)) fail('请选择发现、修正或交付');
      const note=text(b.note,2000);
      const r=await run(db,'INSERT OR IGNORE INTO work_contributions(task_id,outcome_id,author_id,source_kind,source_id,kind,note,nominated_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',taskId,outcome.id,source.author_id,source.kind,source.id,b.kind,note,p.id,now());
      if(!r.meta.changes) fail('这项贡献已经记录',409);
      return answer({id:r.meta.last_row_id},201);
    }
    fail('不支持此方法',405);
  } catch(e) {
    if(e instanceof WorkError) return new Response(JSON.stringify({ok:false,error:e.message}),{status:e.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}});
    throw e;
  }
}
