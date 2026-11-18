const STAGES = {publish:'发布与审批',start:'开始条件',assign:'接单与分工',execute:'执行与协作',deliver:'成果交付',check:'核查与问题处理',accept:'管理员验收'};
function timestamp(value) {
  if (!value) return NaN;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  return Date.parse(normalized);
}
export function activityTime(value, compact = false) {
  const at = timestamp(value);
  if (!Number.isFinite(at)) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',...(compact ? {} : {year:'numeric'}),month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(at);
}

export function createFlowHistory({data, node, api, renderText}) {
  const panel = node('details', null, 'flow-history');
  panel.dataset.disclosureKey = 'flow-history';
  const heading = node('summary', '各阶段时间与操作记录');
  const content = node('div', null, 'flow-history-content');
  const notice = node('p', '展开流程图后读取实际操作记录。', 'muted flow-history-notice');
  notice.setAttribute('role', 'status');
  const retry = node('button', '重新读取记录', 'text-button');retry.type = 'button';retry.hidden = true;
  panel.append(heading, content);
  content.append(node('p', '时间均为北京时间（UTC+8）。未保存的时间或操作人会明确标为“未记录”。', 'muted flow-history-timezone'), notice, retry);
  const groups = new Map();
  let root, loading = false, loaded = false, failed = false, events = [];
  const important = new Set((data.workflow?.issues || []).filter(issue=>issue.severity==='blocking').map(issue=>issue.id));
  const issueTimes = (data.workflow?.issues || []).filter(issue=>important.has(issue.id)).map(issue=>timestamp(issue.created_at)).filter(Number.isFinite);
  const firstIssue = issueTimes.length ? Math.min(...issueTimes) : null;

  function matches(key, event) {
    if (key.startsWith('subtask-')) return event.entity_type==='subtask' && event.entity_id===Number(key.slice(8));
    if (key==='raise') return event.action==='challenge' || event.action==='issue' && important.has(event.entity_id);
    if (key==='respond') return event.action==='issue_response' && important.has(event.entity_id);
    if (key==='resolve') return ['issue_resolution','issue_dispute'].includes(event.action) && important.has(event.entity_id);
    if (key==='recheck') return event.action==='review' && (firstIssue==null || !Number.isFinite(timestamp(event.at)) || timestamp(event.at)>=firstIssue);
    return event.stage===key;
  }
  function drawRecords(group) {
    if (!loaded || !group.details.open) return;
    if (!group.list) {
      group.list = node('ol', null, 'flow-record-list');
      group.more = node('button', '', 'text-button flow-record-more');group.more.type = 'button';
      group.more.addEventListener('click', ()=>{group.limit+=8;drawRecords(group);});
      group.body.append(group.list, group.more);
    }
    if (!group.records.length && !group.empty) {group.empty=node('p','暂无操作记录。','muted');group.body.append(group.empty);}
    const visible = group.records.slice(0, group.limit);
    for (const event of visible.slice(group.list.children.length)) {
      const item = node('li', null, 'flow-record');
      const title = node('p', null, 'flow-record-title');
      title.append(node('strong', event.actor || '操作人未记录'), node('span', event.label));
      const time = node('time', activityTime(event.at), 'flow-record-time');
      if (Number.isFinite(timestamp(event.at))) time.dateTime = new Date(timestamp(event.at)).toISOString();
      item.append(title, time);
      if (event.description) item.append(renderText ? renderText(event.description, 'flow-record-description') : node('p', event.description, 'flow-record-description'));
      group.list.append(item);
    }
    group.more.hidden = visible.length>=group.records.length;
    group.more.textContent = `再显示 ${Math.min(8,group.records.length-visible.length)} 条（还剩 ${group.records.length-visible.length} 条）`;
  }
  function paint(group) {
    group.records = events.filter(event=>matches(group.key,event));
    const dated = group.records.filter(event=>Number.isFinite(timestamp(event.at)));
    const latest = dated[0]?.at;
    group.count.textContent = loaded ? `${group.records.length} 条` : loading ? '读取中…' : failed ? '读取失败' : '待读取';
    group.range.textContent = !loaded ? '' : dated.length ? `记录范围：${activityTime(dated.at(-1).at)} → ${activityTime(latest)}${dated.length<group.records.length ? `；另有 ${group.records.length-dated.length} 条时间未记录` : ''}` : group.records.length ? '这些历史记录没有保存执行时间。' : '';
    for (const footer of group.footers) {
      footer.time.textContent = !loaded ? loading ? '时间读取中…' : failed ? '读取失败，可重试' : '展开流程读取时间' : latest ? `最近：${activityTime(latest,true)}` : group.records.length ? '时间未记录' : '暂无操作记录';
      footer.time.title = latest ? activityTime(latest) + '（北京时间）' : '';
      footer.button.textContent = loaded ? `操作记录（${group.records.length}）` : '操作记录';
    }
    drawRecords(group);
  }
  function groupFor(step) {
    if (groups.has(step.key)) return groups.get(step.key);
    const details = node('details',null,'flow-stage-history');
    details.dataset.disclosureKey = `flow-stage-history:${step.key}`;
    const summary = node('summary');
    const label = step.key.startsWith('subtask-') ? `分工 · ${step.title}` : ['raise','respond','resolve','recheck'].includes(step.key) ? `修订 · ${step.title}` : step.title;
    const count = node('span','待读取','flow-record-count');summary.append(node('span',label),count);
    const body = node('div',null,'flow-stage-records'), range=node('p','','muted flow-record-range');
    details.append(summary,body);body.append(range);content.append(details);
    const group={key:step.key,details,body,count,range,footers:[],records:[],limit:8,list:null};
    groups.set(step.key,group);
    details.addEventListener('toggle',()=>{if(details.open){load();drawRecords(group);}});
    return group;
  }
  async function load() {
    if (loaded || loading || !root?.isConnected) return;
    loading=true;failed=false;retry.hidden=true;notice.textContent='正在读取操作记录…';
    for(const group of groups.values()) paint(group);
    try {
      const result=await api(`/api/tasks/${data.task.id}/activity`);
      if(!root.isConnected) return;
      if(result.task_id!==data.task.id || !Array.isArray(result.events)) throw Error('操作记录响应不完整，请重试');
      events=result.events;loaded=true;
      for(const stage of new Set(events.map(event=>event.stage))) if(!groups.has(stage)) groupFor({key:stage,title:STAGES[stage]||'其他记录'});
      notice.textContent=`共 ${events.length} 条操作记录；展开对应阶段查看执行人、时间与内容。`;
    } catch(error) {
      if(!root.isConnected) return;
      failed=true;notice.textContent=`操作记录暂时无法读取：${error.message}`;retry.hidden=false;
    } finally {
      loading=false;
      if(root.isConnected) for(const group of groups.values()) paint(group);
    }
  }
  retry.addEventListener('click',load);
  panel.addEventListener('toggle',()=>{if(panel.open) load();});
  return {
    panel,
    footer(step) {
      const group=groupFor(step),footer=node('div',null,'flow-step-history');
      const time=node('span','展开流程读取时间','flow-step-time');
      const button=node('button','操作记录','text-button flow-log-button');button.type='button';
      button.addEventListener('click',()=>{panel.open=true;group.details.open=true;load();group.details.scrollIntoView({block:'start',behavior:'smooth'});});
      footer.append(time,button);group.footers.push({time,button});return footer;
    },
    attach(target) {root=target;root.addEventListener('toggle',()=>{if(root.open)load();});},
  };
}
