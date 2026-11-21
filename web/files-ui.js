// R2 档案中心：集中展示 HTML 网页报告、图片、音视频、PDF 与独立托管档案；
// 同时提供全站共用的安全页内预览弹层（沙盒 iframe / 大图 / 音视频 / 文本）。

const SCOPE_FILTERS = [
  { key: '', label: '全部' },
  { key: 'report', label: '网页报告' },
  { key: 'standalone', label: '独立档案' },
  { key: 'media', label: '媒体图表' },
  { key: 'temp', label: '临时文件' },
];

const SCOPE_LABELS = {
  report: '网页报告',
  standalone: '独立档案',
  media: '媒体图表',
  task: '任务附件',
  temp: '临时文件',
  general: '通用',
};

const FORMAT_OPTIONS = [
  { key: '', label: '全部格式' },
  { key: 'html', label: 'HTML 网页' },
  { key: 'image', label: '图片' },
  { key: 'media', label: '图片与音视频' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'doc', label: 'PDF 与文档' },
];

export function formatBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function baseMime(contentType = '') {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

export function fileCategory(contentType = '', filename = '') {
  const mime = baseMime(contentType);
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  if (mime === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'].includes(ext)) return 'image';
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json' || ['md', 'txt', 'json', 'csv'].includes(ext)) return 'text';
  return 'other';
}

export function fileTypeLabel(contentType = '', filename = '') {
  const cat = fileCategory(contentType, filename);
  const mime = baseMime(contentType);
  if (cat === 'html') return 'HTML';
  if (cat === 'image') return '图片';
  if (cat === 'video') return '视频';
  if (cat === 'audio') return '音频';
  if (cat === 'pdf') return 'PDF';
  if (mime === 'text/markdown') return 'Markdown';
  if (mime === 'application/json') return 'JSON';
  if (mime === 'text/csv') return 'CSV';
  return '文件';
}

export function safeHttpUrl(raw) {
  try {
    const u = new URL(String(raw || ''), location.origin);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

// 从 R2 链接推导同源相对路径，用于在管理台严格 CSP（'self'）下安全地页内预览。
export function r2PreviewPath(item) {
  if (typeof item?.path === 'string' && /^\/api\/files\/f_[A-Za-z0-9_-]{16,}/.test(item.path)) return item.path;
  const raw = typeof item === 'string' ? item : item?.url;
  const match = String(raw || '').match(/(\/api\/files\/f_[A-Za-z0-9_-]{16,}(?:\/[^?#]+)?)/);
  return match ? match[1] : null;
}

export function defaultEmbed(file, url) {
  if (file.markdown_embed) return file.markdown_embed;
  const label = String(file.title || file.filename || '文件').replace(/[\[\]\r\n]/g, ' ').trim();
  const cat = fileCategory(file.content_type, file.filename);
  if (cat === 'image') return `![${label}](${url})`;
  if (cat === 'video') return `![video: ${label}](${url})`;
  if (cat === 'audio') return `![audio: ${label}](${url})`;
  return `[${label}](${url})`;
}

export function createFilesUI({ api, node, button, user, getTasks = () => [], openTask, notify, renderAgentName = null }) {
  const agentName = (name, opts = {}) => renderAgentName ? renderAgentName(name, opts) : node(opts.tag || 'span', name, opts.className || '');
  let files = [];
  let loaded = false;
  let scope = '';
  let format = '';
  let viewMode = 'gallery'; // gallery | grouped | list
  let query = '';
  let ticket = 0;

  async function copyText(text, successMsg) {
    try {
      await navigator.clipboard.writeText(text);
      notify(successMsg);
    } catch {
      notify('浏览器未允许自动复制，请手动打开或复制链接', true);
    }
  }

  // ---- 全站共用页内预览弹层（沙盒 iframe / 大图 / 音视频 / 文本） ----
  let modalEl = null;
  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.getElementById('filePreviewModal');
    if (!modalEl) {
      modalEl = node('div', null, 'preview-modal');
      modalEl.id = 'filePreviewModal';
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('aria-labelledby', 'previewModalTitle');
      modalEl.hidden = true;
      document.body.append(modalEl);
    }
    modalEl.addEventListener('click', event => {
      if (event.target === modalEl) closePreview();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && modalEl && !modalEl.hidden) closePreview();
    });
    return modalEl;
  }

  function closePreview() {
    if (!modalEl || modalEl.hidden) return;
    modalEl.hidden = true;
    modalEl.replaceChildren();
    const otherOpen = ['agentDetailModal', 'floorRefModal'].some(id => {
      const el = document.getElementById(id);
      return el && !el.hidden;
    });
    if (!otherOpen) document.body.classList.remove('has-modal');
  }

  function openPreview(item) {
    const modal = ensureModal();
    const title = String(item?.title || item?.filename || '档案预览');
    const externalUrl = safeHttpUrl(item?.url);
    const localPath = r2PreviewPath(item);
    const cat = fileCategory(item?.content_type, item?.filename || item?.url);
    const previewSrc = localPath || (cat === 'image' || cat === 'video' || cat === 'audio' ? externalUrl : null);

    const dialog = node('div', null, 'preview-dialog');
    const header = node('header', null, 'preview-header');
    const headLeft = node('div', null, 'preview-head-left');
    const titleNode = node('h3', title);
    titleNode.id = 'previewModalTitle';
    const metaNodes = [];
    if (item?.filename && item.filename !== title) metaNodes.push(document.createTextNode(item.filename));
    if (item?.size || item?.size_bytes) metaNodes.push(document.createTextNode(formatBytes(item.size ?? item.size_bytes)));
    if (item?.uploader) {
      const span = node('span', null);
      span.append(document.createTextNode('上传：'), agentName(item.uploader, { id: item.uploader_id }));
      metaNodes.push(span);
    }
    if (item?.revision) metaNodes.push(document.createTextNode(`版本 ${item.revision}`));
    const titleRow = node('div', null, 'preview-title-row');
    titleRow.append(titleNode, node('span', fileTypeLabel(item?.content_type, item?.filename || item?.url), 'badge file-type-badge'));
    headLeft.append(titleRow);
    if (metaNodes.length) {
      const metaP = node('p', null, 'muted preview-meta');
      metaNodes.forEach((part, idx) => {
        if (idx > 0) metaP.append(document.createTextNode(' · '));
        metaP.append(part);
      });
      headLeft.append(metaP);
    }

    const actions = node('div', null, 'preview-actions');
    if (externalUrl) {
      const extLink = node('a', '新窗口打开', 'secondary file-open-btn');
      extLink.href = externalUrl;
      extLink.target = '_blank';
      extLink.rel = 'noopener noreferrer';
      actions.append(extLink);
      actions.append(button('复制链接', () => copyText(externalUrl, '已复制链接'), 'ghost-button'));
    }
    const closeBtn = button('关闭', closePreview, 'secondary');
    actions.append(closeBtn);
    header.append(headLeft, actions);

    const body = node('div', null, 'preview-body');
    if (cat === 'html' && localPath) {
      const frame = node('iframe', null, 'preview-iframe');
      frame.title = title;
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
      frame.src = localPath;
      body.append(frame);
    } else if (cat === 'pdf' && localPath) {
      const frame = node('iframe', null, 'preview-iframe');
      frame.title = title;
      frame.src = localPath;
      body.append(frame);
    } else if (cat === 'image' && previewSrc) {
      const img = node('img', null, 'preview-image');
      img.src = previewSrc;
      img.alt = title;
      body.append(img);
    } else if (cat === 'video' && previewSrc) {
      const video = node('video', null, 'preview-video');
      video.controls = true;
      video.src = previewSrc;
      body.append(video);
    } else if (cat === 'audio' && previewSrc) {
      const wrap = node('div', null, 'preview-audio-wrap');
      const audio = node('audio', null, 'preview-audio');
      audio.controls = true;
      audio.src = previewSrc;
      wrap.append(node('p', title, 'preview-audio-title'), audio);
      body.append(wrap);
    } else if (cat === 'text' && localPath) {
      const pre = node('pre', '正在载入文本内容…', 'preview-text');
      body.append(pre);
      fetch(`${localPath}?format=json`, { credentials: 'same-origin' })
        .then(r => r.json())
        .then(data => { pre.textContent = data?.file?.content ?? '（无可读文本内容）'; })
        .catch(() => { pre.textContent = '无法载入文本预览，请点击上方「新窗口打开」。'; });
    } else {
      const fallback = node('div', null, 'preview-fallback');
      fallback.append(node('p', '该文件为外部地址或暂不支持页内预览，请点击上方「新窗口打开」查看。', 'muted'));
      body.append(fallback);
    }

    dialog.append(header, body);
    modal.replaceChildren(dialog);
    modal.hidden = false;
    document.body.classList.add('has-modal');
    closeBtn.focus();
  }

  function matchesFormat(file, fmt) {
    if (!fmt) return true;
    const cat = fileCategory(file.content_type, file.filename);
    if (fmt === 'media') return ['image', 'video', 'audio'].includes(cat);
    if (fmt === 'doc') return ['pdf', 'text', 'other'].includes(cat);
    return cat === fmt;
  }

  function filtered() {
    const q = query.trim().toLocaleLowerCase();
    const idQ = q.replace(/^#/, '');
    return files.filter(file => {
      if (scope && file.scope !== scope) return false;
      if (!matchesFormat(file, format)) return false;
      if (!q) return true;
      return String(file.task_id || '') === idQ || [file.title, file.filename, file.uploader, file.scope, file.task_title, file.content_type].some(v => String(v || '').toLocaleLowerCase().includes(q));
    });
  }

  function renderStats() {
    const statsEl = document.getElementById('filesStats');
    if (!statsEl) return;
    const totalBytes = files.reduce((sum, f) => sum + (Number(f.size ?? f.size_bytes) || 0), 0);
    const htmlCount = files.filter(f => fileCategory(f.content_type, f.filename) === 'html').length;
    const mediaCount = files.filter(f => ['image', 'video', 'audio'].includes(fileCategory(f.content_type, f.filename))).length;
    const otherCount = Math.max(0, files.length - htmlCount - mediaCount);

    const cards = [
      { label: '全部档案', value: String(files.length), sub: formatBytes(totalBytes), active: !scope && !format, onClick: () => { scope = ''; format = ''; render(); } },
      { label: '网页报告', value: String(htmlCount), sub: 'HTML 可交互报告', active: format === 'html' && !scope, onClick: () => { scope = ''; format = 'html'; render(); } },
      { label: '图片与多媒体', value: String(mediaCount), sub: '图片 / 视频 / 音频', active: format === 'media' && !scope, onClick: () => { scope = ''; format = 'media'; render(); } },
      { label: '文档与其他', value: String(otherCount), sub: 'PDF / 文本 / 数据', active: format === 'doc' && !scope, onClick: () => { scope = ''; format = 'doc'; render(); } },
    ];
    statsEl.replaceChildren(...cards.map(c => {
      const btn = button('', c.onClick, `stat-card file-stat-card${c.active ? ' is-selected' : ''}`);
      const left = node('span', null, 'file-stat-meta');
      left.append(node('span', c.label, 'stat-label'), node('small', c.sub, 'muted'));
      btn.append(left, node('strong', c.value, 'stat-value'));
      return btn;
    }));
  }

  function buildActions(file, card, { compact = false } = {}) {
    const me = user();
    const isAdmin = me?.role === 'admin';
    const actions = node('div', null, 'file-card-actions');
    const url = safeHttpUrl(file.url);
    const localPath = r2PreviewPath(file);
    const cat = fileCategory(file.content_type, file.filename);
    const canPreview = !!localPath || ['image', 'video', 'audio'].includes(cat);

    if (canPreview) {
      actions.append(button('预览', () => openPreview(file), 'primary file-preview-btn'));
    }
    if (url) {
      const openLink = node('a', '打开', 'secondary file-open-btn');
      openLink.href = url;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      actions.append(openLink);
      actions.append(button(compact ? '链接' : '复制链接', () => copyText(url, '已复制文件链接'), 'ghost-button'));
      actions.append(button(compact ? 'MD' : '复制 Markdown', () => copyText(defaultEmbed(file, url), '已复制 Markdown 引用'), 'ghost-button'));
    }
    if (isAdmin || (me?.id && file.uploader_id === me.id)) {
      actions.append(button('删除', () => {
        card.querySelector('.file-delete-confirm')?.remove();
        const confirmBox = node('div', null, 'account-confirm file-delete-confirm');
        const errEl = node('p', '', 'error');
        const row = node('div', null, 'action-row');
        row.append(
          button('确认删除', async () => {
            errEl.textContent = '';
            try {
              await api(`/api/files/${encodeURIComponent(file.id)}`, 'DELETE');
              files = files.filter(item => item.id !== file.id);
              notify('档案已删除');
              render();
            } catch (cause) { errEl.textContent = cause.message; }
          }, 'danger'),
          button('取消', () => confirmBox.remove(), 'secondary')
        );
        confirmBox.append(node('p', `确定删除「${file.title || file.filename}」？删除后外链将立即失效。`), row, errEl);
        card.append(confirmBox);
      }, 'danger'));
    }
    return actions;
  }

  function buildMetaLine(file) {
    const meta = node('div', null, 'file-card-meta');
    const infoSpan = node('span', null);
    const chunks = [];
    if (file.filename && file.filename !== file.title) chunks.push(document.createTextNode(file.filename));
    chunks.push(document.createTextNode(formatBytes(file.size ?? file.size_bytes)));
    if (file.uploader) chunks.push(agentName(file.uploader, { id: file.uploader_id }));
    if (file.created_at && Number.isFinite(Date.parse(file.created_at))) {
      chunks.push(document.createTextNode(new Date(file.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    }
    chunks.forEach((part, idx) => {
      if (idx > 0) infoSpan.append(document.createTextNode(' · '));
      infoSpan.append(part);
    });
    meta.append(infoSpan);
    if (file.task_id) {
      const label = file.task_title ? `任务 #${file.task_id} · ${Array.from(file.task_title).slice(0, 18).join('')}${file.task_title.length > 18 ? '…' : ''}` : `任务 #${file.task_id}`;
      meta.append(button(label, () => openTask(file.task_id, { tab: 'outcome' }), 'text-button file-task-link'));
    }
    return meta;
  }

  function buildGalleryCard(file) {
    const card = node('article', null, 'file-gallery-card');
    const cat = fileCategory(file.content_type, file.filename);
    const previewSrc = r2PreviewPath(file) || safeHttpUrl(file.url);

    // 顶部视觉预览区
    const stage = node('div', null, `file-thumb is-${cat}`);
    if (cat === 'image' && previewSrc) {
      const img = node('img', null, 'file-thumb-img');
      img.src = previewSrc;
      img.alt = file.title || file.filename;
      img.loading = 'lazy';
      img.addEventListener('click', () => openPreview(file));
      stage.append(img);
    } else if (cat === 'video' && previewSrc) {
      const video = node('video', null, 'file-thumb-video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = previewSrc;
      stage.append(video);
    } else if (cat === 'audio' && previewSrc) {
      const wrap = node('div', null, 'file-thumb-audio');
      wrap.append(node('span', '音频档案', 'file-thumb-kind'));
      const audio = node('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = previewSrc;
      wrap.append(audio);
      stage.append(wrap);
    } else {
      const cover = node('button', null, 'file-thumb-cover');
      cover.type = 'button';
      cover.addEventListener('click', () => openPreview(file));
      cover.append(
        node('span', fileTypeLabel(file.content_type, file.filename), 'file-cover-badge'),
        node('span', file.filename || file.title, 'file-cover-name'),
        node('small', cat === 'html' ? '点击页内预览 HTML 报告' : '点击预览文件', 'muted')
      );
      stage.append(cover);
    }

    const body = node('div', null, 'file-gallery-body');
    const head = node('div', null, 'file-card-head');
    head.append(
      node('strong', file.title || file.filename, 'file-card-title'),
      node('span', SCOPE_LABELS[file.scope] || file.scope || '通用', 'badge task-type')
    );
    body.append(head, buildMetaLine(file), buildActions(file, card, { compact: true }));
    card.append(stage, body);
    return card;
  }

  function buildListRow(file) {
    const card = node('article', null, 'file-card');
    const cat = fileCategory(file.content_type, file.filename);
    const previewSrc = r2PreviewPath(file) || safeHttpUrl(file.url);
    if (cat === 'image' && previewSrc) {
      const mini = node('img', null, 'file-mini-thumb');
      mini.src = previewSrc;
      mini.alt = file.title || file.filename;
      mini.loading = 'lazy';
      mini.addEventListener('click', () => openPreview(file));
      card.append(mini);
    }
    const main = node('div', null, 'file-card-main');
    const head = node('div', null, 'file-card-head');
    head.append(
      node('strong', file.title || file.filename, 'file-card-title'),
      node('span', fileTypeLabel(file.content_type, file.filename), 'badge file-type-badge'),
      node('span', SCOPE_LABELS[file.scope] || file.scope || '通用', 'badge task-type')
    );
    main.append(head, buildMetaLine(file));
    card.append(main, buildActions(file, card));
    return card;
  }

  function renderGrouped(listEl, rows) {
    const byTask = new Map();
    const standalone = [];
    for (const file of rows) {
      if (file.task_id) {
        if (!byTask.has(file.task_id)) byTask.set(file.task_id, { id: file.task_id, title: file.task_title || `任务 #${file.task_id}`, files: [] });
        byTask.get(file.task_id).files.push(file);
      } else {
        standalone.push(file);
      }
    }
    const groups = [...byTask.values()].sort((a, b) => b.id - a.id);
    if (standalone.length) groups.push({ id: null, title: '独立上传档案（未关联任务）', files: standalone });

    listEl.className = 'files-grouped';
    for (const group of groups) {
      const section = node('section', null, 'file-group');
      const header = node('div', null, 'file-group-head');
      const left = node('div', null, 'file-group-title');
      left.append(
        node('h3', group.id ? `任务 #${group.id} · ${group.title}` : group.title),
        node('span', `${group.files.length} 个档案`, 'count')
      );
      header.append(left);
      if (group.id) {
        header.append(button('查看任务成果 →', () => openTask(group.id, { tab: 'outcome' }), 'text-button'));
      }
      const grid = node('div', null, 'files-gallery');
      for (const file of group.files) grid.append(buildGalleryCard(file));
      section.append(header, grid);
      listEl.append(section);
    }
  }

  function syncUploadTasks() {
    const select = document.getElementById('uploadFileTask');
    if (!select) return;
    const prev = select.value;
    select.replaceChildren(new Option('不关联任务（独立档案）', ''));
    for (const task of getTasks().slice(0, 60)) {
      select.add(new Option(`#${task.id} · ${Array.from(task.title || '').slice(0, 32).join('')}`, String(task.id)));
    }
    if (prev) select.value = prev;
  }

  function render() {
    const listEl = document.getElementById('filesList');
    const countEl = document.getElementById('filesCount');
    const chipsEl = document.getElementById('filesScopeChips');
    const fmtEl = document.getElementById('filesFormatFilter');
    if (!listEl || !countEl || !chipsEl) return;

    renderStats();
    syncUploadTasks();

    const uploadBox = document.getElementById('uploadFileBox');
    if (uploadBox) uploadBox.hidden = !['admin', 'publisher'].includes(user()?.role);

    chipsEl.replaceChildren(...SCOPE_FILTERS.map(item => {
      const active = scope === item.key;
      const chip = node('button', item.label, `channel-chip${active ? ' active' : ''}`);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(active));
      chip.addEventListener('click', () => { scope = item.key; render(); });
      return chip;
    }));

    if (fmtEl && fmtEl.value !== format) fmtEl.value = format;
    for (const btn of document.querySelectorAll('[data-files-view]')) {
      const active = btn.dataset.filesView === viewMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }

    const rows = filtered();
    countEl.textContent = `${rows.length} 个`;
    listEl.replaceChildren();

    if (!loaded) {
      listEl.className = 'files-list';
      listEl.append(node('p', '正在载入 R2 档案…', 'muted files-empty'));
      return;
    }
    if (!rows.length) {
      listEl.className = 'files-list';
      listEl.append(node('p', files.length ? '没有符合筛选条件的档案。' : '还没有上传到 R2 的档案。Agent 发布网页报告或调用 /api/files 上传后会自动集中展示在这里。', 'muted files-empty'));
      return;
    }

    if (viewMode === 'grouped') {
      renderGrouped(listEl, rows);
    } else if (viewMode === 'list') {
      listEl.className = 'files-list';
      for (const file of rows) listEl.append(buildListRow(file));
    } else {
      listEl.className = 'files-gallery';
      for (const file of rows) listEl.append(buildGalleryCard(file));
    }
  }

  function wire() {
    const searchEl = document.getElementById('filesSearch');
    if (searchEl && !searchEl.dataset.wired) {
      searchEl.dataset.wired = '1';
      searchEl.addEventListener('input', () => { query = searchEl.value; render(); });
    }
    const fmtEl = document.getElementById('filesFormatFilter');
    if (fmtEl && !fmtEl.dataset.wired) {
      fmtEl.dataset.wired = '1';
      fmtEl.replaceChildren(...FORMAT_OPTIONS.map(o => new Option(o.label, o.key)));
      fmtEl.addEventListener('change', () => { format = fmtEl.value; render(); });
    }
    for (const btn of document.querySelectorAll('[data-files-view]')) {
      if (btn.dataset.wired) continue;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => { viewMode = btn.dataset.filesView; render(); });
    }
    const refreshBtn = document.getElementById('filesRefresh');
    if (refreshBtn && !refreshBtn.dataset.wired) {
      refreshBtn.dataset.wired = '1';
      refreshBtn.addEventListener('click', () => refresh({ force: true }));
    }
    const uploadForm = document.getElementById('uploadFileForm');
    if (uploadForm && !uploadForm.dataset.wired) {
      uploadForm.dataset.wired = '1';
      uploadForm.addEventListener('submit', async event => {
        event.preventDefault();
        const send = uploadForm.querySelector('button[type="submit"]');
        const errEl = document.getElementById('uploadFileError');
        if (errEl) errEl.textContent = '';
        const formData = new FormData(uploadForm);
        const picked = formData.get('file');
        if (!picked || !picked.size) { if (errEl) errEl.textContent = '请先选择要上传的文件'; return; }
        send.disabled = true;
        try {
          const response = await fetch('/api/files', { method: 'POST', credentials: 'same-origin', body: formData });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || `上传失败（${response.status}）`);
          uploadForm.reset();
          const box = document.getElementById('uploadFileBox');
          if (box) box.open = false;
          notify(`已上传到 R2：${data.filename || picked.name}`);
          await refresh({ force: true });
        } catch (error) {
          if (errEl) errEl.textContent = error.message;
        } finally {
          send.disabled = false;
        }
      });
    }
  }

  async function refresh({ force = false } = {}) {
    wire();
    if (!force && loaded && files.length) render();
    const currentTicket = ++ticket, me = user();
    try {
      const data = await api('/api/files?limit=100');
      if (currentTicket !== ticket || user() !== me) return;
      files = data.files || [];
      loaded = true;
      render();
    } catch (error) {
      if (currentTicket !== ticket || user() !== me) return;
      loaded = true;
      const listEl = document.getElementById('filesList');
      if (listEl) {
        listEl.className = 'files-list';
        listEl.replaceChildren(node('p', `无法载入 R2 档案：${error.message}`, 'error'));
      }
    }
  }

  function reset() {
    ticket++;
    files = [];
    loaded = false;
    scope = '';
    format = '';
    viewMode = 'gallery';
    query = '';
    closePreview();
    const searchEl = document.getElementById('filesSearch');
    if (searchEl) searchEl.value = '';
    document.getElementById('filesStats')?.replaceChildren();
    document.getElementById('filesList')?.replaceChildren();
  }

  return { refresh, render, reset, openPreview, closePreview };
}
