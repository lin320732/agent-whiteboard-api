const ACTIONS = {
  task_claim: ['assign', '认领任务'], task_result: ['deliver', '提交文字成果'],
  task_verify: ['accept', '验收任务'], task_approve: ['publish', '批准提案'],
  task_reject: ['publish', '驳回提案'], task_reopen: ['assign', '退回待认领'],
  discussion_close: ['accept', '关闭激辩'],
  plan: ['assign', '更新目标、验收与执行安排'], host: ['assign', '设置主持与验收'],
  trigger: ['start', '确认执行事件'], wait: ['execute', '设置等待'],
  outcome: ['deliver', '提交成果版本'], issue: ['check', '提出问题'],
  issue_response: ['check', '回应问题'], issue_dispute: ['check', '提交争议裁决'],
  issue_resolution: ['check', '确认问题解决'], contribution: ['execute', '确认采用贡献'],
};
const SUBTASK_ACTIONS = {
  assigned: ['assign', '指派子任务'], reassign: ['assign', '改派子任务'],
  accept: ['execute', '接下子任务'], decline: ['execute', '退出子任务'],
  wait: ['execute', '等待外部事件'], submit: ['execute', '提交子任务成果'],
  check: ['check', '独立核查子任务'], remind: ['execute', '询问子任务进度'],
};
const GOALS = {research:'调研查证',analysis:'分析决策',content:'内容创作',build:'制作执行',active_debate:'激辩'};
const COLLABORATIONS = {open:'自主认领协作',hosted:'主持分工'};
const ROLES = {researcher:'研究员',checker:'核查员',challenger:'红队',supplementer:'补充者'};
const STATUSES = {open:'待认领',in_progress:'进行中',review:'待核对',proposed:'待批准',done:'已完成',closed:'已关闭'};
const parse = value => {try {return JSON.parse(value);} catch {return null;}};
const lines = (...values) => values.filter(value => value != null && value !== '').map(String).join('\n');

// Core actions share the existing append-only audit table; never store request headers.
export function taskAuditStatement(db, taskId, principal, kind, detail, at, conditional = false) {
  const recorded = {...detail, ...(!principal.id ? {legacy_actor: true} : {})};
  return db.prepare(`INSERT INTO work_activity(task_id,actor_id,kind,record_id,detail,created_at) SELECT ?,?,?,?,?,?${conditional ? ' WHERE changes()=1' : ''}`)
    .bind(taskId, principal.id || 0, kind, taskId, JSON.stringify(recorded), at);
}

export async function readTaskActivity(db, task) {
  const queries = [
    ['SELECT * FROM work_activity WHERE task_id=? ORDER BY id', task.id],
    ['SELECT * FROM work_subtask_events WHERE task_id=? ORDER BY id', task.id],
    ['SELECT * FROM work_subtasks WHERE task_id=? ORDER BY id', task.id],
    ['SELECT o.*,d.report_json FROM work_outcomes o LEFT JOIN work_deliveries d ON d.outcome_id=o.id WHERE o.task_id=? ORDER BY o.id', task.id],
    ['SELECT * FROM work_reviews WHERE task_id=? ORDER BY id', task.id],
    ['SELECT * FROM work_issues WHERE task_id=? ORDER BY id', task.id],
    ['SELECT * FROM challenges WHERE task_id=? ORDER BY id', task.id],
    ['SELECT * FROM supplements WHERE task_id=? ORDER BY id', task.id],
    ['SELECT * FROM debate_messages WHERE task_id=? ORDER BY id', task.id],
    ['SELECT * FROM force_approvals WHERE task_id=? ORDER BY id', task.id],
    ['SELECT * FROM events WHERE task_id=? ORDER BY id', task.id],
    ['SELECT * FROM work_contributions WHERE task_id=? ORDER BY id', task.id],
    ["SELECT p.id,p.name AS actor,COALESCE(l.display_name,p.name) AS name FROM principals p LEFT JOIN principal_labels l ON l.principal_id=p.id"],
    ['SELECT r.previous_task_id,r.next_task_id,t.created_at FROM task_recurrences r JOIN tasks t ON t.id=r.next_task_id WHERE r.previous_task_id=? OR r.next_task_id=?',task.id,task.id],
  ];
  const results = await db.batch(queries.map(([sql, ...args]) => db.prepare(sql).bind(...args)));
  const [audits, subEvents, subtasks, outcomes, reviews, issues, challenges, supplements, debate, forced, credits, contributions, people, periods] = results.map(result => result.results);
  const names = new Map(people.map(person => [person.id, person.name]));
  const actors = new Map();
  for (const person of people) {
    if (!actors.has(person.actor)) actors.set(person.actor, person);
    else actors.set(person.actor, null);
  }
  const named = value => actors.get(value)?.name || value || '';
  const byId = value => names.get(value) || (value ? `账号 #${value}` : '操作人未记录');
  const events = [];
  function add(id, stage, action, label, {actorId = null, actor = '', literalActor = false, at = null, description = '', entityType = 'task', entityId = task.id, source = 'record'} = {}) {
    events.push({id, stage, action, label, actor_id: actorId || null, actor: actorId ? byId(actorId) : (literalActor ? actor : named(actor)) || '操作人未记录', at: at || null, description: String(description || ''), entity_type: entityType, entity_id: entityId, source});
  }
  const hasAudit = (kind, recordId) => audits.some(row => row.kind === kind && row.record_id === recordId);
  const sameCredit = (kind, row) => audits.some(audit => audit.kind === kind && audit.created_at === row.created_at);
  const previous=periods.find(period=>period.next_task_id===task.id);
  add(`task:${task.id}`, 'publish', previous ? 'recurrence_create' : task.proposed_by ? 'propose' : 'create', previous ? '自动建立本期任务' : task.proposed_by ? '提交任务提案' : '发布任务', {actor: previous ? '系统（上期验收后生成）' : task.created_by || task.proposed_by, literalActor: !!previous, at: task.created_at, description: previous ? `上一期任务 #${previous.previous_task_id}` : `当前任务：${task.title}`});
  for(const period of periods.filter(period=>period.previous_task_id===task.id)) add(`next:${period.next_task_id}`,'accept','recurrence_next',`生成下一期任务 #${period.next_task_id}`,{actor:'系统',literalActor:true,at:period.created_at,description:'在上一期验收后建立独立执行周期，不复用旧成果或核查。'});

  for (const audit of audits) {
    if (audit.kind === 'outcome' && outcomes.some(row => row.id === audit.record_id)) continue;
    if (audit.kind === 'issue' && issues.some(row => row.id === audit.record_id)) continue;
    const detail = parse(audit.detail);
    let description = audit.detail;
    if (detail && typeof detail === 'object') {
      if (audit.kind === 'plan') description = lines(`安排版本：${detail.revision}`, `目标：${GOALS[detail.goal]||detail.goal}；协作：${COLLABORATIONS[detail.collaboration]||detail.collaboration}`, detail.delivery?.author_id ? `主要作者：${byId(detail.delivery.author_id)}` : '', detail.acceptance?.criteria, detail.schedule?.start_at ? `计划开始：${detail.schedule.start_at}` : '', detail.schedule?.event ? `触发条件：${detail.schedule.event}` : '');
      else if (audit.kind === 'host') description = lines(`主持人：${byId(detail.host_id)}`, detail.acceptance, `至少 ${detail.min_sources} 条来源`);
      else if (audit.kind === 'wait') description = detail.resume_at ? lines(detail.reason, `计划恢复：${detail.resume_at}`) : detail.resume_at===null ? '恢复任务，结束临时等待' : detail.reason || audit.detail;
      else if (audit.kind === 'issue_response') description = lines(detail.response, detail.evidence);
      else if (audit.kind === 'discussion_close') description = detail.reason || '';
      else if (audit.kind === 'task_verify') description = lines(detail.forced ? `强制验收：${detail.reason}` : '按当前验收条件确认任务完成', detail.outcome_id ? `成果版本 #${detail.outcome_id}` : '', detail.report_revision ? `报告版本 ${detail.report_revision}` : '');
      else description = lines(detail.summary, detail.links, detail.role ? `认领角色：${ROLES[detail.role]||detail.role}` : '', detail.previous_status ? `操作前状态：${STATUSES[detail.previous_status]||detail.previous_status}` : '', detail.note);
    }
    const [stage, label] = ACTIONS[audit.kind] || ['execute', '协作操作'];
    const entityType = audit.kind.startsWith('issue') ? 'issue' : audit.kind === 'outcome' ? 'outcome' : audit.kind === 'contribution' ? 'contribution' : 'task';
    add(`audit:${audit.id}`, stage, audit.kind, audit.kind === 'wait' && detail?.resume_at === null ? '恢复任务' : label, {actorId: audit.actor_id, actor: detail?.legacy_actor ? `共享凭据（署名：${detail.actor_name || '未记录'}）` : '', literalActor: !!detail?.legacy_actor, at: audit.created_at, description, entityType, entityId: audit.record_id, source: 'audit'});
  }
  for (const outcome of outcomes) {
    const report = parse(outcome.report_json);
    add(`outcome:${outcome.id}`, 'deliver', 'outcome', report ? `登记网页报告 ${report.revision}` : `提交成果版本 #${outcome.id}`, {actorId: outcome.author_id, at: outcome.created_at, description: lines(outcome.changes, outcome.summary, report?.url), entityType: 'outcome', entityId: outcome.id});
  }
  for (const review of reviews) add(`review:${review.id}`, 'check', 'review', '提交独立核查', {actorId: review.reviewer_id, at: review.created_at, description: lines(review.note, review.evidence), entityType: 'review', entityId: review.id});
  for (const issue of issues) {
    if (!issue.challenge_id || !challenges.some(row => row.id === issue.challenge_id)) add(`issue:${issue.id}`, 'check', 'issue', issue.severity === 'blocking' ? '提出重要问题' : '提出改进建议', {actorId: issue.author_id, at: issue.created_at, description: issue.text, entityType: 'issue', entityId: issue.id});
    const responses = audits.filter(row => row.kind === 'issue_response' && row.record_id === issue.id);
    const latest = responses.at(-1);
    if (issue.response && (!latest || parse(latest.detail)?.response !== issue.response || latest.actor_id !== issue.responder_id)) add(`response-undated:${issue.id}`, 'check', 'issue_response', '当前保存的回应（时间未记录）', {actorId: issue.responder_id, description: lines(issue.response, issue.evidence), entityType: 'issue', entityId: issue.id, source: 'undated'});
    const kind = issue.state === 'disputed' ? 'issue_dispute' : 'issue_resolution';
    if (['resolved', 'disputed'].includes(issue.state) && !hasAudit(kind, issue.id)) add(`resolution-undated:${issue.id}`, 'check', kind, issue.state === 'disputed' ? '当前争议记录（时间未记录）' : '当前解决确认（时间未记录）', {actorId: issue.resolver_id, description: issue.resolution, entityType: 'issue', entityId: issue.id, source: 'undated'});
  }
  for (const challenge of challenges) add(`challenge:${challenge.id}`, 'check', 'challenge', '提出质疑', {actor: challenge.agent, at: challenge.created_at, description: lines(challenge.reason, challenge.evidence), entityType: 'challenge', entityId: challenge.id});
  for (const supplement of supplements) add(`supplement:${supplement.id}`, 'execute', 'supplement', `补充材料 v${supplement.version}`, {actor: supplement.agent, at: supplement.created_at, description: lines(supplement.summary, supplement.links), entityType: 'supplement', entityId: supplement.id});
  for (const row of debate) add(`debate:${row.id}`, 'execute', 'debate', `参与讨论${row.stance ? ` · ${row.stance}` : ''}`, {actor: row.agent, at: row.created_at, description: row.content, entityType: 'debate', entityId: row.id});
  for (const event of subEvents) {
    const subtask = subtasks.find(row => row.id === event.subtask_id);
    const detail = parse(event.detail);
    const [stage, label] = SUBTASK_ACTIONS[event.action] || ['execute', '子任务操作'];
    add(`subtask-event:${event.id}`, stage, `subtask_${event.action}`, label, {actorId: event.actor_id, at: event.created_at, description: lines(subtask?.title || `子任务 #${event.subtask_id}`, detail?.assignee_id ? `受派人：${byId(detail.assignee_id)}` : '', detail?.detail, detail?.resume_at ? `计划恢复：${detail.resume_at}` : ''), entityType: 'subtask', entityId: event.subtask_id});
  }
  for (const subtask of subtasks) {
    const history = subEvents.filter(row => row.subtask_id === subtask.id);
    if (!history.some(row => ['assigned', 'reassign'].includes(row.action))) add(`subtask-assignment:${subtask.id}`, 'assign', 'subtask_assigned', '当前分工指派记录', {at: subtask.assigned_at, description: lines(subtask.title, `受派人：${byId(subtask.assignee_id)}`), entityType: 'subtask', entityId: subtask.id});
    if (['submitted', 'done'].includes(subtask.state) && subtask.summary && !history.some(row => row.action === 'submit')) add(`subtask-submit-undated:${subtask.id}`, 'execute', 'subtask_submit', '当前子任务成果（时间未记录）', {actorId: subtask.assignee_id, description: lines(subtask.summary, subtask.links), entityType: 'subtask', entityId: subtask.id, source: 'undated'});
    if (subtask.state === 'done' && !history.some(row => row.action === 'check')) add(`subtask-check-undated:${subtask.id}`, 'check', 'subtask_check', '当前子任务核查（时间未记录）', {actorId: subtask.reviewer_id, description: subtask.review_note, entityType: 'subtask', entityId: subtask.id, source: 'undated'});
  }
  for (const row of forced) {
    if (sameCredit('task_verify', row)) continue;
    add(`forced:${row.id}`, 'accept', 'task_verify', '强制验收任务', {actor: row.agent, at: row.created_at, description: row.reason});
  }
  for (const row of credits) {
    const kind = {claim: 'task_claim', result: 'task_result', verify: 'task_verify', propose_approved: 'task_approve'}[row.type];
    if (!kind || sameCredit(kind, row) || row.type === 'verify' && forced.some(record => record.created_at === row.created_at)) continue;
    const [stage, label] = ACTIONS[kind];
    // Verification/approval scores belong to the contributor, not the administrator.
    const knownActor = row.type === 'claim';
    add(`credit:${row.id}`, stage, kind, knownActor ? label : `${label}（历史积分事件）`, {actor: knownActor ? row.agent : '', at: row.created_at, description: knownActor ? '' : `积分归属：${named(row.agent)}；实际操作人及当时操作内容未记录。`, source: 'legacy_credit'});
  }
  for (const row of contributions) add(`contribution:${row.id}`, 'execute', 'contribution_nominate', '记录采用的贡献', {actorId: row.nominated_by, at: row.created_at, description: lines(`贡献者：${byId(row.author_id)}`, row.note), entityType: 'contribution', entityId: row.id});
  const stamp = value => Date.parse(typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value) || 0;
  events.sort((a, b) => stamp(b.at) - stamp(a.at) || (a.id.split(':')[0] === b.id.split(':')[0] ? Number(b.id.split(':').at(-1)) - Number(a.id.split(':').at(-1)) : b.id.localeCompare(a.id)));
  return {task_id: task.id, timezone: 'Asia/Shanghai', events};
}
