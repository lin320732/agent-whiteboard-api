import { readBatch } from './collaboration.js';
import { CONTENT_WHITESPACE } from './active-debate.js';

function byTask(rows, key = 'task_id') {
  const grouped = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return id => grouped.get(id) || [];
}

// Read the selected tasks and their summary dependencies in one D1 transaction.
// The number of queries and network round trips does not grow with task count.
// scope and args come from the same parameterized filters as the normal list.
export async function readTaskSummaryData(db, scope, args, at) {
  const selected = `task_id IN (${scope})`;
  const latestOutcome = '(SELECT id FROM work_outcomes WHERE task_id=t.id ORDER BY id DESC LIMIT 1)';
  const queries = [
    [`SELECT * FROM tasks WHERE id IN (${scope}) ORDER BY id DESC`, ...args],
    ['SELECT p.id,p.name AS actor,COALESCE(l.display_name,p.name) AS name,p.active,p.kind,l.display_name FROM principals p LEFT JOIN principal_labels l ON l.principal_id=p.id'],
    [`SELECT id,task_id,agent FROM challenges WHERE ${selected} ORDER BY id`, ...args],
    [`SELECT task_id,agent,links FROM supplements WHERE ${selected} ORDER BY id`, ...args],
    [`SELECT DISTINCT d.task_id,d.agent,d.role,d.stance FROM debate_messages d JOIN tasks t ON t.id=d.task_id
      WHERE d.${selected} AND COALESCE(t.type,'')<>'active_debate' AND t.status NOT IN ('done','closed') ORDER BY d.id`, ...args],
    [`SELECT task_id,agent FROM events WHERE ${selected} AND type IN ('claim','result','challenge','supplement')`, ...args],
    [`SELECT * FROM task_workflows WHERE ${selected}`, ...args],
    [`SELECT * FROM work_issues WHERE ${selected} ORDER BY id`, ...args],
    [`SELECT task_id,state FROM work_subtasks WHERE ${selected}`, ...args],
    [`SELECT o.* FROM tasks t JOIN work_outcomes o ON o.id=${latestOutcome} WHERE t.id IN (${scope}) ORDER BY o.id DESC`, ...args],
    [`SELECT r.*,COALESCE(l.display_name,p.name) AS reviewer FROM work_reviews r
      JOIN principals p ON p.id=r.reviewer_id LEFT JOIN principal_labels l ON l.principal_id=p.id
      WHERE r.${selected} ORDER BY r.id DESC`, ...args],
    [`SELECT d.*,t.id AS summary_task_id FROM tasks t JOIN work_deliveries d ON d.outcome_id=${latestOutcome}
      WHERE t.id IN (${scope})`, ...args],
    [`SELECT * FROM task_plans WHERE ${selected}`, ...args],
    [`SELECT d.task_id,d.id,d.agent,d.role,d.stance,d.reply_to,d.created_at,TRIM(d.content,?)<>'' AS has_content,a.author_id
      FROM tasks t JOIN task_plans p ON p.task_id=t.id AND p.goal='active_debate'
      JOIN debate_messages d ON d.task_id=t.id LEFT JOIN active_debate_messages a ON a.message_id=d.id
      WHERE t.id IN (${scope}) AND t.status NOT IN ('done','closed','proposed')
        AND julianday(json_extract(p.schedule_json,'$.end_at'))<=julianday(?) ORDER BY d.id`,
      CONTENT_WHITESPACE, ...args, new Date(at).toISOString()],
    ['SELECT revision FROM board_task_revision WHERE id=1'],
  ];
  const [tasks, people, challenges, supplements, debate, events, profiles, issues, subtasks, outcomes, reviews, deliveries, plans, discussion, revision] = await readBatch(db, queries);
  const groups = [challenges, supplements, debate, events, profiles, issues, subtasks, outcomes, reviews, plans, discussion].map(rows => byTask(rows));
  const deliveryRows = byTask(deliveries, 'summary_task_id');
  const contexts = new Map(), workflows = new Map();
  for (const task of tasks) {
    const [taskChallenges, taskSupplements, taskDebate, taskEvents, taskProfiles, taskIssues, taskSubtasks, taskOutcomes, taskReviews, taskPlans, taskDiscussion] = groups.map(rows => rows(task.id));
    contexts.set(task.id, { task, challenges: taskChallenges, supplements: taskSupplements, debate: taskDebate, eventAgents: taskEvents.map(row => row.agent), forceApprovals: [] });
    workflows.set(task.id, {
      rows: [taskProfiles, taskIssues, taskSubtasks, taskOutcomes, taskReviews, deliveryRows(task.id)],
      planRow: taskPlans[0] || null,
      discussionMessages: taskDiscussion,
    });
  }
  return { tasks, people, contexts, workflows, revision: revision[0]?.revision };
}
