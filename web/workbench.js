const finished = task => ['done', 'closed'].includes(task.status);
const time = task => Date.parse(task.outcome_preview?.updated_at || task.updated_at || task.created_at) || task.id || 0;

// A submitted result is not necessarily ready for acceptance. Inbox entries can repeat a task.
export function workbenchItems(tasks, digest, admin) {
  const disputed = new Set((digest?.decisions || []).filter(item => item.status === 'disputed').map(item => item.task_id));
  const decisions = [], tracking = [];
  for (const task of tasks) {
    if (finished(task)) continue;
    let kind = '';
    if (admin) {
      if (disputed.has(task.id)) kind = 'dispute';
      else if (task.status === 'review' && task.verify_readiness?.ready === true) kind = 'accept';
      else if (task.status === 'proposed') kind = 'approve';
      else if (task.discussion?.phase === 'ended' && !task.discussion.participation_sufficient) kind = 'insufficient';
    }
    if (kind) decisions.push({task, kind});
    else tracking.push(task);
  }
  const order = {dispute: 0, insufficient: 1, accept: 2, approve: 3};
  decisions.sort((a, b) => order[a.kind] - order[b.kind] || time(b.task) - time(a.task));
  tracking.sort((a, b) => time(b) - time(a));
  const outcomes = tasks.filter(task => ['review', 'done'].includes(task.status)).sort((a, b) => time(b) - time(a));
  return {decisions, tracking, outcomes};
}

export function createWorkbench({node, button, openTask, openOutcome, showTasks}) {
  const labels = {dispute: '待你裁决', insufficient:'激辩参与不足', accept: '可以验收', approve: '待批准'};
  const statuses = {open: '待认领', in_progress: '进行中', review: '待补齐核查', proposed: '待批准'};
  const compact = value => Array.from(String(value || '').replace(/https?:\/\/\S+/g, '').trim()).slice(0, 100).join('');
  function row(task, badge, detail, onClick) {
    const item = button('', onClick, 'workbench-item');
    const head = node('span', null, 'workbench-item-head');
    head.append(node('strong', task.title), node('span', badge, 'badge'));
    item.append(head);
    if (detail) item.append(node('span', compact(detail), 'workbench-item-note'));
    return item;
  }
  function fill(id, items, empty) {
    const target = document.getElementById(id);
    target.replaceChildren(...items);
    if (!items.length) target.append(node('p', empty, 'muted workbench-empty'));
  }
  function render(tasks, home, user) {
    const admin = user?.role === 'admin';
    const {decisions, tracking, outcomes} = workbenchItems(tasks, home?.digest, admin);
    document.getElementById('decisionTitle').textContent = admin ? '待你处理' : '进度概况';
    document.getElementById('decisionCount').textContent = `${decisions.length} 项`;
    document.getElementById('homeBadge').textContent = decisions.length || '';
    document.getElementById('homeBadge').hidden = !decisions.length;
    fill('decisionList', decisions.map(({task, kind}) => row(task, labels[kind], kind === 'accept' ? '核查条件已齐，等你确认交付。' : kind === 'dispute' ? '有分歧需要你判断。' : kind === 'insufficient' ? '激辩已截止，参与不足；请调整截止时间或留理由关闭。' : '查看目标与安排后决定是否批准。', () => openTask(task.id, {tab: kind === 'approve' ? 'overview' : 'review'}))), admin ? '目前没有需要你决定的事。' : '你可以查看任务进度和最新成果。');
    document.getElementById('decisionStatus').textContent = admin && !home?.digest ? '争议待办暂时无法载入，请刷新重试。' : '';
    fill('dailyHighlights', outcomes.slice(0, 3).map(task => row(task, task.status === 'done' ? '已完成' : task.verify_readiness?.ready ? '可以验收' : '核查中', task.outcome_preview ? task.outcome_preview.summary || '已提交成果，点击阅读。' : task.result_summary || (task.report ? `报告 ${task.report.revision}，点击阅读。` : '点击阅读成果。'), () => openOutcome(task.id))), '还没有提交的成果。');
    fill('workInbox', tracking.slice(0, 5).map(task => row(task, task.status === 'review' && task.verify_readiness?.ready ? '待管理员验收' : statuses[task.status] || '进行中', task.collaboration?.reason || (task.status === 'open' ? '等待 Agent 接单' : task.claimed_by ? `${task.claimed_by} 正在处理` : '查看任务进度'), () => openTask(task.id))), '目前没有等待中的任务。');
    document.getElementById('trackingCount').textContent = `${tracking.length} 项`;
    const more = document.getElementById('trackingMore');
    more.hidden = tracking.length <= 5;
    more.onclick = showTasks;
  }
  return {render};
}
