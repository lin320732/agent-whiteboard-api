// 成果阅读块：任务详情与「成果」视图共用。
// 只呈现服务端登记的内容：workflow.outcomes[0] + outcome.report，兼容旧任务的 result_summary/result_links。
// 来源链接不会被当作独立发布的报告；没有成果时显示空状态，不推测结论。
import {reportLink} from './task-plan-ui.js';

const STATUS_TEXT = {open: '待认领', in_progress: '进行中', review: '待核对', proposed: '待审批', done: '已完成', closed: '已关闭'};
const text = value => String(value ?? '').trim();

export function createOutcomeView({node, linkedText, sources}) {
  function formattedTime(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
  }
  function facts(task, data) {
    const workflow = data?.workflow || null;
    const outcome = workflow?.outcomes?.[0] || null;
    const report = outcome?.report || null;
    const summary = outcome ? text(outcome.summary) : text(task?.result_summary);
    const links = outcome ? text(outcome.links) : text(task?.result_links);
    const plan = workflow?.plan || data?.plan || task?.plan || null;
    const reviews = workflow?.current_reviews?.length || 0;
    let reviewState = '';
    if (!workflow?.enabled) reviewState = '按任务条件核对';
    else if (reviews) reviewState = '当前版本已独立核查';
    else if (plan?.acceptance?.independent_review) reviewState = '待独立核查';
    else reviewState = '按约定验收';
    return {
      outcome, report, summary, links, plan, reviewState,
      legacy: !outcome && !!(text(task?.result_summary) || text(task?.result_links)),
      author: outcome?.author || '',
      time: outcome?.created_at || report?.published_at || '',
      blocking: workflow?.blocking || 0,
      expectsReport: plan?.delivery?.format === 'web_report',
      state: outcome ? 'outcome' : text(task?.result_summary) || text(task?.result_links) ? 'legacy' : 'empty',
    };
  }
  // heading 由调用方决定（任务详情「当前成果」/ 成果页「成果总结」）。
  function summaryBlock(task, data, {heading = '当前成果', emptyText = '还没有提交成果。', headingLevel = 'h4', compact = false} = {}) {
    const f = facts(task, data);
    // current-outcome 是历史类名：目前成果区块仍由它承载，便于既有页面定位与样式复用。
    const box = node('section', null, `outcome-block ${compact ? 'review-outcome' : 'current-outcome'} is-${f.state}`);
    box.dataset.outcomeState = f.state;
    const head = node('div', null, 'outcome-head');
    const headingNode = node(headingLevel === 'h4' ? 'h4' : 'h3', heading, 'outcome-heading');
    const chips = node('div', null, 'outcome-chips');
    if (f.outcome?.id) chips.append(node('span', `成果 #${f.outcome.id}`, 'record-id'));
    chips.append(node('span', STATUS_TEXT[task.status] || task.status || '未知状态', `badge ${task.status || 'unknown'}`));
    if (f.report) chips.append(node('span', `报告 ${text(f.report.revision) || '已登记'}`, 'chip report-chip'));
    else if (f.expectsReport) chips.append(node('span', '未登记报告', 'chip warn-chip'));
    chips.append(node('span', f.reviewState, 'chip'));
    if (f.blocking) chips.append(node('span', `${f.blocking} 项问题待解决`, 'chip warn-chip'));
    head.append(headingNode, chips);
    box.append(head);

    const meta = [];
    if (f.author) meta.push(`作者 ${f.author}`);
    else if (f.state === 'legacy') {
      // 直接提交的结果只标注认领者，不把任务发布者当成成果作者。
      const submitter = task.claimed_by;
      if (submitter) meta.push(`提交 ${submitter}`);
    }
    if (f.time) meta.push(`更新 ${formattedTime(f.time)}`);
    if (meta.length) box.append(node('p', meta.join(' · '), 'outcome-meta'));

    if (f.summary) box.append(linkedText(f.summary, 'outcome-summary', {limit: compact ? 200 : 360}));
    else if (f.outcome) box.append(node('p', '本次成果没有文字总结，以下链接由提交者登记。', 'muted outcome-summary-empty'));

    if (f.report) {
      // 只把服务端登记的 report 当作发布报告；URL 不合法时 reportLink 返回 null，不降级成普通链接。
      const link = reportLink(node, {...f.report, title: text(f.report.title) || text(task.title) || '报告', revision: text(f.report.revision) || '已登记'});
      if (link) box.append(link);
    }
    if (f.links && !compact) {
      const links = sources(f.links, {exclude: [f.report?.url]});
      if (links) {links.classList.add('outcome-links'); box.append(links);}
    }
    if (f.outcome?.changes && !compact) {
      const changes = node('details', null, 'work-editor change-note');
      changes.append(node('summary', '本次修改'), linkedText(f.outcome.changes)); box.append(changes);
    }
    if (!f.summary && !f.links && !f.report) box.append(node('p', emptyText, 'muted outcome-empty'));
    return box;
  }
  return {summaryBlock};
}
