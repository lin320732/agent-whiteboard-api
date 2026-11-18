// 从任务当前安排和实际参与记录呈现角色，不据此推断账号权限。
const CLAIM_ROLES = { researcher: '研究员', checker: '核查员', challenger: '红队', supplementer: '补充者' };
const SUBTASK_STATES = { assigned: '待接单', accepted: '已接单', waiting: '等待事件', submitted: '待核查', done: '已完成' };

export function renderTaskRoles(data, {node, agents = []}) {
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

  add('发布者', task.created_by);
  add('提案人', task.proposed_by);
  add('主持人', work.host, {id: work.host_id, empty: plan?.collaboration === 'hosted' ? '未指定' : ''});
  if(!work.discussion) add('认领者', task.claimed_by, {note: CLAIM_ROLES[task.claimed_role] || '', empty: task.status === 'open' ? '待认领' : ''});
  else add('截止总结负责人',work.discussion.summary_author,{id:work.discussion.summary_author_id,empty:'参与后确定；管理员可代为总结'});
  add('主要作者', work.report_author, {id: work.report_author_id || plan?.delivery?.author_id, empty: plan?.delivery?.format === 'web_report' ? '未指定' : ''});
  const outcome = work.outcomes?.[0];
  if (outcome) add('成果提交者', outcome.author, {id: outcome.author_id});

  for (const subtask of work.subtasks || []) {
    if (subtask.state === 'declined') continue;
    add('子任务执行者', subtask.assignee, {id: subtask.assignee_id, note: `${subtask.title || `子任务 #${subtask.id}`} · ${SUBTASK_STATES[subtask.state] || subtask.state}`});
    add('子任务核查者', subtask.reviewer, {id: subtask.reviewer_id});
  }
  const current = work.current_reviews || [];
  for (const review of current) add('独立核查者', review.reviewer, {id: review.reviewer_id, note: '当前版本'});
  for (const review of work.reviews || []) {
    if (current.some(row => review.reviewer_id && row.reviewer_id ? review.reviewer_id === row.reviewer_id : review.reviewer === row.reviewer)) continue;
    add('独立核查者', review.reviewer, {id: review.reviewer_id, note: '历史核查记录'});
  }
  for (const row of data.challenges || []) add('质疑者', row.agent);
  for (const row of data.supplements || []) add('补充者', row.agent);
  for (const issue of work.issues || []) {
    // 旧质疑自动映射为问题，不再把同一条行动记为另一个角色。
    if (!issue.challenge_id && (issue.author_id || issue.author !== '历史记录')) add('问题提出者', issue.author, {id: issue.author_id});
    add('问题回应者', issue.responder, {id: issue.responder_id});
    add('问题确认者', issue.resolver, {id: issue.resolver_id});
  }
  for (const row of data.debate || []) add('讨论参与者', row.agent, {note: row.stance?.replace('反駁', '反驳').replace('補充', '补充')});
  for (const row of data.force_approvals || []) add('强制验收者', row.agent);

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
        member.append(node('span', person.name, 'task-role-name'));
        if (person.notes.size) member.append(node('small', [...person.notes].join('；'), 'muted'));
        people.append(member);
      }
      value.append(people);
    }
    list.append(row);
  }
  root.append(list);
  return root;
}
