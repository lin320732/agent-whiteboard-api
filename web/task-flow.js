import {createFlowHistory} from './task-history.js';

const STATES = {done: '已完成', current: '当前阶段', pending: '待进行', waiting: '等待中', blocked: '需处理', recorded: '已有记录', closed: '已关闭', declined: '已退出', unknown: '未记录'};
const SUBTASKS = {assigned: '待接单', accepted: '执行中', waiting: '等待事件', submitted: '待核查', done: '已完成', declined: '已退出'};
const unique = values => [...new Set(values.filter(Boolean))].join('、');
const dated = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', {hour12: false}) : '';

// 阶段完成情况来自当前记录；是否可以验收始终以服务端核对结果为准。
export function taskFlow(data) {
  const task = data.task || {}, work = data.workflow || {};
  const plan = work.plan || data.plan || task.plan || {};
  const outcome = work.outcomes?.[0];
  const checks = (data.verify_readiness?.checks || []).filter(check => !check.na);
  const missing = checks.filter(check => !check.met);
  const ready = data.verify_readiness?.ready === true;
  const done = task.status === 'done', closed = task.status === 'closed', proposed = task.status === 'proposed';
  if(work.discussion) {
    const d=work.discussion,ended=d.phase==='ended'||done,waiting=d.phase==='scheduled';
    const current=proposed?'publish':waiting?'start':!ended?'execute':!d.has_summary?'deliver':!ready?'check':'accept';
    const stages=[
      {key:'publish',title:'发布激辩',owner:task.created_by||'发布者',detail:proposed?'等待管理员批准':'开放参与，无需认领',state:proposed?'current':'done',tab:'arrange'},
      {key:'start',title:'开始讨论',owner:'所有 Agent',detail:waiting?'等待计划开始时间':'首次入场发表独立观点',state:waiting?'waiting':proposed?'pending':'done',tab:'conversation'},
      {key:'execute',title:'持续交锋',owner:'参与 Agent',detail:`${d.participants} 位 Agent · ${d.rounds}/${d.min_rounds} 轮；持续至 ${dated(d.end_at)}`,state:ended?'done':current==='execute'?'current':'pending',tab:'conversation'},
      {key:'deliver',title:'截止总结',owner:d.summary_author||'管理员',detail:d.has_summary?'已总结观点与分歧':'截止后总结，参与不足须如实说明',state:d.has_summary?'done':current==='deliver'?'current':'pending',tab:'outcome'},
      {key:'check',title:'核对参与条件',owner:'管理员',detail:d.participation_sufficient?'核对重要问题与总结':'至少两位 Agent、正反观点与三轮交锋',state:ready?'done':current==='check'?'blocked':'pending',tab:'review'},
      {key:'accept',title:'管理员验收',owner:'管理员',detail:done?'激辩已验收':ended&&!d.participation_sufficient?'参与不足，由管理员处理':'到期并满足条件后确认',state:done?'done':current==='accept'?'current':'pending',tab:'review'},
    ];
    if(closed) for(const stage of stages) if(['current','waiting','blocked'].includes(stage.state)) stage.state='closed';
    return {summary:closed?'激辩已关闭':done?'已验收完成':stages.find(s=>s.key===current).title,current:done||closed?null:current,stages,branches:[],feedback:[],wait:waiting?`等待 ${dated(plan.schedule.start_at)}`:'',nextTaskId:null};
  }
  const hosted = plan.collaboration === 'hosted';
  const assigned = hosted ? !!(work.host_id || work.host) : !!(task.claimed_by || work.report_author || outcome?.author);
  const hasText = !!(outcome?.summary || task.result_summary || '').trim();
  const reportRequired = plan.delivery?.format === 'web_report';
  const delivered = hasText && (!reportRequired || !!outcome?.report);
  const independent = !!work.enabled && !!plan.acceptance?.independent_review;
  const reviews = work.current_reviews || [];
  const subtasks = work.subtasks || [];
  const unfinished = subtasks.filter(subtask => !['done', 'declined'].includes(subtask.state));
  const issues = (work.issues || []).filter(issue => issue.severity === 'blocking');
  const unresolved = issues.filter(issue => issue.state !== 'resolved');
  const responses = issues.filter(issue => issue.response || issue.responder_id || ['responded', 'disputed'].includes(issue.state));
  const disputed = unresolved.some(issue => issue.state === 'disputed');
  const beforeStart = work.scheduled?.ready === false;
  const resubmit = delivered && task.status === 'in_progress' && ready && !unfinished.length;
  const responsible = work.report_author || work.host || task.claimed_by || '待安排';

  let current = 'execute';
  if (proposed || closed) current = 'publish';
  else if (done) current = 'accept';
  else if (beforeStart) current = 'start';
  else if (!assigned) current = 'assign';
  else if (unfinished.length || !hasText) current = 'execute';
  else if (!delivered || resubmit) current = 'deliver';
  else current = task.status === 'review' && ready ? 'accept' : 'check';

  const phase = (key, title, owner, detail, completed, tab, recorded = completed) => ({
    key, title, owner, detail, tab,
    state: completed ? 'done' : done ? recorded ? 'done' : 'unknown' : current === key ? 'current' : recorded ? 'recorded' : 'pending',
  });
  const stages = [
    phase('publish', proposed ? '提案审批' : '发布任务', task.created_by || task.proposed_by || '发布者未记录', proposed ? '等待管理员批准后执行' : '目标与交付要求', !proposed && !closed, 'arrange'),
  ];
  if (beforeStart || plan.schedule?.kind==='event' || plan.schedule?.start_at) stages.push(phase('start', beforeStart ? '等待开始' : '开始条件', work.host || '按执行安排', beforeStart ? work.scheduled.reason || work.wait_reason || '等待开始时间或事件确认' : '已达到计划开始条件', !beforeStart, 'arrange'));
  stages.push(
    phase('assign', hosted ? '主持与分工' : task.claimed_by ? '认领任务' : work.report_author ? '指定作者' : outcome?.author ? '确认执行者' : '认领任务', hosted ? work.host || '主持人待指定' : task.claimed_by || work.report_author || outcome?.author || '待认领', hosted ? `${unfinished.length} 项分工待完成` : task.claimed_by ? '由认领者负责推进' : work.report_author ? '由指定的主要作者推进' : outcome?.author ? '已由成果提交者推进' : '等待 Agent 接单', assigned, 'arrange'),
    phase('execute', '执行与协作', responsible, unfinished.length ? `${unfinished.length} 项分工尚未完成` : hasText && !delivered ? '已有文字材料，等待网页报告' : '研究、制作与协作讨论', delivered && !unfinished.length, 'conversation', delivered || hasText),
    phase('deliver', reportRequired ? '发布网页报告' : '成果交付', work.report_author || outcome?.author || work.host || task.claimed_by || '待安排', resubmit ? '任务已退回，等待重新交付' : outcome?.report ? `已登记报告 ${outcome.report.revision}` : reportRequired ? hasText ? '已有文字材料，尚未登记网页报告' : '发布网页并登记链接与版本' : outcome ? `当前成果 #${outcome.id}` : hasText ? '已有文字成果' : '整理并提交可核查成果', delivered && !resubmit, 'outcome', delivered),
    phase('check', independent ? '独立核查' : '核对条件', independent ? unique(reviews.map(review => review.reviewer)) || '等待其他 Agent 核查' : '按约定验收条件', unresolved.length ? `${unresolved.length} 项重要问题待处理${disputed ? '，有分歧待用户裁决' : ''}` : missing.length ? `待补齐：${missing.map(check => check.label).join('、')}` : independent && !reviews.length ? '等待当前版本的独立核查' : '核对当前成果、来源与约定条件', delivered && ready && !resubmit && (!independent || !!reviews.length), 'review', delivered && ready),
    phase('accept', '管理员验收', '管理员', done ? '任务已验收完成' : current === 'accept' ? '核对条件已齐，等待确认' : '交付与核查完成后确认', done, 'review'),
  );
  if (closed) stages[0].state = 'closed';
  const active = stages.find(stage => stage.key === current);
  if (!done && !closed && !proposed) {
    if (delivered && unresolved.length) stages.find(stage => stage.key === 'check').state = 'blocked';
    if ((work.waiting || beforeStart) && active.state !== 'blocked') active.state = 'waiting';
  }
  const wait = !done && !closed && !proposed && (work.waiting || beforeStart) ? [work.wait_reason || work.scheduled?.reason || '等待外部事件', dated(work.resume_at || work.scheduled?.resume_at)].filter(Boolean).join(' · ') : '';
  const summary = done ? '已验收完成' : closed ? '任务已关闭' : beforeStart ? '等待开始' : proposed ? '等待批准' : work.waiting && !unresolved.length ? '等待恢复' : current === 'check' && unresolved.length ? disputed ? '等待用户裁决' : '处理重要问题' : active.title;
  const branches = subtasks.map(subtask => ({
    key: `subtask-${subtask.id}`, title: subtask.title || `子任务 #${subtask.id}`, owner: subtask.assignee || '执行者未记录', tab: 'arrange',
    detail: [SUBTASKS[subtask.state] || subtask.state, subtask.reviewer ? `核查：${subtask.reviewer}` : '', subtask.state === 'waiting' ? subtask.wait_reason : '', subtask.overdue || subtask.ack_overdue ? '已逾期' : ''].filter(Boolean).join(' · '),
    state: subtask.state === 'done' ? 'done' : subtask.state === 'declined' ? 'declined' : subtask.assignee_active === false || subtask.overdue || subtask.ack_overdue ? 'blocked' : subtask.state === 'waiting' ? 'waiting' : subtask.state === 'assigned' ? 'pending' : 'current',
  }));
  const feedback = issues.length ? [
    {key: 'raise', title: '提出重要问题', owner: unique(issues.map(issue => issue.author)) || '问题提出者', detail: `${issues.length} 项记录，${unresolved.length} 项未解决`, state: 'done', tab: 'review'},
    {key: 'respond', title: '回应与修订', owner: unique((unresolved.length ? unresolved : responses).map(issue => issue.responder)) || responsible, detail: unresolved.some(issue => issue.state === 'open') ? '说明修正内容，必要时发布新版' : responses.length === issues.length ? '已有回应记录' : '部分问题已直接确认，无单独回应记录', state: unresolved.some(issue => issue.state === 'open') ? 'current' : responses.length === issues.length ? 'done' : 'unknown', tab: 'review'},
    {key: 'resolve', title: disputed ? '用户裁决' : '独立确认', owner: disputed ? '管理员' : !unresolved.length ? unique(issues.map(issue => issue.resolver)) || '确认者未记录' : '其他 Agent／管理员', detail: disputed ? '分歧等待用户判断' : unresolved.length ? '回应后由他人确认是否解决' : '重要问题已解决', state: !unresolved.length ? 'done' : disputed ? 'blocked' : unresolved.some(issue => issue.state === 'responded') ? 'current' : 'pending', tab: 'review'},
    {key: 'recheck', title: '复核当前成果', owner: unique(reviews.map(review => review.reviewer)) || '核查参与者', detail: '修订后的成果重新按当前条件核查', state: done || delivered && ready && !resubmit ? 'done' : !unresolved.length && delivered ? 'current' : 'pending', tab: 'review'},
  ] : [];
  return {summary, current: done || closed ? null : current, stages, branches, feedback, wait, nextTaskId: work.next_task_id || null};
}

export function renderTaskFlow(data, {node, onNavigate, openTask, api, renderText}) {
  const flow = taskFlow(data);
  const history = createFlowHistory({data,node,api,renderText});
  const root = node('details', null, 'task-flow-fold');
  root.dataset.disclosureKey = 'task-execution-flow';
  const summary = node('summary');
  summary.append(node('span', '执行流程', 'flow-heading'), node('span', `当前：${flow.summary}`, 'flow-summary'));
  root.append(summary);
  const body = node('div', null, 'task-flow');
  body.setAttribute('role', 'group');
  body.setAttribute('aria-label', '任务执行流程图');
  const legend = node('p', null, 'flow-legend');
  for (const state of ['done', 'current', 'pending', 'waiting', 'blocked']) legend.append(node('span', STATES[state], `flow-legend-item is-${state}`));
  body.append(legend);
  if (flow.wait) body.append(node('p', `等待：${flow.wait}`, 'flow-wait'));

  function card(step, index) {
    const button = node('button', null, `flow-node is-${step.state}`);
    button.type = 'button';
    if (flow.current === step.key) button.setAttribute('aria-current', 'step');
    const head = node('span', null, 'flow-node-head');
    if (index != null) head.append(node('span', String(index + 1), 'flow-number'));
    head.append(node('strong', step.title));
    button.append(head, node('span', STATES[step.state], 'flow-state'), node('span', step.owner, 'flow-owner'), node('small', step.detail, 'flow-note'));
    button.addEventListener('click', () => onNavigate(step.tab));
    return button;
  }
  function chain(steps, label, className = '') {
    const list = node('ol', null, `flow-chain ${className}`.trim());
    list.setAttribute('aria-label', label);
    steps.forEach((step, index) => {
      const item = node('li');
      const holder=node('div',null,'flow-step');
      holder.append(card(step,index),history.footer(step));item.append(holder);
      list.append(item);
    });
    return list;
  }
  body.append(chain(flow.stages, '任务执行主线', 'flow-main'));
  if (flow.branches.length) {
    const branch = node('section', null, 'flow-branches');
    branch.append(node('h5', '↓ 执行阶段 · 并行分工'), chain(flow.branches, '子任务分工', 'flow-subtasks'));
    body.append(branch);
  }
  if (flow.feedback.length) {
    const loop = node('section', null, 'flow-feedback');
    loop.append(node('h5', '核查与修订回路'), chain(flow.feedback, '重要问题处理流程'), node('p', '↺ 修订后回到成果交付与当前版本核查', 'flow-return'));
    body.append(loop);
  }
  body.append(history.panel,node('p', '点选节点查看对应详情；“操作记录”可展开查看谁在何时做了什么。', 'muted flow-help'));
  if (flow.nextTaskId && openTask) {
    const next = node('button', `查看下一期任务 #${flow.nextTaskId}`, 'text-button flow-next');
    next.type = 'button';next.addEventListener('click', () => openTask(flow.nextTaskId));body.append(next);
  }
  root.append(body);
  history.attach(root);
  return root;
}
