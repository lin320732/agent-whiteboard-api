// 成果与版本历史阅读块：任务详情「成果」页签与顶层「成果」视图共用。
// 清晰区分：当前最新版本 + 结构化版本时间线 + 本任务关联的 R2 档案预览。
import { reportLink } from './task-plan-ui.js';
import { r2PreviewPath, safeHttpUrl, fileCategory, fileTypeLabel, formatBytes } from './files-ui.js';
import { extractFloorRefIds, compactFloorPreview, normalizeStanceLabel, stanceTagClass } from './floor-refs.js';

const STATUS_TEXT = { open: '待认领', in_progress: '进行中', review: '待核对', proposed: '待审批', done: '已完成', closed: '已关闭' };
const text = value => String(value ?? '').trim();

export function createOutcomeView({ node, button, linkedText, sources, api = null, openPreview = null, notify = null, openFiles = null, renderAgentName = null }) {
  const agentName = (name, opts = {}) => renderAgentName ? renderAgentName(name, opts) : node(opts.tag || 'span', name, opts.className || '');

  function formattedTime(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }

  async function copyUrl(url) {
    try {
      await navigator.clipboard.writeText(url);
      notify?.('已复制报告链接');
    } catch {
      notify?.('浏览器未允许自动复制，请手动打开链接', true);
    }
  }

  function facts(task, data) {
    const workflow = data?.workflow || null;
    const outcomes = workflow?.outcomes || [];
    const outcome = outcomes[0] || null;
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
      outcomes, outcome, report, summary, links, plan, reviewState,
      versionCount: outcomes.length,
      legacy: !outcome && !!(text(task?.result_summary) || text(task?.result_links)),
      author: outcome?.author || '',
      authorId: outcome?.author_id ?? null,
      time: outcome?.created_at || report?.published_at || '',
      blocking: workflow?.blocking || 0,
      expectsReport: plan?.delivery?.format === 'web_report',
      state: outcome ? 'outcome' : text(task?.result_summary) || text(task?.result_links) ? 'legacy' : 'empty',
    };
  }

  function renderReportBar(report, taskTitle, { compact = false } = {}) {
    const normalized = { ...report, title: text(report.title) || text(taskTitle) || '网页报告', revision: text(report.revision) || '已登记' };
    const link = reportLink(node, normalized);
    if (!link) return null;
    const wrap = node('div', null, 'report-action-group');
    const row = node('div', null, 'report-action-bar');
    row.append(link);
    const previewPath = r2PreviewPath(normalized.url);
    const safeUrl = safeHttpUrl(normalized.url);
    if (!compact && previewPath && openPreview && button) {
      row.append(button('页内预览', () => openPreview({
        title: normalized.title,
        revision: normalized.revision,
        url: safeUrl || normalized.url,
        path: previewPath,
        content_type: 'text/html',
      }), 'secondary report-preview-btn'));
    }
    if (!compact && safeUrl && notify && button) {
      row.append(button('复制链接', () => copyUrl(safeUrl), 'ghost-button report-copy-btn'));
    }
    wrap.append(row);
    if (text(report.local_path)) {
      wrap.append(node('p', `本地报告同步路径：${text(report.local_path)}`, 'muted report-local-path'));
    }
    return wrap;
  }

  function renderOutcomeRefGlossary(summaryText, debate, onJumpFloor, onOpenFloor) {
    if (!summaryText || !Array.isArray(debate) || !debate.length) return null;
    const byId = new Map(debate.filter(item => Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0).map(item => [Number(item.id), item]));
    const refIds = extractFloorRefIds(summaryText, byId);
    if (!refIds.length) return null;
    const wrap = node('div', null, 'recap-ref-glossary outcome-ref-glossary');
    wrap.setAttribute('aria-label', '文中提及的楼层内容');
    wrap.append(node('p', '文中提及的楼层内容', 'recap-ref-glossary-title'));
    const list = node('ul', null, 'recap-ref-glossary-list');
    for (const id of refIds) {
      const item = byId.get(id);
      if (!item) continue;
      const li = node('li', null, 'recap-ref-glossary-item');
      const refTag = onJumpFloor ? node('a', `#${id}`, 'recap-ref-glossary-link') : node('span', `#${id}`, 'recap-ref-glossary-link');
      if (onJumpFloor) {
        refTag.href = `#debate-${id}`;
        refTag.setAttribute('aria-label', `跳转到 ${item.agent || '未知作者'} 的发言 #${id}`);
        refTag.addEventListener('click', event => {
          event.preventDefault();
          onJumpFloor(id);
        });
      }
      const stance = normalizeStanceLabel(item.stance);
      li.append(refTag, agentName(String(item.agent || '未知作者'), { role: item.role, className: 'recap-ref-glossary-speaker', tag: 'strong' }));
      if (stance) li.append(node('span', stance, `conversation-tag ${stanceTagClass(stance)}`));
      li.append(node('span', compactFloorPreview(item.content, 110), 'recap-ref-glossary-text'));
      if (onOpenFloor) {
        const viewBtn = node('button', '展开窗口', 'text-button recap-ref-glossary-open');
        viewBtn.type = 'button';
        viewBtn.setAttribute('aria-label', `在窗口查看发言 #${id} 全文`);
        viewBtn.addEventListener('click', () => onOpenFloor(id, viewBtn));
        li.append(viewBtn);
      }
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  // 当前最新成果主卡
  function summaryBlock(task, data, { heading = '当前成果', emptyText = '还没有提交成果。', headingLevel = 'h4', compact = false, onJumpFloor = null, onOpenFloor = null } = {}) {
    const f = facts(task, data);
    const box = node('section', null, `outcome-block ${compact ? 'review-outcome' : 'current-outcome'} is-${f.state}`);
    box.dataset.outcomeState = f.state;

    const head = node('div', null, 'outcome-head');
    const headingNode = node(headingLevel === 'h4' ? 'h4' : 'h3', heading, 'outcome-heading');
    const chips = node('div', null, 'outcome-chips');
    if (f.versionCount > 1) chips.append(node('span', `最新 · 第 ${f.versionCount} 版`, 'chip version-latest-chip'));
    else if (f.outcome?.id) chips.append(node('span', `成果 #${f.outcome.id}`, 'record-id'));
    chips.append(node('span', STATUS_TEXT[task.status] || task.status || '未知状态', `badge ${task.status || 'unknown'}`));
    if (f.report) chips.append(node('span', `报告 ${text(f.report.revision) || '已登记'}`, 'chip report-chip'));
    else if (f.expectsReport) chips.append(node('span', '未登记报告', 'chip warn-chip'));
    chips.append(node('span', f.reviewState, 'chip'));
    if (f.blocking) chips.append(node('span', `${f.blocking} 项问题待解决`, 'chip warn-chip'));
    head.append(headingNode, chips);
    box.append(head);

    const metaNodes = [];
    if (f.author) {
      const span = node('span', null);
      span.append(document.createTextNode('作者 '), agentName(f.author, { id: f.authorId }));
      metaNodes.push(span);
    } else if (f.state === 'legacy' && task.claimed_by) {
      const span = node('span', null);
      span.append(document.createTextNode('提交 '), agentName(task.claimed_by));
      metaNodes.push(span);
    }
    if (f.time) metaNodes.push(document.createTextNode(`更新 ${formattedTime(f.time)}`));
    if (f.outcome?.id && f.versionCount > 1) metaNodes.push(document.createTextNode(`成果 #${f.outcome.id}`));
    if (metaNodes.length) {
      const metaEl = node('p', null, 'outcome-meta');
      metaNodes.forEach((part, idx) => {
        if (idx > 0) metaEl.append(document.createTextNode(' · '));
        metaEl.append(part);
      });
      box.append(metaEl);
    }

    if (f.summary) box.append(linkedText(f.summary, 'outcome-summary', { limit: compact ? 200 : 360 }));
    else if (f.outcome) box.append(node('p', '本次成果没有文字总结，以下链接由提交者登记。', 'muted outcome-summary-empty'));
    if (!compact && f.summary) {
      const glossary = renderOutcomeRefGlossary(f.summary, data?.debate, onJumpFloor, onOpenFloor);
      if (glossary) box.append(glossary);
    }

    if (f.report) {
      const bar = renderReportBar(f.report, task.title, { compact });
      if (bar) box.append(bar);
    }

    if (f.links && !compact) {
      const links = sources(f.links, { exclude: [f.report?.url] });
      if (links) { links.classList.add('outcome-links'); box.append(links); }
    }

    if (f.outcome?.changes && !compact) {
      // 默认展开最新版的改动说明，一眼看清这一版改了什么
      const changes = node('details', null, 'work-editor change-note');
      changes.open = true;
      changes.append(node('summary', '本次修改'), linkedText(f.outcome.changes));
      box.append(changes);
    }

    if (!f.summary && !f.links && !f.report) box.append(node('p', emptyText, 'muted outcome-empty'));
    return box;
  }

  // 结构化版本历史时间线（合并多版 outcomes + 旧版原始提交）
  function versionHistory(task, data) {
    const outcomes = data?.workflow?.outcomes || [];
    const hasOriginal = outcomes.length > 0 && !!(text(task?.result_summary) || text(task?.result_links));
    if (outcomes.length <= 1 && !hasOriginal) return null;

    const total = outcomes.length;
    const section = node('section', null, 'version-history-section');
    const head = node('div', null, 'version-history-head');
    const titleGroup = node('div', null, 'version-history-title');
    titleGroup.append(
      node('h4', '版本历史'),
      node('span', hasOriginal ? `共 ${total} 版 + 原始提交` : `共 ${total} 版`, 'count')
    );
    head.append(titleGroup);
    section.append(head);

    const timeline = node('ol', null, 'version-timeline');

    outcomes.forEach((o, index) => {
      const verNum = total - index;
      const isCurrent = index === 0;
      const item = node('li', null, `version-node${isCurrent ? ' is-current' : ''}`);
      item.id = `outcome-${o.id}`;
      const card = node('div', null, 'version-card');

      const cardHead = node('div', null, 'version-card-head');
      const badges = node('div', null, 'version-card-badges');
      badges.append(node('span', isCurrent ? `第 ${verNum} 版 · 当前` : `第 ${verNum} 版`, `chip${isCurrent ? ' version-latest-chip' : ''}`));
      if (o.report?.revision) badges.append(node('span', `报告 ${text(o.report.revision)}`, 'chip report-chip'));
      badges.append(node('span', `成果 #${o.id}`, 'record-id'));

      const metaNode = node('span', null, 'version-card-meta');
      metaNode.append(agentName(o.author || '未知作者', { id: o.author_id }));
      const stamp = formattedTime(o.created_at);
      if (stamp) metaNode.append(document.createTextNode(` · ${stamp}`));

      const headLeft = node('div', null, 'version-card-left');
      headLeft.append(badges, metaNode);
      cardHead.append(headLeft);

      if (!isCurrent && o.report) {
        const quick = node('div', null, 'version-card-actions');
        const safeUrl = safeHttpUrl(o.report.url);
        const previewPath = r2PreviewPath(o.report.url);
        if (previewPath && openPreview && button) {
          quick.append(button('预览', () => openPreview({
            title: text(o.report.title) || text(task.title) || '网页报告',
            revision: text(o.report.revision),
            url: safeUrl || o.report.url,
            path: previewPath,
            content_type: 'text/html',
          }), 'ghost-button'));
        }
        if (safeUrl) {
          const openBtn = node('a', `打开 ${text(o.report.revision) || '报告'}`, 'secondary file-open-btn');
          openBtn.href = safeUrl;
          openBtn.target = '_blank';
          openBtn.rel = 'noopener noreferrer';
          quick.append(openBtn);
        }
        if (quick.childElementCount) cardHead.append(quick);
      }

      card.append(cardHead);

      if (text(o.changes)) {
        const changeRow = node('div', null, 'version-change-line');
        changeRow.append(node('span', '改动', 'version-change-label'), linkedText(o.changes, 'version-change-text', { limit: 220 }));
        card.append(changeRow);
      }

      if (!isCurrent && text(o.report?.local_path)) {
        card.append(node('p', `本地报告路径：${text(o.report.local_path)}`, 'muted report-local-path'));
      }

      // 旧版本默认折叠摘要与来源，点击即展开查看，避免整页刷屏
      if (!isCurrent && (text(o.summary) || text(o.links))) {
        const fold = node('details', null, 'work-editor version-snapshot-fold');
        fold.dataset.disclosureKey = `version-snapshot-${o.id}`;
        fold.append(node('summary', `查看第 ${verNum} 版摘要与来源`));
        if (text(o.summary)) fold.append(linkedText(o.summary, 'version-snapshot-summary'));
        if (text(o.links)) {
          const src = sources(o.links, { exclude: [o.report?.url] });
          if (src) fold.append(src);
        }
        card.append(fold);
      }

      item.append(card);
      timeline.append(item);
    });

    if (hasOriginal) {
      const item = node('li', null, 'version-node is-legacy');
      const card = node('div', null, 'version-card');
      const cardHead = node('div', null, 'version-card-head');
      const badges = node('div', null, 'version-card-badges');
      badges.append(node('span', '原始提交', 'chip'));
      const legacyMeta = node('span', null, 'version-card-meta');
      if (task.claimed_by) legacyMeta.append(document.createTextNode('提交：'), agentName(task.claimed_by));
      else legacyMeta.textContent = '早期记录';
      badges.append(legacyMeta);
      cardHead.append(badges);
      card.append(cardHead);

      const fold = node('details', null, 'work-editor original-submission');
      fold.dataset.disclosureKey = `original-submission-${task.id}`;
      fold.append(node('summary', '原始提交与来源'));
      if (text(task.result_summary)) fold.append(linkedText(task.result_summary));
      if (text(task.result_links)) {
        const src = sources(task.result_links);
        if (src) fold.append(src);
        else fold.append(linkedText(task.result_links, 'link-list'));
      }
      card.append(fold);
      item.append(card);
      timeline.append(item);
    }

    section.append(timeline);
    return section;
  }

  // 本任务关联的 R2 档案条（静默异步载入，有档案时才显示）
  function taskFilesStrip(task) {
    if (!api || !task?.id) return null;
    const box = node('section', null, 'task-files-strip');
    box.hidden = true;
    api(`/api/files?task_id=${encodeURIComponent(task.id)}&limit=20`).then(data => {
      if (!box.isConnected) return;
      const files = data?.files || [];
      if (!files.length) return;
      box.hidden = false;
      const head = node('div', null, 'version-history-head');
      const titleGroup = node('div', null, 'version-history-title');
      titleGroup.append(node('h4', '本任务 R2 档案'), node('span', `${files.length} 个`, 'count'));
      head.append(titleGroup);
      if (openFiles && button) head.append(button('前往 R2 档案库 →', () => openFiles(), 'text-button'));

      const grid = node('div', null, 'task-files-grid');
      for (const file of files) {
        const cat = fileCategory(file.content_type, file.filename);
        const previewSrc = r2PreviewPath(file) || safeHttpUrl(file.url);
        const safeUrl = safeHttpUrl(file.url);
        const chip = node('div', null, 'task-file-item');
        if (cat === 'image' && previewSrc) {
          const img = node('img', null, 'task-file-thumb');
          img.src = previewSrc;
          img.alt = file.title || file.filename;
          img.loading = 'lazy';
          img.addEventListener('click', () => openPreview?.(file));
          chip.append(img);
        } else {
          const icon = node('span', fileTypeLabel(file.content_type, file.filename), 'badge file-type-badge task-file-badge');
          chip.append(icon);
        }
        const info = node('div', null, 'task-file-info');
        info.append(
          node('strong', file.title || file.filename),
          node('small', `${file.filename} · ${formatBytes(file.size ?? file.size_bytes)}`, 'muted')
        );
        const ops = node('div', null, 'task-file-ops');
        if (openPreview && button && (r2PreviewPath(file) || ['image', 'video', 'audio'].includes(cat))) {
          ops.append(button('预览', () => openPreview(file), 'text-button'));
        }
        if (safeUrl) {
          const a = node('a', '打开', 'text-button');
          a.href = safeUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          ops.append(a);
        }
        chip.append(info, ops);
        grid.append(chip);
      }
      box.replaceChildren(head, grid);
    }).catch(() => {});
    return box;
  }

  return { summaryBlock, versionHistory, taskFilesStrip };
}
