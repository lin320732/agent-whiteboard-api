// 精简任务参与角色呈现：聚焦真正影响权责的 5–6 类核心角色，避免碎片化清单。
const SUBTASK_STATES = { assigned: '待接单', accepted: '已接单', waiting: '等待事件', submitted: '待核查', done: '已完成' };

export function renderTaskRoles(data, {node, agents = [], renderAgentName = null}) {
  const task = data.task || {}, work = data.workflow || {};
  const plan = work.plan || data.plan || task.plan;
  const names = new Map(agents.map(person => [person.id, person.name]));
  const remember = (id, name) => { if (id && name) names.set(id, name); };
  remember(work.host_id, work.host);
  remember(work.report_author_id, work.report_author);
  for (const outcome of work.outcomes || []) remember(outcome.author_id, outcome.author);
  for (const review of [...(work.reviews || []), ...(work.current_reviews || [])]) remember(review.reviewer_id, review.reviewer);
  for (const subtask of work.subtasks || []) {
    remember(subtask.assignee_id, subtask.assignee);
    remember(subtask.reviewer_id, subtask.reviewer);
  }
  for (const issue of work.issues || []) {
    remember(issue.author_id, issue.author);
    remember(issue.responder_id, issue.responder);
    remember(issue.resolver_id, issue.resolver);
  }

  const roles = new Map();
  function add(role, name, {id, note = '', empty = ''} = {}) {
    name = (name || names.get(id) || (id ? `Agent #${id}` : '')).trim();
    if (!name && !empty) return;
    if (!roles.has(role)) roles.set(role, {members: [], empty});
    if (!name) return;
    const members = roles.get(role).members;
    let member = members.find(person => id && person.id ? person.id === id : person.name === name);
    if (!member) {member = {id, name, notes: new Set()}; members.push(member);}
    if (note) member.notes.add(note);
  }

  // 1. 发布与提案
  add('发布者', task.created_by, {note: task.proposed_by && task.proposed_by === task.created_by ? 'Agent 提案' : ''});
  if (task.proposed_by && task.proposed_by !== task.created_by) add('发布者', task.proposed_by, {note: '提案人'});

  // 2. 负责人（主持人 / 认领者 / 激辩总结负责人）
  if (work.discussion) {
    const recapNote = work.discussion.recap_count ? `已总结 ${work.discussion.recap_count} 次` : '阶段与截止总结';
    add('总结负责', work.discussion.summary_author, {id: work.discussion.summary_author_id, note: recapNote, empty: '参与后确定；管理员可代为总结'});
  } else {
    if (plan?.collaboration === 'hosted' || work.host_id || work.host) {
      add('负责人', work.host, {id: work.host_id, note: '主持', empty: '主持待指定'});
    }
    if (task.claimed_by) {
      add('负责人', task.claimed_by, {note: '认领'});
    } else if (plan?.collaboration !== 'hosted' && !work.host_id && task.status === 'open') {
      add('负责人', '', {empty: '待认领'});
    }
  }

  // 3. 主要作者 / 成果提交者
  const outcome = work.outcomes?.[0];
  if (work.report_author || work.report_author_id || plan?.delivery?.author_id || plan?.delivery?.format === 'web_report') {
    add('主要作者', work.report_author, {id: work.report_author_id || plan?.delivery?.author_id, empty: plan?.delivery?.format === 'web_report' ? '未指定' : ''});
  }
  if (outcome) add('主要作者', outcome.author, {id: outcome.author_id, note: '已交成果'});

  // 4. 独立核查者（含当前版 / 历史版与问题确认）
  const current = work.current_reviews || [];
  for (const review of current) add('独立核查', review.reviewer, {id: review.reviewer_id, note: '当前版本'});
  for (const review of work.reviews || []) {
    if (current.some(row => review.reviewer_id && row.reviewer_id ? review.reviewer_id === row.reviewer_id : review.reviewer === row.reviewer)) continue;
    add('独立核查', review.reviewer, {id: review.reviewer_id, note: '历史核查'});
  }
  for (const issue of work.issues || []) {
    if (issue.resolver) add('独立核查', issue.resolver, {id: issue.resolver_id, note: '确认问题'});
  }

  // 5. 子任务分工（仅当有未退出的子任务时显示）
  for (const subtask of work.subtasks || []) {
    if (subtask.state === 'declined') continue;
    add('子任务分工', subtask.assignee, {id: subtask.assignee_id, note: `${subtask.title || `子任务 #${subtask.id}`} · ${SUBTASK_STATES[subtask.state] || subtask.state}`});
  }

  // 6. 讨论与反馈（合并讨论、问题、旧质疑与补充）
  for (const row of data.debate || []) add('讨论参与', row.agent, {note: row.stance?.replace('反駁', '反驳').replace('補充', '补充')});
  for (const issue of work.issues || []) {
    if (!issue.challenge_id && (issue.author_id || issue.author !== '历史记录')) add('讨论参与', issue.author, {id: issue.author_id, note: '提出问题'});
  }
  for (const row of data.challenges || []) add('讨论参与', row.agent, {note: '质疑'});
  for (const row of data.supplements || []) add('讨论参与', row.agent, {note: '补充'});

  const root = node('section', null, 'work-section task-roles');
  const heading = node('h4', '参与角色');
  root.setAttribute('aria-label', '任务参与角色');
  root.append(heading);
  if (!roles.size) {root.append(node('p', '尚无参与记录。', 'muted')); return root;}
  const list = node('dl', null, 'task-role-list');
  for (const [role, {members, empty}] of roles) {
    const row = node('div', null, 'task-role-row');
    const value = node('dd');
    row.append(node('dt', role), value);
    if (!members.length) value.append(node('span', empty, 'muted'));
    else {
      const people = node('ul', null, 'task-role-members');
      for (const person of members) {
        const member = node('li', null, 'task-role-member');
        const nameEl = renderAgentName
          ? renderAgentName(person.name, { id: person.id, className: 'task-role-name' })
          : node('span', person.name, 'task-role-name');
        member.append(nameEl);
        if (person.notes.size) member.append(node('small', [...person.notes].join('、'), 'muted'));
        people.append(member);
      }
      value.append(people);
    }
    list.append(row);
  }
  root.append(list);
  return root;
}
