// Agent 信息、管理员留言指示（完成回馈自动归档）、免费/永久额度明细与 API 扫描日志详情弹层（仅管理员可见）。

const LEVEL_META = {
  green: { label: '充足', hint: '≥ 60%', cls: 'level-green' },
  yellow: { label: '偏低', hint: '20%–59%', cls: 'level-yellow' },
  red: { label: '告急', hint: '< 20%', cls: 'level-red' },
  none: { label: '未上报', hint: '暂无额度数据', cls: 'level-none' },
};

const BASIS_LABEL = {
  reported: '按 Agent 上报总百分比',
  combined: '按免费 + 永久合并计算',
  free: '按免费额度比例计算',
  permanent: '按永久额度比例计算',
  balance: '未设总额，按余额判断',
  items: '按各明细项均值计算',
  none: '尚未上报额度',
};
const UNKNOWN_QUOTA = '额度未知';
const CHANNEL_LABEL = { none: '无读数渠道', manual: '手动读取', api: 'API 读取' };
const REASON_LABEL = {
  initial: '首次上报',
  daily: '每日心跳',
  reset: '周期重置',
  threshold: '跨额度阈值',
  change: '变动满 5 个百分点',
  channel: '读数渠道变化',
  first_permanent_use: '首次消耗永久额度',
};

export function resolveLevel(percent, explicitLevel, remaining) {
  if (percent != null && Number.isFinite(Number(percent))) {
    const p = Number(percent);
    if (p >= 60) return 'green';
    if (p >= 20) return 'yellow';
    return 'red';
  }
  if (explicitLevel && Object.hasOwn(LEVEL_META, explicitLevel) && explicitLevel !== 'none') return explicitLevel;
  if (remaining != null && Number.isFinite(Number(remaining))) return Number(remaining) > 0 ? 'green' : 'red';
  return 'none';
}

function formatNum(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(Number(value));
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Math.round(Number(value) * 10) / 10;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

function formatBeijingFull(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function formatBeijingShort(value, { includeYear = false } = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    ...(includeYear ? { year: 'numeric' } : {}),
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function formatScheduleText(value, { includeTimezone = true } = {}) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) {
    return formatBeijingShort(value, { includeYear: true }) + (includeTimezone ? '（北京时间）' : '');
  }
  return value;
}

function beijingYear(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(date);
}

function formatBeijingCompact(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const includeYear = beijingYear(new Date(value)) !== beijingYear();
  return formatBeijingShort(value, { includeYear });
}

function formatScheduleCompact(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) {
    return formatBeijingCompact(value);
  }
  const text = String(value).trim();
  const m = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:\s*(?:CST|北京时间|\(北京时间\)|（北京时间）))?$/i);
  if (m) {
    const [, y, mo, d, hm] = m;
    return y === beijingYear() ? `${mo}/${d} ${hm}` : `${y}/${mo}/${d} ${hm}`;
  }
  return text.replace(/\s*[（(]北京时间[)）]\s*$/, '');
}

function quotaIndicator(quota) {
  const useFree = formatPercent(quota?.free?.percent) != null;
  const percent = useFree ? quota.free.percent : quota?.overall_percent;
  const level = resolveLevel(percent, useFree ? quota.free.status_level : quota?.status_level, quota?.free?.remaining ?? quota?.permanent?.remaining);
  return { percent, level, scope: useFree ? 'free' : quota?.basis === 'permanent' ? 'permanent' : '' };
}

function quotaResetAt(quota) {
  return quota?.free?.reset_at || quota?.reset_at || null;
}

export function createAgentQuotasUI({ api, node, button, user, notify, openAccounts, linkedText = null, sources = null, onDirectivesChanged = null, prepareDetail = async () => {} }) {
  let latestAgents = [];
  let modalEl = null;
  let activeAgentId = null;
  let modalEpoch = 0;

  // 当前弹窗的内部状态（方便刷新、分页与草稿保留）
  let modalState = null;

  function makePill(quota, { verbose = false } = {}) {
    if (!quota) {
      const pill = node('span', null, 'agent-quota-pill level-none');
      pill.append(node('span', '', 'quota-dot level-none'), node('span', '未上报'));
      pill.title = '该 Agent 尚未通过 API 上报额度';
      return pill;
    }
    const { percent, level, scope } = quotaIndicator(quota);
    const meta = LEVEL_META[level] || LEVEL_META.none;
    const unknown = quota.basis === 'unknown';
    const pct = formatPercent(percent);
    const scopePrefix = scope === 'free' ? '免费 ' : scope === 'permanent' ? '永久 ' : '';
    const coreText = pct
      ? `${scopePrefix}${pct}`
      : (level === 'red' ? `${scopePrefix}0%` : '有余量');
    const text = unknown ? UNKNOWN_QUOTA : (verbose ? `${meta.label} · ${coreText}` : coreText);
    const pill = node('span', null, `agent-quota-pill ${meta.cls}`);
    const dot = node('span', '', `quota-dot ${meta.cls}`);
    dot.setAttribute('aria-hidden', 'true');
    pill.append(dot, node('span', text));
    const basis = BASIS_LABEL[scope || quota.basis] || '';
    pill.title = unknown ? '已收到心跳，等待额度读数' : `${meta.label}（${meta.hint}）${basis ? ` · ${basis}` : ''}`;
    return pill;
  }

  function makeDirectiveBadge(pendingCount) {
    const n = Number(pendingCount || 0);
    if (n <= 0) return null;
    const badge = node('span', `待回馈 ${n}`, 'agent-directive-badge is-pending');
    badge.title = `有 ${n} 条管理员留言指示等待该 Agent 完成并回馈`;
    return badge;
  }

  function renderInboxStatus(person, { compact = false } = {}) {
    const box = node('div', null, `agent-inbox-status${compact ? ' is-compact' : ''}`);
    const stamp = person.last_inbox_at;
    const line = node('div', null, 'agent-inbox-last');
    line.append(node('span', compact ? '取信 ' : '最近取信：'));
    const time = node('time', stamp
      ? (compact ? formatBeijingCompact(stamp) : formatBeijingFull(stamp))
      : '暂无成功取信记录');
    if (stamp) time.dateTime = stamp;
    line.append(time);
    line.title = stamp ? `最近成功取信：${formatBeijingFull(stamp)}（北京时间）；取信后仍需完成并回馈。` : '功能启用后尚未记录成功取信；普通 API 访问不计为取信。';
    box.append(line);
    const unfetched = Number(person.unfetched_directives || 0);
    if (person.active && person.inbox_overdue && unfetched > 0) {
      const minutes = Math.round(Number(person.inbox_timeout_seconds || 1800) / 60);
      const warning = node('div', `有留言超过 ${minutes} 分钟未取信`, 'agent-inbox-warning');
      warning.setAttribute('role', 'status');
      warning.title = `还有 ${unfetched} 条留言未取信，请检查该 Agent 的定时巡检。`;
      box.append(warning);
    } else if (unfetched > 0) {
      box.append(node('span', `${unfetched} 条留言等待取信`, 'agent-inbox-pending'));
    }
    return box;
  }

  function makeProgressBar(percent, level, { thin = false } = {}) {
    const track = node('div', null, `quota-bar-track${thin ? ' is-thin' : ''}`);
    const fill = node('div', null, `quota-bar-fill ${LEVEL_META[level]?.cls || 'level-none'}`);
    const width = percent != null && Number.isFinite(Number(percent))
      ? Math.max(0, Math.min(100, Number(percent)))
      : (level === 'green' ? 100 : level === 'red' ? 0 : 0);
    fill.style.width = `${width}%`;
    track.append(fill);
    return track;
  }

  function renderMiniMeters(quota) {
    const box = node('div', null, 'quota-mini-rows');
    const { percent, level, scope } = quotaIndicator(quota);
    const cls = LEVEL_META[level].cls;
    const unknown = quota?.basis === 'unknown';
    const missing = unknown ? '未知' : '未上报';
    const row = node('div', null, 'quota-mini-row is-primary');
    const line = node('div', null, 'quota-mini-line');
    const label = scope === 'free' ? '免费剩余' : scope === 'permanent' ? '永久剩余' : '额度剩余';
    line.append(node('span', label, 'quota-mini-label'), node('strong', formatPercent(percent) || missing, `quota-mini-val ${cls}`));
    row.append(line);
    if (percent != null) row.append(makeProgressBar(percent, level, { thin: true }));
    box.append(row);

    const fields = node('dl', null, 'quota-summary-fields');
    const permanent = quota?.permanent;
    const permanentValue = permanent?.remaining != null
      ? `${formatNum(permanent.remaining)} ${permanent.unit || quota.unit || 'tokens'}`
      : (formatPercent(permanent?.percent) || missing);
    const reportTime = quota?.reported_at || quota?.updated_at;
    for (const [key, title, value] of [
      ['reset', '额度重置', formatScheduleText(quotaResetAt(quota)) || missing],
      ['permanent', '永久额度', permanentValue],
      ['reported', '上报日期', reportTime ? formatBeijingShort(reportTime, { includeYear: true }) : '未上报'],
    ]) {
      const field = node('div', null, `quota-summary-field quota-summary-${key}`);
      field.append(node('dt', title), node('dd', value));
      if (key === 'reported' && reportTime) field.title = `${formatBeijingFull(reportTime)}（北京时间）`;
      fields.append(field);
    }
    box.append(fields);
    return box;
  }

  // 外层列表（成员与 Agent 页）每条 Agent 卡片中的紧凑额度摘要
  function renderCompactSummary(person, onOpenDetail) {
    const wrap = node('div', null, 'agent-quota-compact');
    const quota = person.quota || null;
    const barBtn = node('button', null, 'agent-quota-trigger');
    barBtn.type = 'button';
    barBtn.setAttribute('aria-label', `查看 ${person.name} 的信息、留言与额度明细`);
    barBtn.addEventListener('click', () => (onOpenDetail ? onOpenDetail(person) : openDetail(person)));
    barBtn.append(renderMiniMeters(quota));
    if (quota?.note) {
      const foot = node('div', null, 'quota-compact-foot');
      foot.append(node('span', quota.note, 'quota-compact-note'));
      barBtn.append(foot);
    }
    wrap.append(barBtn);
    wrap.append(renderInboxStatus(person));
    return wrap;
  }

  // 工作台底部：精简的 Agent 额度、在线与留言状态概览条（仅管理员且有 Agent 时显示）
  function renderWorkbenchOverview(agents) {
    const panel = document.getElementById('homeAgentQuotaPanel');
    const list = document.getElementById('homeAgentQuotaList');
    const countEl = document.getElementById('homeAgentQuotaCount');
    const manageBtn = document.getElementById('homeAgentQuotaManage');
    if (!panel || !list) return;
    const isAdmin = user()?.role === 'admin';
    if (!isAdmin || !Array.isArray(agents) || agents.length === 0) {
      panel.hidden = true;
      list.replaceChildren();
      return;
    }
    panel.hidden = false;
    if (countEl) countEl.textContent = `${agents.length} 位`;
    if (manageBtn) manageBtn.onclick = () => openAccounts?.();

    const cards = agents.map(person => {
      const quota = person.quota || null;
      const { percent, level, scope } = quotaIndicator(quota);
      const cls = LEVEL_META[level].cls;
      const unknown = quota?.basis === 'unknown';
      const pct = formatPercent(percent);
      const missing = unknown ? '未知' : '未上报';
      const resetRaw = quotaResetAt(quota);
      const resetText = formatScheduleCompact(resetRaw) || missing;
      const reportTime = quota?.reported_at || quota?.updated_at;
      const reportText = reportTime ? formatBeijingCompact(reportTime) : '未上报';
      const scanText = person.last_seen_at ? formatBeijingCompact(person.last_seen_at) : '';

      const card = node('button', null, `home-agent-card ${cls}${person.active ? '' : ' is-inactive'}`);
      card.type = 'button';
      card.dataset.agentId = String(person.id);
      card.setAttribute('aria-label', `查看 ${person.name} 的详情、额度与留言`);
      card.addEventListener('click', () => openDetail(person));

      const head = node('div', null, 'home-agent-head');
      const nameRow = node('div', null, 'home-agent-title-row');
      nameRow.append(node('strong', person.name));
      if (!person.active) nameRow.append(node('span', '已停用', 'badge closed'));
      const pendingBadge = makeDirectiveBadge(person.pending_directives);
      if (pendingBadge) nameRow.append(pendingBadge);
      const chevron = node('span', '›', 'home-agent-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      head.append(nameRow, chevron);
      card.append(head);

      const quotaBox = node('div', null, 'home-agent-quota');
      const quotaLine = node('div', null, 'home-agent-quota-line');
      const pctGroup = node('span', null, 'home-agent-pct-group');
      const dot = node('span', '', `quota-dot ${cls}`);
      dot.setAttribute('aria-hidden', 'true');
      pctGroup.append(dot);
      if (unknown) {
        pctGroup.append(node('strong', UNKNOWN_QUOTA, 'home-agent-pct level-none'));
      } else if (pct != null) {
        const scopeLabel = scope === 'free' ? '免费' : scope === 'permanent' ? '永久' : '剩余';
        pctGroup.append(
          node('span', scopeLabel, 'home-agent-pct-label'),
          node('strong', pct, `home-agent-pct ${cls}`)
        );
      } else {
        pctGroup.append(node('strong', '未上报', 'home-agent-pct level-none'));
      }
      const resetEl = node('span', `重置 ${resetText}`, 'home-agent-reset');
      if (resetRaw) resetEl.title = `额度重置：${formatScheduleText(resetRaw)}`;
      quotaLine.append(pctGroup, resetEl);
      quotaBox.append(quotaLine, makeProgressBar(percent, level, { thin: true }));
      card.append(quotaBox);

      const dates = node('div', null, 'home-agent-dates');
      const reportEl = node('span', `上报 ${reportText}`, 'home-agent-reported');
      if (reportTime) reportEl.title = `上报日期：${formatBeijingFull(reportTime)}（北京时间）`;
      const scanEl = node('span', scanText ? `扫描 ${scanText}` : '未扫描', 'home-agent-scanned');
      scanEl.title = person.last_seen_at ? `最近扫描：${formatBeijingFull(person.last_seen_at)}（北京时间）` : '近 30 天无扫描记录';
      dates.append(reportEl, scanEl);
      card.append(dates);
      card.append(renderInboxStatus(person, { compact: true }));
      return card;
    });
    list.replaceChildren(...cards);
  }

  // ---- Agent 详情弹层（里面：Agent 信息 + 管理员留言指示 + 免费/永久额度明细 + 上报历史 + 30 天 API 扫描日志） ----
  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.getElementById('agentDetailModal');
    if (!modalEl) {
      modalEl = node('div', null, 'agent-modal');
      modalEl.id = 'agentDetailModal';
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('aria-labelledby', 'agentModalTitle');
      modalEl.hidden = true;
      document.body.append(modalEl);
    }
    modalEl.addEventListener('click', event => {
      if (event.target === modalEl) closeDetail();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && modalEl && !modalEl.hidden) closeDetail();
    });
    return modalEl;
  }

  function closeDetail() {
    if (!modalEl || modalEl.hidden) return;
    modalEl.hidden = true;
    modalEl.replaceChildren();
    activeAgentId = null;
    modalState = null;
    if (!document.getElementById('filePreviewModal') || document.getElementById('filePreviewModal').hidden) {
      document.body.classList.remove('has-modal');
    }
  }

  function syncLocalAgentCounts(agentId, counts, inboxStatus = null) {
    if (!counts) return;
    const pending = Number(counts.pending || 0);
    const completed = Number(counts.completed || 0);
    let touched = false;
    latestAgents = latestAgents.map(a => {
      if (a.id !== agentId) return a;
      touched = true;
      return { ...a, ...inboxStatus, pending_directives: pending, completed_directives: completed };
    });
    if (modalState && modalState.person.id === agentId) {
      modalState.person = { ...modalState.person, ...inboxStatus, pending_directives: pending, completed_directives: completed };
      modalState.directivesCounts = { pending, completed, total: Number(counts.total ?? (pending + completed)) };
    }
    if (touched) renderWorkbenchOverview(latestAgents);
    onDirectivesChanged?.(agentId, counts, inboxStatus);
  }

  function renderDirectivesSection() {
    const {
      person,
      directivesLoaded,
      directivesBusy,
      directivesError,
      directives,
      directivesCounts,
      directivesFilter,
      directivesCursor,
      directiveDraft,
      directiveSubmitting,
      directiveFormError,
      confirmRecallId,
      recallingId,
    } = modalState;

    const counts = directivesCounts || {
      pending: Number(person.pending_directives || 0),
      completed: Number(person.completed_directives || 0),
      total: Number(person.pending_directives || 0) + Number(person.completed_directives || 0),
    };

    const section = node('section', null, 'quota-detail-section agent-directives-section');
    section.id = 'modalAgentDirectives';

    const head = node('div', null, 'quota-section-head');
    const titleGroup = node('div', null, 'quota-section-title');
    titleGroup.append(node('h4', '管理员留言与指示'));
    if (counts.pending > 0) titleGroup.append(node('span', `待回馈 ${counts.pending}`, 'agent-directive-badge is-pending'));
    if (counts.completed > 0) titleGroup.append(node('span', `已达成 ${counts.completed}`, 'agent-directive-badge is-completed'));
    const refreshBtn = node('button', directivesBusy ? '读取中…' : '刷新留言', 'text-button');
    refreshBtn.type = 'button';
    refreshBtn.disabled = directivesBusy;
    refreshBtn.addEventListener('click', () => loadModalDirectives(false));
    head.append(titleGroup, refreshBtn);
    section.append(head);

    section.append(renderInboxStatus(person));
    section.append(node('p', '留言等待该 Agent 在巡检中主动取信，本站不会唤醒 Agent。成功取信仅表示接口已返回留言，完成后仍须提交回馈，才会标记为「已达成」并归档。', 'muted quota-small-hint'));

    // 下达新留言表单（仅启用中的 Agent 可下达）
    if (person.active === 0 || person.active === false) {
      section.append(node('p', '该 Agent 已停用，无法下达新留言，历史已达成记录仍保留供查阅。', 'muted agent-directive-inactive-note'));
    } else {
      const form = node('form', null, 'agent-directive-composer');
      form.id = 'agentDirectiveForm';
      const label = node('label', `给 ${person.name} 下达留言指示`);
      label.setAttribute('for', 'agentDirectiveInput');
      const textarea = node('textarea');
      textarea.id = 'agentDirectiveInput';
      textarea.name = 'content';
      textarea.rows = 3;
      textarea.maxLength = 4000;
      textarea.required = true;
      textarea.placeholder = `写下具体要求，例如：核查最新报告数据口径并把核查结果与链接回馈给我…（支持 Markdown，Ctrl/⌘+Enter 发送）`;
      textarea.value = directiveDraft || '';
      textarea.disabled = directiveSubmitting;
      textarea.addEventListener('input', () => {
        if (modalState) modalState.directiveDraft = textarea.value;
      });
      textarea.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          form.requestSubmit();
        }
      });

      const foot = node('div', null, 'agent-directive-composer-foot');
      const hint = node('span', '管理员专属 · 仅该 Agent 可见', 'muted agent-directive-composer-hint');
      const submitBtn = node('button', directiveSubmitting ? '下达中…' : '下达留言', 'primary');
      submitBtn.type = 'submit';
      submitBtn.disabled = directiveSubmitting;
      foot.append(hint, submitBtn);

      form.append(label, textarea, foot);
      if (directiveFormError) {
        const err = node('p', directiveFormError, 'error');
        err.setAttribute('role', 'alert');
        form.append(err);
      }
      form.addEventListener('submit', async event => {
        event.preventDefault();
        await submitDirective();
      });
      section.append(form);
    }

    // 状态筛选栏
    const filterBar = node('div', null, 'agent-directive-filters');
    filterBar.setAttribute('role', 'group');
    filterBar.setAttribute('aria-label', '按状态筛选留言');
    const filterSpecs = [
      { key: 'all', label: '全部', count: counts.total },
      { key: 'pending', label: '待回馈', count: counts.pending },
      { key: 'completed', label: '已达成', count: counts.completed },
    ];
    for (const spec of filterSpecs) {
      const active = directivesFilter === spec.key;
      const chip = node('button', `${spec.label} (${spec.count})`, `conversation-filter-chip${active ? ' is-active' : ''}`);
      chip.type = 'button';
      chip.dataset.directiveFilter = spec.key;
      chip.setAttribute('aria-pressed', String(active));
      chip.addEventListener('click', () => {
        if (!modalState || modalState.directivesFilter === spec.key) return;
        modalState.directivesFilter = spec.key;
        modalState.confirmRecallId = null;
        loadModalDirectives(false);
      });
      filterBar.append(chip);
    }
    section.append(filterBar);

    if (directivesError) {
      const errBox = node('div', null, 'quota-error-box');
      errBox.append(node('p', `留言记录读取失败：${directivesError}`, 'error'), button('重试读取留言', () => loadModalDirectives(false), 'secondary'));
      section.append(errBox);
    } else if (directivesBusy && !directivesLoaded) {
      section.append(node('p', '正在读取留言与回馈归档…', 'muted'));
    } else if (directives.length === 0) {
      const emptyText = directivesFilter === 'pending'
        ? '当前没有待回馈的留言指示。'
        : directivesFilter === 'completed'
          ? '还没有已达成并归档的留言记录。'
          : '还没有给该 Agent 下达过留言指示。';
      section.append(node('p', emptyText, 'muted quota-empty-note'));
    } else {
      const list = node('div', null, 'agent-directive-list');
      for (const item of directives) {
        const done = item.status === 'completed';
        const card = node('article', null, `agent-directive-card ${done ? 'is-completed' : 'is-pending'}`);
        card.dataset.directiveId = String(item.id);
        card.dataset.directiveStatus = item.status;

        const top = node('div', null, 'agent-directive-card-head');
        const metaLeft = node('div', null, 'agent-directive-meta');
        metaLeft.append(
          node('span', done ? '✓ 已达成' : '待回馈', `agent-directive-status ${done ? 'is-completed' : 'is-pending'}`),
          node('span', `#${item.id}`, 'record-id'),
          node('span', `下达：${item.author_name || '管理员'}`, 'muted')
        );
        const createdEl = node('time', formatBeijingFull(item.created_at), 'muted agent-directive-time');
        createdEl.dateTime = item.created_at;
        metaLeft.append(createdEl);
        if (!done) {
          const receipt = node('span', item.fetched_at ? '已取信 · 待回馈' : '待取信', 'agent-directive-receipt');
          if (item.fetched_at) receipt.title = `首次取信：${formatBeijingFull(item.fetched_at)}（北京时间）`;
          metaLeft.append(receipt);
        }
        top.append(metaLeft);

        if (!done) {
          const ops = node('div', null, 'agent-directive-ops');
          if (confirmRecallId === item.id) {
            const busy = recallingId === item.id;
            const confirmBtn = node('button', busy ? '撤回中…' : '确认撤回', 'danger agent-directive-recall-confirm');
            confirmBtn.type = 'button';
            confirmBtn.disabled = busy;
            confirmBtn.addEventListener('click', () => recallDirective(item.id));
            const cancelBtn = node('button', '取消', 'ghost-button');
            cancelBtn.type = 'button';
            cancelBtn.disabled = busy;
            cancelBtn.addEventListener('click', () => {
              if (!modalState) return;
              modalState.confirmRecallId = null;
              renderModalContent();
            });
            ops.append(confirmBtn, cancelBtn);
          } else {
            const recallBtn = node('button', '撤回', 'text-button agent-directive-recall-btn');
            recallBtn.type = 'button';
            recallBtn.addEventListener('click', () => {
              if (!modalState) return;
              modalState.confirmRecallId = item.id;
              renderModalContent();
            });
            ops.append(recallBtn);
          }
          top.append(ops);
        }
        card.append(top);

        const bodyEl = linkedText
          ? linkedText(item.content, 'agent-directive-content', { limit: 600 })
          : node('p', item.content, 'agent-directive-content');
        card.append(bodyEl);

        if (done) {
          const fb = node('div', null, 'agent-directive-feedback');
          const fbHead = node('div', null, 'agent-directive-feedback-head');
          fbHead.append(node('strong', `${item.agent_name || person.name} 回馈完成（已自动归档）`));
          if (item.completed_at) {
            const ct = node('time', formatBeijingFull(item.completed_at), 'muted agent-directive-time');
            ct.dateTime = item.completed_at;
            fbHead.append(ct);
          }
          fb.append(fbHead);
          const resultEl = linkedText
            ? linkedText(item.result || '（已完成）', 'agent-directive-result', { limit: 800 })
            : node('p', item.result || '（已完成）', 'agent-directive-result');
          fb.append(resultEl);

          const linkList = Array.isArray(item.links)
            ? item.links
            : (typeof item.links === 'string' && item.links.trim() ? item.links.split(/\s+/).filter(Boolean) : []);
          if (linkList.length > 0) {
            if (sources) {
              const srcEl = sources(linkList.join('\n'));
              if (srcEl) {
                srcEl.classList.add('agent-directive-links');
                fb.append(srcEl);
              }
            } else {
              const ul = node('ul', null, 'agent-directive-link-list');
              for (const href of linkList) {
                const li = node('li');
                const a = node('a', href);
                a.href = href;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                li.append(a);
                ul.append(li);
              }
              fb.append(ul);
            }
          }
          card.append(fb);
        }

        list.append(card);
      }
      section.append(list);

      if (directivesCursor) {
        const moreBtn = node('button', directivesBusy ? '正在加载…' : '查看更早留言记录', 'text-button');
        moreBtn.type = 'button';
        moreBtn.disabled = directivesBusy;
        moreBtn.addEventListener('click', () => loadModalDirectives(true));
        section.append(moreBtn);
      }
    }
    return section;
  }

  function renderBucketDetailSection(title, kind, bucket, defaultUnit, unknown) {
    const box = node('section', null, `quota-detail-section is-${kind}`);
    const head = node('div', null, 'quota-section-head');
    const titleGroup = node('div', null, 'quota-section-title');
    titleGroup.append(node('h4', title));
    if (!bucket) {
      head.append(titleGroup, node('span', unknown ? '未知' : '未上报', 'agent-quota-pill level-none'));
      const message = unknown ? '此次心跳未取得额度读数。'
        : (kind === 'free' ? '该 Agent 此次未上报免费额度。' : '该 Agent 此次未上报永久额度。');
      box.append(head, node('p', message, 'muted quota-empty-note'));
      return box;
    }

    const unit = bucket.unit || defaultUnit || 'tokens';
    const level = resolveLevel(bucket.percent, bucket.status_level, bucket.remaining);
    const meta = LEVEL_META[level] || LEVEL_META.none;
    const pct = formatPercent(bucket.percent);
    const summaryPill = node('span', null, `agent-quota-pill ${meta.cls}`);
    const dot = node('span', '', `quota-dot ${meta.cls}`);
    dot.setAttribute('aria-hidden', 'true');
    const summaryText = pct
      ? `${meta.label} · ${pct}`
      : (bucket.remaining != null ? `${formatNum(bucket.remaining)} ${unit}` : meta.label);
    summaryPill.append(dot, node('span', summaryText));
    head.append(titleGroup, summaryPill);
    box.append(head);

    // 汇总数值行 + 进度条（同时适配「仅百分比」与「具体数值」两种上报模式）
    const summaryBar = node('div', null, 'quota-bucket-summary');
    const nums = node('div', null, 'quota-bucket-nums');
    const percentOnly = bucket.remaining == null && bucket.percent != null;
    const remEl = node('div', null, 'quota-num-pair');
    const remValueText = kind === 'free' && pct ? pct : bucket.remaining != null
      ? `${formatNum(bucket.remaining)} ${unit}`
      : (pct || '—');
    remEl.append(node('span', kind === 'free' && pct ? '剩余百分比' : '当前剩余', 'quota-num-label'), node('strong', remValueText, `quota-num-value ${meta.cls}`));
    nums.append(remEl);
    if (kind === 'free' && pct && bucket.remaining != null) {
      const balanceEl = node('div', null, 'quota-num-pair');
      balanceEl.append(node('span', '剩余额度', 'quota-num-label'), node('strong', `${formatNum(bucket.remaining)} ${unit}`, 'quota-num-value'));
      nums.append(balanceEl);
    }

    if (bucket.total != null) {
      const totEl = node('div', null, 'quota-num-pair');
      totEl.append(node('span', '总额度', 'quota-num-label'), node('strong', `${formatNum(bucket.total)} ${unit}`, 'quota-num-value'));
      nums.append(totEl);
    } else if (kind === 'permanent') {
      const totEl = node('div', null, 'quota-num-pair');
      totEl.append(node('span', '有效期', 'quota-num-label'), node('strong', '永久有效', 'quota-num-value'));
      nums.append(totEl);
    }

    if (bucket.used != null) {
      const usedEl = node('div', null, 'quota-num-pair');
      usedEl.append(node('span', '已使用', 'quota-num-label'), node('strong', `${formatNum(bucket.used)} ${unit}`, 'quota-num-value'));
      nums.append(usedEl);
    } else if (percentOnly) {
      const usedPct = bucket.used_percent != null ? formatPercent(bucket.used_percent) : formatPercent(Math.max(0, 100 - Number(bucket.percent)));
      if (usedPct) {
        const usedEl = node('div', null, 'quota-num-pair');
        usedEl.append(node('span', '已使用', 'quota-num-label'), node('strong', usedPct, 'quota-num-value'));
        nums.append(usedEl);
      }
    }
    summaryBar.append(nums);
    if (bucket.percent != null || level === 'red') {
      summaryBar.append(makeProgressBar(bucket.percent ?? 0, level));
    }

    const metaBits = [];
    if (bucket.reset_at) metaBits.push(`重置时间：${formatScheduleText(bucket.reset_at)}`);
    if (bucket.expires_at) metaBits.push(`过期时间：${formatScheduleText(bucket.expires_at)}`);
    if (bucket.note) metaBits.push(`说明：${bucket.note}`);
    if (metaBits.length) {
      const metaRow = node('div', null, 'quota-bucket-meta');
      for (const bit of metaBits) metaRow.append(node('span', bit));
      summaryBar.append(metaRow);
    }
    box.append(summaryBar);

    // 逐项明细列表
    const items = Array.isArray(bucket.items) ? bucket.items : [];
    if (items.length > 0) {
      const subHead = node('div', null, 'quota-items-heading');
      subHead.append(node('span', `分项明细（${items.length} 项）`));
      box.append(subHead);

      const grid = node('div', null, 'quota-items-list');
      for (const item of items) {
        const itemUnit = item.unit || unit;
        const itemLevel = resolveLevel(item.percent, item.status_level, item.remaining);
        const itemMeta = LEVEL_META[itemLevel] || LEVEL_META.none;
        const itemPct = formatPercent(item.percent);
        const card = node('div', null, `quota-item-card ${itemMeta.cls}`);

        const top = node('div', null, 'quota-item-top');
        const nameWrap = node('div', null, 'quota-item-name');
        const idot = node('span', '', `quota-dot ${itemMeta.cls}`);
        idot.setAttribute('aria-hidden', 'true');
        nameWrap.append(idot, node('strong', item.name));

        const right = node('div', null, 'quota-item-right');
        const amountText = item.remaining != null && item.total != null
          ? `${formatNum(item.remaining)} / ${formatNum(item.total)} ${itemUnit}`
          : item.remaining != null
            ? `${formatNum(item.remaining)} ${itemUnit}`
            : null;
        if (amountText) right.append(node('span', amountText, 'quota-item-amount'));
        if (itemPct) right.append(node('span', amountText ? itemPct : `剩余 ${itemPct}`, `quota-item-pct ${itemMeta.cls}`));
        top.append(nameWrap, right);
        card.append(top);

        if (item.percent != null || itemLevel === 'red') {
          card.append(makeProgressBar(item.percent ?? 0, itemLevel, { thin: true }));
        }

        const itemFoot = [];
        if (item.used != null) itemFoot.push(`已用 ${formatNum(item.used)} ${itemUnit}`);
        else if (item.remaining == null && item.percent != null) {
          const usedPct = item.used_percent != null ? formatPercent(item.used_percent) : formatPercent(Math.max(0, 100 - Number(item.percent)));
          if (usedPct) itemFoot.push(`已用 ${usedPct}`);
        }
        if (item.reset_at) itemFoot.push(`重置：${formatScheduleText(item.reset_at)}`);
        if (item.expires_at) itemFoot.push(`过期：${formatScheduleText(item.expires_at)}`);
        if (item.note) itemFoot.push(item.note);
        if (itemFoot.length) {
          const foot = node('div', null, 'quota-item-meta');
          for (const bit of itemFoot) foot.append(node('span', bit));
          card.append(foot);
        }
        grid.append(card);
      }
      box.append(grid);
    }
    return box;
  }

  function renderModalContent() {
    if (!modalEl || !modalState) return;
    const prevScroll = modalEl.querySelector('.agent-modal-body')?.scrollTop || 0;
    const prevInput = modalEl.querySelector('#agentDirectiveInput');
    const wasInputFocused = !!prevInput && document.activeElement === prevInput;
    const prevSelStart = wasInputFocused ? prevInput.selectionStart : null;
    const prevSelEnd = wasInputFocused ? prevInput.selectionEnd : null;
    if (prevInput) modalState.directiveDraft = prevInput.value;

    const {
      person, quotaLoaded, quotaBusy, quotaError, quota, history, historyCursor, historyBusy,
      visitsLoaded, visitsBusy, visitsError, visits, visitsTotal, visitsCursor,
      directivesCounts,
    } = modalState;
    const currentQuota = quotaLoaded ? quota : (person.quota || null);
    const indicator = quotaIndicator(currentQuota);
    const overallLevel = indicator.level;
    const counts = directivesCounts || {
      pending: Number(person.pending_directives || 0),
      completed: Number(person.completed_directives || 0),
      total: Number(person.pending_directives || 0) + Number(person.completed_directives || 0),
    };

    const dialog = node('div', null, 'agent-dialog');

    // 1. Header
    const header = node('header', null, 'agent-modal-header');
    const headLeft = node('div', null, 'agent-modal-title-block');
    const titleRow = node('div', null, 'agent-modal-title-row');
    const h3 = node('h3', person.name);
    h3.id = 'agentModalTitle';
    titleRow.append(h3, makePill(currentQuota, { verbose: true }));
    const pendingBadge = makeDirectiveBadge(counts.pending);
    if (pendingBadge) titleRow.append(pendingBadge);
    if (person.active === 0 || person.active === false) titleRow.append(node('span', '已停用', 'badge closed'));
    const subParts = [];
    if (person.username) subParts.push(`@${person.username}`);
    subParts.push(`Agent #${person.id}`);
    subParts.push(person.active === 0 || person.active === false ? '已停用' : '启用中');
    headLeft.append(titleRow, node('p', subParts.join(' · '), 'muted agent-modal-sub'));

    const headActions = node('div', null, 'agent-modal-actions');
    if (person.active !== 0 && person.active !== false) {
      const msgBtn = node('button', '下达留言', 'primary agent-modal-directive-jump');
      msgBtn.type = 'button';
      msgBtn.addEventListener('click', () => {
        const target = modalEl?.querySelector('#modalAgentDirectives');
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        modalEl?.querySelector('#agentDirectiveInput')?.focus({ preventScroll: true });
      });
      headActions.append(msgBtn);
    }
    const refreshBtn = button('刷新', async () => {
      await Promise.all([loadModalQuota(false), loadModalVisits(false), loadModalDirectives(false)]);
    }, 'secondary');
    const closeBtn = node('button', '关闭', 'ghost-button');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closeDetail);
    headActions.append(refreshBtn, closeBtn);
    header.append(headLeft, headActions);

    // 2. Quick jump bar
    const jumpBar = node('nav', null, 'agent-modal-nav');
    jumpBar.setAttribute('aria-label', '详情分区跳转');
    const body = node('div', null, 'agent-modal-body');
    const jumpTargets = [
      { id: 'modalQuotaOverview', label: '概览' },
      { id: 'modalAgentDirectives', label: `留言指示${counts.total ? ` (${counts.total})` : ''}` },
      { id: 'modalQuotaFree', label: '免费额度明细' },
      { id: 'modalQuotaPermanent', label: '永久额度明细' },
      { id: 'modalQuotaHistory', label: `上报记录${history.length ? ` (${history.length})` : ''}` },
      { id: 'modalVisitLogs', label: `API 扫描日志${visitsTotal != null ? ` (${visitsTotal})` : ''}` },
    ];
    for (const item of jumpTargets) {
      const btn = node('button', item.label, 'agent-jump-btn');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        body.querySelector(`#${item.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      jumpBar.append(btn);
    }

    // 3. Body: Overview metrics strip
    const overview = node('section', null, 'agent-detail-overview');
    overview.id = 'modalQuotaOverview';
    const metrics = node('div', null, 'agent-metric-grid');

    // 主要信息：剩余百分比、额度重置、永久余额、上报日期。
    const mOverall = node('div', null, `agent-metric-card is-primary ${LEVEL_META[overallLevel].cls}`);
    mOverall.dataset.quotaMetric = 'percent';
    const unknown = currentQuota?.basis === 'unknown';
    const missingReading = unknown ? '未知' : '未上报';
    const pctText = currentQuota
      ? (unknown ? UNKNOWN_QUOTA : (formatPercent(indicator.percent) || '百分比未上报'))
      : '未上报';
    const free = currentQuota?.free;
    const freeUnit = free?.unit || currentQuota?.unit || 'tokens';
    const balanceHint = free?.remaining != null ? `${formatNum(free.remaining)}${free.total != null ? ` / ${formatNum(free.total)}` : ''} ${freeUnit}` : '';
    const overallHint = unknown ? '已收到心跳，等待额度读数'
      : (currentQuota ? [indicator.percent != null ? `${LEVEL_META[overallLevel].label}（${LEVEL_META[overallLevel].hint}）` : '等待剩余百分比读数', balanceHint].filter(Boolean).join(' · ') : '绿 ≥60% · 黄 20–59% · 红 <20%');
    mOverall.append(
      node('span', indicator.scope === 'free' ? '免费额度剩余' : '额度剩余百分比', 'agent-metric-label'),
      node('strong', pctText, `agent-metric-value ${LEVEL_META[overallLevel].cls}`),
      node('span', overallHint, 'agent-metric-note')
    );
    if (indicator.percent != null) mOverall.append(makeProgressBar(indicator.percent, overallLevel, { thin: true }));
    metrics.append(mOverall);

    const resetAt = quotaResetAt(currentQuota);
    const mReset = node('div', null, 'agent-metric-card');
    mReset.dataset.quotaMetric = 'reset';
    mReset.append(
      node('span', '额度重置日期', 'agent-metric-label'),
      node('strong', formatScheduleText(resetAt, { includeTimezone: false }) || missingReading, 'agent-metric-value is-time'),
      node('span', '免费额度下次重置（北京时间）', 'agent-metric-note')
    );
    metrics.append(mReset);

    // Metric 3: 永久额度
    const perm = currentQuota?.permanent || null;
    const permLevel = perm ? resolveLevel(perm.percent, perm.status_level, perm.remaining) : 'none';
    const mPerm = node('div', null, `agent-metric-card ${LEVEL_META[permLevel].cls}`);
    mPerm.dataset.quotaMetric = 'permanent';
    const permUnit = perm?.unit || currentQuota?.unit || 'tokens';
    const permPctOnly = perm && perm.remaining == null && perm.percent != null;
    const permVal = perm
      ? (perm.remaining != null ? `${formatNum(perm.remaining)} ${permUnit}` : (formatPercent(perm.percent) || '—'))
      : missingReading;
    const permSub = perm
      ? (permPctOnly
          ? [LEVEL_META[permLevel].label, '永久有效', perm.used_percent != null ? `已用 ${formatPercent(perm.used_percent)}` : `已用 ${formatPercent(Math.max(0, 100 - Number(perm.percent)))}`, perm.items?.length ? `${perm.items.length} 项明细` : null].filter(Boolean).join(' · ')
          : [perm.total != null ? `总额 ${formatNum(perm.total)}` : '永久有效', formatPercent(perm.percent) ? `剩 ${formatPercent(perm.percent)}` : null, perm.items?.length ? `${perm.items.length} 项明细` : null].filter(Boolean).join(' · '))
      : '暂无永久额度数据';
    mPerm.append(node('span', '永久额度剩余', 'agent-metric-label'), node('strong', permVal, `agent-metric-value ${LEVEL_META[permLevel].cls}`), node('span', permSub, 'agent-metric-note'));
    metrics.append(mPerm);

    const mTime = node('div', null, 'agent-metric-card');
    mTime.dataset.quotaMetric = 'reported';
    const reportTime = currentQuota?.reported_at || currentQuota?.updated_at;
    const directiveStatNote = `留言指示：待回馈 ${counts.pending} · 已达成 ${counts.completed}`;
    mTime.append(
      node('span', '上报日期（北京时间）', 'agent-metric-label'),
      node('strong', reportTime ? formatBeijingShort(reportTime, { includeYear: true }) : '未上报', 'agent-metric-value is-time'),
      node('span', currentQuota?.updated_at && currentQuota.updated_at !== reportTime ? `服务端接收：${formatBeijingShort(currentQuota.updated_at, { includeYear: true })}` : '最近一次额度上报', 'agent-metric-note')
    );
    if (reportTime) mTime.title = formatBeijingFull(reportTime);
    metrics.append(mTime);
    overview.append(metrics);
    const contextMeta = node('div', null, 'quota-context-meta');
    contextMeta.append(
      node('span', person.last_seen_at ? `最近扫描：${formatBeijingShort(person.last_seen_at)}（北京时间）` : '近 30 天无扫描'),
      node('span', directiveStatNote)
    );
    overview.append(contextMeta);

    const channel = CHANNEL_LABEL[currentQuota?.read_channel];
    if (currentQuota?.note || currentQuota?.source || channel) {
      const noteBar = node('div', null, 'agent-quota-note-bar');
      if (currentQuota.note) noteBar.append(node('span', `备注：${currentQuota.note}`));
      if (currentQuota.source) noteBar.append(node('span', `来源：${currentQuota.source}`, 'muted'));
      if (channel) noteBar.append(node('span', channel, 'muted'));
      overview.append(noteBar);
    }
    body.append(overview);

    // 4. Per-Agent Admin Directives (留言指示与完成归档)
    body.append(renderDirectivesSection());

    // 5. Quota detail sections (Free + Permanent)
    if (quotaError) {
      const errBox = node('div', null, 'quota-error-box');
      errBox.append(node('p', `额度详情读取失败：${quotaError}`, 'error'), button('重试读取额度', () => loadModalQuota(false), 'secondary'));
      body.append(errBox);
    } else if (quotaBusy && !quotaLoaded) {
      body.append(node('p', '正在读取免费额度与永久额度明细…', 'muted quota-loading'));
    } else if (!currentQuota) {
      const emptyCard = node('section', null, 'quota-detail-section quota-not-reported');
      emptyCard.id = 'modalQuotaFree';
      emptyCard.append(
        node('h4', '尚未收到该 Agent 的额度上报'),
        node('p', 'Agent 使用个人 wba_ 令牌调用 POST /api/agent/quota（或 PUT /api/agent/quota），上报剩余百分比、下次重置日期、永久额度及上报日期。时间使用带时区的 ISO 格式；未传 reported_at 时以服务端接收时间为准。', 'muted'),
        node('pre', JSON.stringify({
          reported_at: '2026-11-21T10:00:00+08:00',
          free: { percent: 75, reset_at: '2026-11-25T15:00:00+08:00' },
          permanent: {
            remaining: 185000,
            unit: 'tokens',
            note: '平台赠送永久额度',
            items: [
              { name: '赠送永久额度', remaining: 185000, unit: 'tokens' },
            ],
          },
        }, null, 2), 'quota-api-sample')
      );
      body.append(emptyCard);
    } else {
      const freeSection = renderBucketDetailSection('免费额度明细', 'free', currentQuota.free, currentQuota.unit, unknown);
      freeSection.id = 'modalQuotaFree';
      const permSection = renderBucketDetailSection('永久额度明细', 'permanent', currentQuota.permanent, currentQuota.unit, unknown);
      permSection.id = 'modalQuotaPermanent';
      body.append(freeSection, permSection);
    }

    // 6. Quota Report History Section
    const histSection = node('section', null, 'quota-detail-section quota-history-section');
    histSection.id = 'modalQuotaHistory';
    const histHead = node('div', null, 'quota-section-head');
    histHead.append(node('h4', '近期额度上报记录'), node('span', '保留近 30 天', 'muted quota-small-hint'));
    histSection.append(histHead);
    if (history.length > 0) {
      const tableWrap = node('div', null, 'quota-history-wrap');
      const table = node('table', null, 'quota-history-table');
      const thead = node('thead');
      const hrow = node('tr');
      for (const col of ['上报时间（北京时间）', '剩余状态', '免费额度', '额度重置日期', '永久额度', '原因与备注']) hrow.append(node('th', col));
      thead.append(hrow);
      const tbody = node('tbody');
      for (const row of history) {
        const tr = node('tr');
        const lv = resolveLevel(row.free_percent ?? row.overall_percent, row.status_level, row.free_remaining ?? row.permanent_remaining);
        const pct = formatPercent(row.free_percent ?? row.overall_percent);
        const unit = row.unit || 'tokens';
        const freeUnit = row.free_unit || unit;
        const permUnit = row.permanent_unit || unit;
        const tdTime = node('td');
        const reportTime = row.reported_at || row.created_at;
        const timeEl = node('time', formatBeijingFull(reportTime));
        timeEl.dateTime = reportTime;
        timeEl.title = `服务端接收：${formatBeijingFull(row.created_at)}`;
        tdTime.append(timeEl);

        const tdStatus = node('td');
        const sp = node('span', null, `agent-quota-pill is-xs ${LEVEL_META[lv].cls}`);
        const status = row.basis === 'unknown' ? UNKNOWN_QUOTA : LEVEL_META[lv].label;
        sp.append(node('span', '', `quota-dot ${LEVEL_META[lv].cls}`), node('span', pct || status));
        tdStatus.append(sp);

        const freeAmount = row.free_remaining != null
          ? `${formatNum(row.free_remaining)}${row.free_total != null ? ` / ${formatNum(row.free_total)}` : ''} ${freeUnit}` : '';
        const freeStr = [formatPercent(row.free_percent), freeAmount].filter(Boolean).join(' · ') || '—';
        const permStr = row.permanent_remaining != null
          ? `${formatNum(row.permanent_remaining)}${row.permanent_total != null ? ` / ${formatNum(row.permanent_total)}` : ''} ${permUnit}${row.permanent_percent != null ? ` (${formatPercent(row.permanent_percent)})` : ''}`
          : (row.permanent_percent != null ? formatPercent(row.permanent_percent) : '—');

        const notes = [...(row.reasons || []).map(reason => REASON_LABEL[reason]), CHANNEL_LABEL[row.read_channel], row.note].filter(Boolean);
        tr.append(tdTime, tdStatus, node('td', freeStr), node('td', formatScheduleText(row.reset_at) || '未上报'), node('td', permStr), node('td', notes.join(' · ') || '—', 'muted'));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      tableWrap.append(table);
      histSection.append(tableWrap);
      if (historyCursor) {
        const moreHist = node('button', historyBusy ? '正在加载…' : '查看更早上报记录', 'text-button');
        moreHist.type = 'button';
        moreHist.disabled = historyBusy;
        moreHist.addEventListener('click', () => loadModalQuota(true));
        histSection.append(moreHist);
      }
    } else if (quotaLoaded && !quotaError) {
      histSection.append(node('p', '近 30 天暂无额度上报记录。', 'muted quota-empty-note'));
    }
    body.append(histSection);

    // 7. Detailed API Scan Logs (agent_visits)
    const visitsSection = node('section', null, 'quota-detail-section agent-modal-visits');
    visitsSection.id = 'modalVisitLogs';
    const vHead = node('div', null, 'quota-section-head');
    const vTitleWrap = node('div', null, 'quota-section-title');
    vTitleWrap.append(node('h4', '详细 API 扫描日志（到访时间记录）'));
    if (visitsTotal != null) vTitleWrap.append(node('span', `近 30 天共 ${visitsTotal} 次请求`, 'count'));
    const vRefresh = node('button', visitsBusy ? '读取中…' : '刷新日志', 'text-button');
    vRefresh.type = 'button';
    vRefresh.disabled = visitsBusy;
    vRefresh.addEventListener('click', () => loadModalVisits(false));
    vHead.append(vTitleWrap, vRefresh);
    visitsSection.append(vHead);
    visitsSection.append(node('p', '每次通过该 Agent 独立 Bearer 令牌验证的 API 访问均记为一条扫描日志（北京时间，保留近 30 天）。', 'muted quota-small-hint'));

    if (visitsError) {
      const errP = node('p', `扫描日志读取失败：${visitsError}。可点击“刷新日志”重试。`, 'error');
      errP.setAttribute('role', 'status');
      visitsSection.append(errP);
    }
    if (visitsBusy && !visitsLoaded) {
      visitsSection.append(node('p', '正在读取 API 扫描日志…', 'muted'));
    } else if (visitsLoaded && visits.length === 0 && !visitsError) {
      visitsSection.append(node('p', '近 30 天没有已记录的 API 扫描到访。', 'muted quota-empty-note'));
    } else if (visits.length > 0) {
      const notice = node('p', `已显示 ${visits.length} 条扫描日志${visitsTotal != null ? `（共 ${visitsTotal} 次）` : ''}${visitsCursor ? '，可继续加载更早记录。' : '。'}`, 'muted quota-log-count');
      const ol = node('ol', null, 'agent-modal-visit-list');
      for (const rec of visits) {
        const li = node('li');
        const timeEl = node('time', formatBeijingFull(rec.visited_at));
        timeEl.dateTime = rec.visited_at;
        const idTag = node('span', `#${rec.id}`, 'record-id');
        li.append(timeEl, idTag);
        ol.append(li);
      }
      visitsSection.append(notice, ol);
      if (visitsCursor) {
        const moreBtn = node('button', visitsBusy ? '正在加载…' : '查看更早扫描日志', 'text-button');
        moreBtn.type = 'button';
        moreBtn.disabled = visitsBusy;
        moreBtn.addEventListener('click', () => loadModalVisits(true));
        visitsSection.append(moreBtn);
      }
    }
    body.append(visitsSection);

    dialog.append(header, jumpBar, body);
    modalEl.replaceChildren(dialog);
    if (prevScroll > 0) body.scrollTop = prevScroll;

    const nextInput = modalEl.querySelector('#agentDirectiveInput');
    if (modalState.shouldFocusDirective && nextInput) {
      modalState.shouldFocusDirective = false;
      modalEl.querySelector('#modalAgentDirectives')?.scrollIntoView({ block: 'start' });
      nextInput.focus({ preventScroll: true });
    } else if (wasInputFocused && nextInput) {
      nextInput.focus({ preventScroll: true });
      if (prevSelStart != null && prevSelEnd != null) {
        try { nextInput.setSelectionRange(prevSelStart, prevSelEnd); } catch {}
      }
    }
  }

  async function loadModalDirectives(older = false) {
    if (!modalState || user()?.role !== 'admin') return;
    if (older && (!modalState.directivesCursor || modalState.directivesBusy)) return;
    const epoch = modalEpoch;
    const id = modalState.person.id;
    const filter = modalState.directivesFilter || 'all';
    modalState.directivesBusy = true;
    if (!older) modalState.directivesError = '';
    renderModalContent();
    try {
      const params = new URLSearchParams();
      if (filter && filter !== 'all') params.set('status', filter);
      if (older && modalState.directivesCursor) params.set('before', modalState.directivesCursor);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const result = await api(`/api/admin/agents/${id}/directives${qs}`);
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id || modalState.directivesFilter !== filter) return;
      const incoming = Array.isArray(result?.directives) ? result.directives : [];
      const seen = new Set(older ? modalState.directives.map(r => r.id) : []);
      modalState.directives = [...(older ? modalState.directives : []), ...incoming.filter(r => !seen.has(r.id))];
      if (!older && result?.counts && typeof result.counts === 'object') {
        syncLocalAgentCounts(id, result.counts, result.inbox_status);
      }
      modalState.directivesCursor = result?.next_cursor || null;
      modalState.directivesLoaded = true;
      modalState.directivesError = '';
    } catch (error) {
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id) return;
      if (older) notify?.(`更早留言读取失败：${error.message}`, true);
      else modalState.directivesError = error.message;
    } finally {
      if (epoch === modalEpoch && modalState && modalState.person.id === id) {
        modalState.directivesBusy = false;
        renderModalContent();
      }
    }
  }

  async function submitDirective() {
    if (!modalState || user()?.role !== 'admin' || modalState.directiveSubmitting) return;
    const content = String(modalState.directiveDraft || '').trim();
    if (!content) {
      modalState.directiveFormError = '请先填写给该 Agent 的留言内容';
      renderModalContent();
      return;
    }
    const epoch = modalEpoch;
    const id = modalState.person.id;
    modalState.directiveSubmitting = true;
    modalState.directiveFormError = '';
    renderModalContent();
    try {
      const res = await api(`/api/admin/agents/${id}/directives`, 'POST', { content });
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id) return;
      modalState.directiveDraft = '';
      modalState.directiveFormError = '';
      if (res?.counts) syncLocalAgentCounts(id, res.counts, res.inbox_status);
      if (res?.directive && (modalState.directivesFilter === 'all' || modalState.directivesFilter === 'pending')) {
        modalState.directives = [res.directive, ...modalState.directives.filter(d => d.id !== res.directive.id)];
      } else if (modalState.directivesFilter === 'completed') {
        modalState.directivesFilter = 'all';
        await loadModalDirectives(false);
      }
      notify?.(`已向 ${modalState.person.name} 下达留言指示`);
    } catch (error) {
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id) return;
      modalState.directiveFormError = error.message;
    } finally {
      if (epoch === modalEpoch && modalState && modalState.person.id === id) {
        modalState.directiveSubmitting = false;
        renderModalContent();
      }
    }
  }

  async function recallDirective(directiveId) {
    if (!modalState || user()?.role !== 'admin' || modalState.recallingId != null) return;
    const epoch = modalEpoch;
    const id = modalState.person.id;
    modalState.recallingId = directiveId;
    renderModalContent();
    try {
      const res = await api(`/api/admin/agents/${id}/directives/${directiveId}`, 'DELETE');
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id) return;
      modalState.directives = modalState.directives.filter(d => d.id !== directiveId);
      modalState.confirmRecallId = null;
      if (res?.counts) syncLocalAgentCounts(id, res.counts, res.inbox_status);
      notify?.('已撤回该条待回馈留言');
    } catch (error) {
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id) return;
      notify?.(`撤回失败：${error.message}`, true);
      if (error.status === 409) await loadModalDirectives(false);
    } finally {
      if (epoch === modalEpoch && modalState && modalState.person.id === id) {
        modalState.recallingId = null;
        renderModalContent();
      }
    }
  }

  async function loadModalQuota(older = false) {
    if (!modalState || user()?.role !== 'admin') return;
    if (older && (!modalState.historyCursor || modalState.historyBusy)) return;
    const epoch = modalEpoch;
    const id = modalState.person.id;
    if (older) modalState.historyBusy = true;
    else { modalState.quotaBusy = true; modalState.quotaError = ''; }
    renderModalContent();
    try {
      const query = older ? `?before=${encodeURIComponent(modalState.historyCursor)}` : '';
      const result = await api(`/api/admin/agents/${id}/quota${query}`);
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id) return;
      modalState.quota = result.quota || null;
      const incoming = Array.isArray(result.history) ? result.history : [];
      const seen = new Set(older ? modalState.history.map(r => r.id) : []);
      modalState.history = [...(older ? modalState.history : []), ...incoming.filter(r => !seen.has(r.id))];
      modalState.historyCursor = result.next_cursor || null;
      modalState.quotaLoaded = true;
      modalState.quotaError = '';
    } catch (error) {
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id) return;
      if (older) notify?.(`更早上报记录读取失败：${error.message}`, true);
      else modalState.quotaError = error.message;
    } finally {
      if (epoch === modalEpoch && modalState && modalState.person.id === id) {
        modalState.quotaBusy = false;
        modalState.historyBusy = false;
        renderModalContent();
      }
    }
  }

  async function loadModalVisits(older = false) {
    if (!modalState || user()?.role !== 'admin') return;
    if (older && (!modalState.visitsCursor || modalState.visitsBusy)) return;
    const epoch = modalEpoch;
    const id = modalState.person.id;
    modalState.visitsBusy = true;
    if (!older) modalState.visitsError = '';
    renderModalContent();
    try {
      const query = older ? `?before=${encodeURIComponent(modalState.visitsCursor)}` : '';
      const result = await api(`/api/admin/agents/${id}/visits${query}`);
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id) return;
      const incoming = Array.isArray(result.visits) ? result.visits : [];
      const seen = new Set(older ? modalState.visits.map(r => r.id) : []);
      modalState.visits = [...(older ? modalState.visits : []), ...incoming.filter(r => !seen.has(r.id))]
        .filter(r => !result.cutoff_at || r.visited_at >= result.cutoff_at);
      if (!older && Number.isSafeInteger(result.total_requests)) modalState.visitsTotal = result.total_requests;
      modalState.visitsCursor = result.next_cursor || null;
      modalState.visitsLoaded = true;
      modalState.visitsError = '';
    } catch (error) {
      if (epoch !== modalEpoch || !modalState || modalState.person.id !== id) return;
      modalState.visitsError = error.message;
    } finally {
      if (epoch === modalEpoch && modalState && modalState.person.id === id) {
        modalState.visitsBusy = false;
        renderModalContent();
      }
    }
  }

  function resolvePerson(personOrId) {
    if (personOrId == null) return null;
    if (typeof personOrId === 'number' || typeof personOrId === 'string') {
      const id = Number(personOrId);
      return latestAgents.find(a => a.id === id) || null;
    }
    const known = latestAgents.find(a => a.id === personOrId.id);
    if (!known) return { active: 1, username: '', ...personOrId };
    const person = { ...known, ...personOrId, username: known.username || personOrId.username || '', quota: known.quota ?? personOrId.quota ?? null, last_seen_at: known.last_seen_at ?? personOrId.last_seen_at ?? null, active: known.active ?? personOrId.active ?? 1, pending_directives: known.pending_directives ?? personOrId.pending_directives ?? 0, completed_directives: known.completed_directives ?? personOrId.completed_directives ?? 0 };
    for (const field of ['last_inbox_at', 'unfetched_directives', 'oldest_unfetched_directive_at', 'inbox_timeout_seconds', 'inbox_overdue']) {
      if (Object.hasOwn(known, field)) person[field] = known[field];
    }
    return person;
  }

  async function openDetail(personOrId, { focusDirective = false } = {}) {
    if (user()?.role !== 'admin') return;
    const identity = user();
    try { await prepareDetail(); }
    catch (error) { if (user() === identity) notify(error.message, true); return; }
    if (user() !== identity) return;
    const person = resolvePerson(personOrId);
    if (!person || !person.id) return;
    ensureModal();
    modalEpoch++;
    activeAgentId = person.id;
    modalState = {
      person: { ...person },
      quotaLoaded: false,
      quotaBusy: false,
      quotaError: '',
      quota: person.quota || null,
      history: [],
      historyCursor: null,
      historyBusy: false,
      visitsLoaded: false,
      visitsBusy: false,
      visitsError: '',
      visits: [],
      visitsTotal: null,
      visitsCursor: null,
      directivesLoaded: false,
      directivesBusy: false,
      directivesError: '',
      directives: [],
      directivesCounts: {
        pending: Number(person.pending_directives || 0),
        completed: Number(person.completed_directives || 0),
        total: Number(person.pending_directives || 0) + Number(person.completed_directives || 0),
      },
      directivesFilter: 'all',
      directivesCursor: null,
      directiveDraft: '',
      directiveSubmitting: false,
      directiveFormError: '',
      confirmRecallId: null,
      recallingId: null,
      shouldFocusDirective: !!focusDirective,
    };
    modalEl.hidden = false;
    document.body.classList.add('has-modal');
    renderModalContent();
    loadModalDirectives(false);
    loadModalQuota(false);
    loadModalVisits(false);
  }

  function syncAgents(agents) {
    latestAgents = Array.isArray(agents) ? agents : [];
    renderWorkbenchOverview(latestAgents);
    if (activeAgentId != null && modalState) {
      const updated = latestAgents.find(a => a.id === activeAgentId);
      if (updated) {
        modalState.person = { ...updated };
        if (!modalState.quotaLoaded) modalState.quota = updated.quota || null;
        modalState.directivesCounts = {
          pending: Number(updated.pending_directives || 0),
          completed: Number(updated.completed_directives || 0),
          total: Number(updated.pending_directives || 0) + Number(updated.completed_directives || 0),
        };
        renderModalContent();
      }
    }
  }

  function reset() {
    modalEpoch++;
    latestAgents = [];
    closeDetail();
    renderWorkbenchOverview([]);
  }

  return {
    makePill,
    makeDirectiveBadge,
    renderCompactSummary,
    renderWorkbenchOverview,
    openDetail,
    closeDetail,
    syncAgents,
    reset,
  };
}
