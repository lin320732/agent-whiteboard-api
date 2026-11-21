// 任务全站行内引用与引用阅读窗口（支持发言 #387、问题 #12、成果 #5、子任务 #3）：
// - 桌面端悬停/聚焦显示富文本 Markdown 预览浮卡（附「打开窗口」与「定位原处」）；
// - 点击任意引用（行内编号、回复引用条、速查条「查看原文」）原地打开「引用详情窗口」，
//   完整渲染 Markdown / 多媒体 / 来源链接 / 上下文回复，并支持在窗口内多级钻取与返回，
//   随时可一键定位到原楼层并显示「返回刚才位置」浮钮，不打断阅读节奏。

const REF_PATTERN = /(?:(问题|問題|issue|成果|outcome|子任务|子任務|subtask|发言|發言|楼层|樓層|debate)\s*)?#(\d{1,7})(?!\d)/gi;
const SKIP_TAGS = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'SUMMARY', 'BUTTON', 'INPUT', 'SELECT']);
const SKIP_CLASSES = ['reply-reference', 'source-fold', 'conversation-header', 'recap-ref-glossary', 'floor-popover-head', 'floor-modal-head'];

const ISSUE_STATE_LABEL = { open: '待回应', responded: '待确认解决', disputed: '待用户裁决', resolved: '已解决' };
const SUBTASK_STATE_LABEL = { assigned: '等待接单', accepted: '已接单', declined: '已退出', waiting: '等待事件', submitted: '待独立核查', done: '已完成' };

export function normalizeStanceLabel(stance) {
  const s = String(stance || '').trim();
  if (s === '反駁') return '反驳';
  if (s === '補充') return '补充';
  return s;
}

export function stanceTagClass(stance) {
  const s = normalizeStanceLabel(stance);
  if (s === '阶段总结') return 'recap';
  if (s === '支持') return 'stance-support';
  if (s === '反驳') return 'stance-rebut';
  if (s === '补充') return 'stance-supplement';
  return 'debate';
}

function compactMarkdown(text, maxChars = 320) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [代码块] ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt) => (alt ? `[媒体: ${alt}]` : '[媒体]'))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*>\s*\[![A-Za-z\u4e00-\u9fff]+\]\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('').trimEnd() + '…' : cleaned;
}

function formatTime(value) {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function compactFloorPreview(text, maxChars = 140) {
  return compactMarkdown(text, maxChars);
}

export function extractFloorRefIds(text, byId) {
  if (!byId || !byId.size) return [];
  const prose = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/https?:\/\/[^\s"'<>)]+/gi, ' ');
  const ids = [];
  const seen = new Set();
  const pattern = /(^|[^0-9A-Za-z_#])#(\d{1,7})(?![0-9A-Za-z_])/g;
  let match;
  while ((match = pattern.exec(prose)) !== null) {
    const id = Number(match[2]);
    if (!seen.has(id) && byId.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function isTouchMode(event) {
  if (event?.pointerType === 'touch') return true;
  if (typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
  return false;
}

function prefixToKind(prefix) {
  const p = String(prefix || '').trim().toLowerCase();
  if (!p) return 'debate';
  if (['问题', '問題', 'issue'].includes(p)) return 'issue';
  if (['成果', 'outcome'].includes(p)) return 'outcome';
  if (['子任务', '子任務', 'subtask'].includes(p)) return 'subtask';
  return 'debate';
}

function recordLabel(kind, id) {
  if (kind === 'issue') return `问题 #${id}`;
  if (kind === 'outcome') return `成果 #${id}`;
  if (kind === 'subtask') return `子任务 #${id}`;
  return `发言 #${id}`;
}

function syncBodyModalClass() {
  const anyOpen = ['filePreviewModal', 'agentDetailModal', 'floorRefModal'].some(id => {
    const el = document.getElementById(id);
    return el && !el.hidden;
  });
  document.body.classList.toggle('has-modal', anyOpen);
}

export function createFloorRefsUI({ node, flash, renderMarkdown = null, renderSources = null, renderAgentName = null }) {
  const agentName = (name, opts = {}) => renderAgentName ? renderAgentName(name, opts) : node(opts.tag || 'strong', name, opts.className || '');

  let popover = null;
  let modal = null;
  let returnPill = null;
  let hideTimer = null;
  let returnTimer = null;
  let currentAnchor = null;
  let modalStack = [];
  let modalTriggerEl = null;
  let lastPointerType = 'mouse';

  // Active task context maps
  let debateById = new Map();
  let repliesByParent = new Map();
  let issueById = new Map();
  let outcomeById = new Map();
  let subtaskById = new Map();
  let activeHandlers = {};

  function setContext(data, handlers = {}) {
    debateById = new Map();
    repliesByParent = new Map();
    issueById = new Map();
    outcomeById = new Map();
    subtaskById = new Map();
    activeHandlers = handlers || {};

    for (const item of data?.debate || []) {
      const id = Number(item?.id);
      if (Number.isSafeInteger(id) && id > 0) {
        debateById.set(id, item);
        const parentId = Number(item.reply_to);
        if (Number.isSafeInteger(parentId) && parentId > 0) {
          if (!repliesByParent.has(parentId)) repliesByParent.set(parentId, []);
          repliesByParent.get(parentId).push(item);
        }
      }
    }
    for (const item of data?.workflow?.issues || []) {
      const id = Number(item?.id);
      if (Number.isSafeInteger(id) && id > 0) issueById.set(id, item);
    }
    const outcomes = data?.workflow?.outcomes || [];
    outcomes.forEach((item, index) => {
      const id = Number(item?.id);
      if (Number.isSafeInteger(id) && id > 0) {
        outcomeById.set(id, { ...item, versionNumber: outcomes.length - index, isLatest: index === 0 });
      }
    });
    for (const item of data?.workflow?.subtasks || []) {
      const id = Number(item?.id);
      if (Number.isSafeInteger(id) && id > 0) subtaskById.set(id, item);
    }
  }

  function lookup(kind, id) {
    if (kind === 'issue') return issueById.get(id) || null;
    if (kind === 'outcome') return outcomeById.get(id) || null;
    if (kind === 'subtask') return subtaskById.get(id) || null;
    return debateById.get(id) || null;
  }

  function renderRichContent(markdownText, className = '') {
    if (typeof renderMarkdown === 'function') return renderMarkdown(markdownText || '', className);
    return node('div', compactMarkdown(markdownText, 1200), className);
  }

  function ensurePopover() {
    if (popover) return popover;
    popover = node('div', null, 'floor-popover');
    popover.id = 'floorRefPopover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', '引用内容预览');
    popover.hidden = true;
    popover.addEventListener('pointerenter', () => {
      clearTimeout(hideTimer);
    });
    popover.addEventListener('pointerleave', event => {
      if (event.pointerType === 'touch') return;
      scheduleHide();
    });
    document.body.append(popover);

    document.addEventListener('pointerdown', event => {
      lastPointerType = event.pointerType || 'mouse';
      if (popover.hidden) return;
      if (popover.contains(event.target)) return;
      if (event.target.closest?.('.inline-floor-ref')) return;
      hidePopover();
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (modal && !modal.hidden) {
          event.stopPropagation();
          closeModal();
        } else if (popover && !popover.hidden) {
          hidePopover();
        }
      }
    });
    window.addEventListener('resize', () => {
      if (popover && !popover.hidden && currentAnchor?.isConnected) positionPopover(currentAnchor);
    });
    return popover;
  }

  function ensureModal() {
    if (modal) return modal;
    modal = node('div', null, 'floor-modal');
    modal.id = 'floorRefModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'floorRefModalTitle');
    modal.hidden = true;
    modal.addEventListener('click', event => {
      if (event.target === modal) closeModal();
    });
    document.body.append(modal);
    return modal;
  }

  function ensureReturnPill() {
    if (returnPill) return returnPill;
    returnPill = node('div', null, 'floor-return-pill');
    returnPill.id = 'floorReturnPill';
    returnPill.setAttribute('role', 'status');
    returnPill.hidden = true;
    document.body.append(returnPill);
    return returnPill;
  }

  function hidePopover() {
    clearTimeout(hideTimer);
    currentAnchor = null;
    if (popover) {
      popover.hidden = true;
      popover.replaceChildren();
    }
  }

  function scheduleHide(delay = 180) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hidePopover(), delay);
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.replaceChildren();
    modalStack = [];
    syncBodyModalClass();
    if (modalTriggerEl?.isConnected && typeof modalTriggerEl.focus === 'function') {
      try { modalTriggerEl.focus({ preventScroll: true }); } catch { /* ignore focus errors */ }
    }
    modalTriggerEl = null;
  }

  function hideReturnPill() {
    clearTimeout(returnTimer);
    if (returnPill) {
      returnPill.hidden = true;
      returnPill.replaceChildren();
    }
  }

  function showReturnPill(origin) {
    const pill = ensureReturnPill();
    clearTimeout(returnTimer);
    const tabLabels = { overview: '概览', outcome: '成果', review: '核查', conversation: '讨论' };
    const label = origin.floorId
      ? `← 返回发言 #${origin.floorId}`
      : origin.tabKey && origin.tabKey !== origin.targetTabKey
        ? `← 返回${tabLabels[origin.tabKey] || '刚才'}页`
        : '← 返回刚才位置';
    const backBtn = node('button', label, 'floor-return-btn');
    backBtn.type = 'button';
    backBtn.addEventListener('click', () => {
      hideReturnPill();
      if (origin.tabKey && typeof activeHandlers.selectTab === 'function') {
        activeHandlers.selectTab(origin.tabKey);
      }
      const targetEl = origin.floorId ? document.getElementById(`debate-${origin.floorId}`) : null;
      if (targetEl && targetEl.isConnected) {
        flash(targetEl);
      } else {
        if (origin.container?.isConnected) origin.container.scrollTop = origin.containerScroll;
        if (origin.winY > 0) window.scrollTo(0, origin.winY);
      }
    });
    const closeBtn = node('button', '×', 'floor-return-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭返回提示');
    closeBtn.addEventListener('click', hideReturnPill);
    pill.replaceChildren(backBtn, closeBtn);
    pill.hidden = false;
    returnTimer = setTimeout(hideReturnPill, 14000);
  }

  function captureOrigin(sourceEl, targetKind, targetId) {
    const sourceMsg = sourceEl?.closest?.('[data-debate-id]');
    const sourceFloorId = sourceMsg?.dataset?.debateId ? Number(sourceMsg.dataset.debateId) : null;
    const container = document.getElementById('taskDetail')?.parentElement || null;
    const tabKey = typeof activeHandlers.currentTab === 'function' ? activeHandlers.currentTab() : null;
    const targetTabKey = targetKind === 'debate' ? 'conversation' : targetKind === 'issue' ? 'review' : targetKind === 'outcome' ? 'outcome' : 'overview';
    return {
      floorId: sourceFloorId && !(targetKind === 'debate' && sourceFloorId === targetId) ? sourceFloorId : null,
      tabKey,
      targetTabKey,
      container,
      containerScroll: container ? container.scrollTop : 0,
      winY: window.scrollY,
    };
  }

  function performJump(id, sourceEl, kind = 'debate') {
    hidePopover();
    const origin = captureOrigin(sourceEl || modalTriggerEl, kind, id);
    closeModal();
    if (kind === 'debate') {
      if (typeof activeHandlers.onJumpFloor === 'function') activeHandlers.onJumpFloor(id);
      else {
        const targetEl = document.getElementById(`debate-${id}`);
        if (targetEl) flash(targetEl);
      }
    } else if (kind === 'issue') {
      activeHandlers.onJumpIssue?.(id);
    } else if (kind === 'outcome') {
      activeHandlers.onJumpOutcome?.(id);
    } else if (kind === 'subtask') {
      activeHandlers.onJumpSubtask?.(id);
    }
    showReturnPill(origin);
  }

  function buildMetaBadges(kind, id, item) {
    const meta = node('div', null, 'floor-popover-meta');
    meta.append(node('span', recordLabel(kind, id), 'record-id'));
    if (kind === 'debate') {
      meta.append(
        agentName(String(item.agent || '未知作者'), { role: item.role, className: 'floor-popover-author', tag: 'strong' }),
        node('span', item.role === 'human' ? '成员' : 'Agent', 'conversation-role'),
      );
      const stance = normalizeStanceLabel(item.stance);
      if (stance) meta.append(node('span', stance, `conversation-tag ${stanceTagClass(stance)}`));
      const timeStr = formatTime(item.created_at);
      if (timeStr) meta.append(node('time', timeStr, 'floor-popover-time'));
    } else if (kind === 'issue') {
      meta.append(
        node('span', item.severity === 'blocking' ? '重要问题' : '改进建议', `conversation-tag ${item.severity === 'blocking' ? 'stance-rebut' : 'stance-supplement'}`),
        node('span', ISSUE_STATE_LABEL[item.state] || item.state || '', 'chip'),
        agentName(String(item.author || '未知作者'), { id: item.author_id, className: 'floor-popover-author', tag: 'strong' }),
      );
      const timeStr = formatTime(item.created_at);
      if (timeStr) meta.append(node('time', timeStr, 'floor-popover-time'));
    } else if (kind === 'outcome') {
      if (item.versionNumber) meta.append(node('span', item.isLatest ? `第 ${item.versionNumber} 版 · 当前` : `第 ${item.versionNumber} 版`, `chip${item.isLatest ? ' version-latest-chip' : ''}`));
      meta.append(agentName(String(item.author || '未知作者'), { id: item.author_id, className: 'floor-popover-author', tag: 'strong' }));
      const timeStr = formatTime(item.created_at);
      if (timeStr) meta.append(node('time', timeStr, 'floor-popover-time'));
    } else if (kind === 'subtask') {
      meta.append(
        node('span', SUBTASK_STATE_LABEL[item.state] || item.state || '', 'chip'),
        agentName(String(item.assignee || '未指派'), { id: item.assignee_id, className: 'floor-popover-author', tag: 'strong' }),
      );
    }
    return meta;
  }

  function renderModalContent(entry) {
    const { kind, id } = entry;
    const item = lookup(kind, id);
    if (!item) return;

    const modalEl = ensureModal();
    const dialog = node('div', null, 'floor-modal-dialog');

    const head = node('header', null, 'floor-modal-head');
    const headLeft = node('div', null, 'floor-modal-head-left');
    if (modalStack.length > 1) {
      const prev = modalStack[modalStack.length - 2];
      const backBtn = node('button', `← 返回 ${recordLabel(prev.kind, prev.id)}`, 'text-button floor-modal-back');
      backBtn.type = 'button';
      backBtn.addEventListener('click', () => {
        modalStack.pop();
        renderModalContent(modalStack[modalStack.length - 1]);
      });
      headLeft.append(backBtn);
    }
    const titleEl = node('h3', kind === 'subtask' && item.title ? `${recordLabel(kind, id)} · ${item.title}` : `引用内容 · ${recordLabel(kind, id)}`, 'floor-modal-title');
    titleEl.id = 'floorRefModalTitle';
    headLeft.append(titleEl, buildMetaBadges(kind, id, item));

    const closeBtn = node('button', '×', 'floor-modal-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭引用窗口');
    closeBtn.addEventListener('click', closeModal);
    head.append(headLeft, closeBtn);

    const body = node('div', null, 'floor-modal-body');

    if (kind === 'debate') {
      const parentId = Number(item.reply_to);
      if (Number.isSafeInteger(parentId) && parentId > 0) {
        const parent = debateById.get(parentId);
        const parentStrip = node(parent ? 'button' : 'div', null, `floor-modal-context${parent ? ' is-clickable' : ''}`);
        if (parent) {
          parentStrip.type = 'button';
          parentStrip.append(
            node('span', `↳ 回复 ${parent.agent || '未知作者'} · 发言 #${parentId}`, 'floor-modal-context-label'),
            node('span', compactFloorPreview(parent.content, 110), 'floor-modal-context-text'),
          );
          parentStrip.addEventListener('click', () => openModal(parentId, modalTriggerEl, 'debate', true));
        } else {
          parentStrip.append(node('span', `↳ 回复 发言 #${parentId}（原发言不可见）`, 'muted'));
        }
        body.append(parentStrip);
      }

      const contentEl = renderRichContent(item.content, 'floor-modal-markdown');
      body.append(contentEl);

      if (item.links && typeof renderSources === 'function') {
        const src = renderSources(item.links, { label: '证据与来源' });
        if (src) {
          src.open = true;
          body.append(src);
        }
      }

      const replies = repliesByParent.get(id) || [];
      if (replies.length) {
        const replySec = node('section', null, 'floor-modal-replies');
        replySec.append(node('p', `💬 收到 ${replies.length} 条直接回复`, 'floor-modal-section-title'));
        const list = node('div', null, 'floor-modal-reply-list');
        for (const r of replies) {
          const btn = node('button', null, 'floor-modal-reply-chip');
          btn.type = 'button';
          const st = normalizeStanceLabel(r.stance);
          btn.append(
            node('span', `#${r.id}`, 'record-id'),
            node('strong', String(r.agent || '未知作者')),
            ...(st ? [node('span', st, `conversation-tag ${stanceTagClass(st)}`)] : []),
            node('span', compactFloorPreview(r.content, 84), 'floor-modal-reply-snippet'),
          );
          btn.addEventListener('click', () => openModal(Number(r.id), modalTriggerEl, 'debate', true));
          list.append(btn);
        }
        replySec.append(list);
        body.append(replySec);
      }
    } else if (kind === 'issue') {
      if (item.outcome_id && outcomeById.has(Number(item.outcome_id))) {
        const targetBtn = node('button', `针对 成果 #${item.outcome_id}（点击查看该版成果）`, 'text-button floor-modal-sublink');
        targetBtn.type = 'button';
        targetBtn.addEventListener('click', () => openModal(Number(item.outcome_id), modalTriggerEl, 'outcome', true));
        body.append(targetBtn);
      }
      body.append(renderRichContent(item.text, 'floor-modal-markdown'));
      if (item.response) {
        const respBox = node('section', null, 'floor-modal-subsection');
        respBox.append(node('p', `回应${item.responder ? ` · ${item.responder}` : ''}`, 'floor-modal-section-title'));
        respBox.append(renderRichContent(item.response, 'floor-modal-markdown'));
        if (item.evidence && typeof renderSources === 'function') {
          const src = renderSources(item.evidence, { label: '修正依据' });
          if (src) { src.open = true; respBox.append(src); }
        }
        body.append(respBox);
      }
      if (item.resolution) {
        const resBox = node('section', null, 'floor-modal-subsection');
        resBox.append(node('p', `确认说明${item.resolver ? ` · ${item.resolver}` : ''}`, 'floor-modal-section-title'));
        resBox.append(renderRichContent(item.resolution, 'floor-modal-markdown'));
        body.append(resBox);
      }
    } else if (kind === 'outcome') {
      if (item.changes) {
        const chg = node('div', null, 'floor-modal-context');
        chg.append(node('span', '本次修改', 'floor-modal-context-label'), node('span', compactFloorPreview(item.changes, 180), 'floor-modal-context-text'));
        body.append(chg);
      }
      body.append(renderRichContent(item.summary || '（本次成果未填写文字总结）', 'floor-modal-markdown'));
      if (item.links && typeof renderSources === 'function') {
        const src = renderSources(item.links, { label: '来源链接', exclude: [item.report?.url] });
        if (src) { src.open = true; body.append(src); }
      }
    } else if (kind === 'subtask') {
      if (item.deliverable) {
        const del = node('section', null, 'floor-modal-subsection');
        del.append(node('p', '交付要求', 'floor-modal-section-title'), renderRichContent(item.deliverable, 'floor-modal-markdown'));
        body.append(del);
      }
      if (item.summary) {
        const sum = node('section', null, 'floor-modal-subsection');
        sum.append(node('p', '子任务成果', 'floor-modal-section-title'), renderRichContent(item.summary, 'floor-modal-markdown'));
        if (item.links && typeof renderSources === 'function') {
          const src = renderSources(item.links, { label: '来源链接' });
          if (src) { src.open = true; sum.append(src); }
        }
        body.append(sum);
      }
    }

    // Decorate nested references inside the modal so users can drill down seamlessly.
    decorate(body);

    const foot = node('footer', null, 'floor-modal-foot');
    foot.append(node('span', '按 ESC 或点空白处关闭，不会打断当前阅读位置', 'muted floor-popover-hint'));
    const actions = node('div', null, 'floor-modal-actions');
    const jumpLabel = kind === 'debate'
      ? `定位到原楼层 #${id} →`
      : kind === 'issue'
        ? '前往核查页 →'
        : kind === 'outcome'
          ? '前往成果页 →'
          : '前往概览 →';
    const jumpBtn = node('button', jumpLabel, 'secondary floor-modal-jump');
    jumpBtn.type = 'button';
    jumpBtn.addEventListener('click', () => performJump(id, modalTriggerEl, kind));
    const closeFootBtn = node('button', '关闭', 'ghost-button');
    closeFootBtn.type = 'button';
    closeFootBtn.addEventListener('click', closeModal);
    actions.append(jumpBtn, closeFootBtn);
    foot.append(actions);

    dialog.append(head, body, foot);
    modalEl.replaceChildren(dialog);
    modalEl.hidden = false;
    syncBodyModalClass();
    closeBtn.focus();
  }

  function openModal(id, anchorEl = null, kind = 'debate', pushHistory = false) {
    const numId = Number(id);
    if (!lookup(kind, numId)) return false;
    hidePopover();
    if (!pushHistory) {
      modalStack = [{ kind, id: numId }];
      modalTriggerEl = anchorEl || document.activeElement;
    } else {
      const top = modalStack[modalStack.length - 1];
      if (!top || top.kind !== kind || top.id !== numId) modalStack.push({ kind, id: numId });
    }
    renderModalContent(modalStack[modalStack.length - 1]);
    return true;
  }

  function positionPopover(anchor) {
    if (!popover || popover.hidden) return;
    const compactMobile = window.innerWidth <= 640 && isTouchMode({ pointerType: lastPointerType });
    popover.classList.toggle('is-sheet', compactMobile);
    if (compactMobile) {
      popover.style.left = '';
      popover.style.top = '';
      return;
    }
    const margin = 12;
    const rect = anchor.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(window.innerWidth - popRect.width - margin, left));
    let top = rect.top - popRect.height - 10;
    if (top < margin) top = rect.bottom + 10;
    if (top + popRect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - popRect.height - margin);
    }
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function showPopover(anchor, id, kind = 'debate') {
    const item = lookup(kind, id);
    if (!item) return;
    clearTimeout(hideTimer);
    const pop = ensurePopover();
    currentAnchor = anchor;

    const head = node('div', null, 'floor-popover-head');
    const closeBtn = node('button', '×', 'floor-popover-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭预览');
    closeBtn.addEventListener('click', hidePopover);
    head.append(buildMetaBadges(kind, id, item), closeBtn);

    const rawText = kind === 'debate'
      ? item.content
      : kind === 'issue'
        ? item.text
        : kind === 'outcome'
          ? item.summary
          : (item.summary || item.deliverable || item.title || '');
    const body = node('div', null, 'floor-popover-body');
    body.append(renderRichContent(rawText, 'floor-popover-markdown'));

    const foot = node('div', null, 'floor-popover-foot');
    const openBtn = node('button', '打开完整窗口', 'text-button floor-popover-open');
    openBtn.type = 'button';
    openBtn.addEventListener('click', () => openModal(id, anchor, kind, false));
    const jumpBtn = node('button', kind === 'debate' ? `跳转到 #${id} →` : `前往查看 →`, 'text-button floor-popover-jump');
    jumpBtn.type = 'button';
    jumpBtn.addEventListener('click', () => performJump(id, anchor, kind));
    const footActions = node('div', null, 'floor-popover-actions');
    footActions.append(openBtn, jumpBtn);
    foot.append(node('span', '点击编号可展开完整引用', 'muted floor-popover-hint'), footActions);

    pop.replaceChildren(head, body, foot);
    pop.hidden = false;
    positionPopover(anchor);
  }

  function decorate(container, byId = null, { onJump } = {}) {
    if (byId instanceof Map && byId.size) {
      debateById = byId;
    }
    if (typeof onJump === 'function') {
      activeHandlers = { ...activeHandlers, onJumpFloor: onJump };
    }
    if (!container || (!debateById.size && !issueById.size && !outcomeById.size && !subtaskById.size)) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const targets = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (!current.nodeValue || !current.nodeValue.includes('#')) continue;
      let parent = current.parentElement;
      let skip = false;
      while (parent && parent !== container) {
        if (SKIP_TAGS.has(parent.tagName) || SKIP_CLASSES.some(cls => parent.classList.contains(cls))) {
          skip = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!skip) targets.push(current);
    }

    for (const textNode of targets) {
      const text = textNode.nodeValue;
      REF_PATTERN.lastIndex = 0;
      const matches = [];
      for (let match = REF_PATTERN.exec(text); match; match = REF_PATTERN.exec(text)) {
        const start = match.index;
        const end = start + match[0].length;
        const prev = start > 0 ? text[start - 1] : '';
        const next = end < text.length ? text[end] : '';
        if (/[A-Za-z0-9_]/.test(prev) || /[A-Za-z0-9_]/.test(next)) continue;
        const kind = prefixToKind(match[1]);
        const id = Number(match[2]);
        if (!lookup(kind, id)) continue;
        matches.push({ start, end, kind, id, raw: match[0] });
      }
      if (!matches.length) continue;

      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const m of matches) {
        if (m.start > cursor) frag.append(document.createTextNode(text.slice(cursor, m.start)));
        const item = lookup(m.kind, m.id);
        const link = node('a', m.raw, `inline-floor-ref is-${m.kind}`);
        link.href = m.kind === 'debate' ? `#debate-${m.id}` : `#${m.kind}-${m.id}`;
        link.dataset.floorId = String(m.id);
        link.dataset.refKind = m.kind;
        const who = item?.agent || item?.author || item?.assignee || '';
        link.setAttribute('aria-label', `打开窗口查看${who ? ` ${who} 的` : ''}${recordLabel(m.kind, m.id)}`);
        link.addEventListener('pointerenter', event => {
          lastPointerType = event.pointerType || 'mouse';
          if (event.pointerType === 'touch') return;
          if (modal && !modal.hidden) return;
          showPopover(link, m.id, m.kind);
        });
        link.addEventListener('pointerleave', event => {
          if (event.pointerType === 'touch') return;
          scheduleHide();
        });
        link.addEventListener('focus', () => {
          if (lastPointerType !== 'touch' && (!modal || modal.hidden)) showPopover(link, m.id, m.kind);
        });
        link.addEventListener('blur', () => {
          scheduleHide(200);
        });
        link.addEventListener('click', event => {
          event.preventDefault();
          const insideModal = Boolean(link.closest('#floorRefModal'));
          openModal(m.id, link, m.kind, insideModal);
        });
        frag.append(link);
        cursor = m.end;
      }
      if (cursor < text.length) frag.append(document.createTextNode(text.slice(cursor)));
      textNode.replaceWith(frag);
    }
  }

  function reset() {
    hidePopover();
    closeModal();
    hideReturnPill();
    debateById = new Map();
    repliesByParent = new Map();
    issueById = new Map();
    outcomeById = new Map();
    subtaskById = new Map();
    activeHandlers = {};
  }

  return { setContext, decorate, open: openModal, jump: performJump, hide: hidePopover, closeModal, reset };
}
