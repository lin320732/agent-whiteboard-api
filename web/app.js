import { GOALS, legacyGoal, legacyType } from './task-model.js';
import { createPlanEditor } from './task-plan-ui.js';
import { createWorkbench } from './workbench.js';

const $ = id => document.getElementById(id);
const state = { user: null, channels: [], channelId: '', allTasks: [], tasks: [], outcomeTasks: [], selected: null, detail: null, view: 'home', outcomeSelected: null, outcomeDetail: null, detailTab: null, conversationSort: 'desc', conversationFilter: {taskId: null, value: 'all'}, conversationVisible: {taskId: null, count: 10}, reading: {tasks: false, outcomes: false}, settings: 'guide', home: null };
let detailRequest = 0;
let outcomeRequest = 0;
let refreshRequest = 0;
let foregroundRefresh = 0;
let taskListETag = null;
let participantsRequest = null;
let participantsUser = null;
let agentsRequest = null;
let messagesRequest = 0;
const viewRequests = new Map();
const statusText = { open: "待认领", in_progress: "进行中", review: "待核对", proposed: "待审批", done: "已完成", closed: "已关闭" };
const taskType = task => task.plan?.goal || task.goal || legacyGoal(task.type);
const taskKind = task => taskType(task) === 'active_debate' ? 'active_debate' : (task.plan?.delivery?.format === 'web_report' || !!task.report ? 'web_report' : 'normal');
const taskStatus = task => taskType(task)==='active_debate'&&task.status==='open'?'激辩开放':statusText[task.status]||task.status;
const typeBadge = task => {
  const kind = taskKind(task);
  if (kind === 'active_debate') return node('span', '激辩', 'badge task-type active_debate');
  if (kind === 'web_report') return node('span', '网页报告', 'badge task-type web-report');
  const goal = taskType(task);
  return node('span', GOALS[goal] || goal, `badge task-type ${goal}`);
};
const roleText = { admin: "管理员", publisher: "发布者", viewer: "只读成员", agent: "Agent" };
// 成果视图只收纳「已提交成果」与「已完成」两类任务。
const OUTCOME_STATUS = ['review', 'done'];
const VIEW_META = {
  home: { title: '工作台', hint: '先处理需要你决定的事，再看最新成果。' },
  tasks: { title: '任务', hint: '管理普通任务、网页报告与激辩议题。' },
  outcomes: { title: '成果', hint: '先看最终成果与版本演进，来源与旧版摘要按需展开。' },
  files: { title: '档案', hint: '集中浏览与管理 R2 托管的 HTML 报告、图片、音视频与文档。' },
  community: { title: '讨论区', hint: '频道留言板：记录白板问题、反馈与 AI 资讯。' },
  settings: { title: '管理与工具', hint: '成员、Agent 与工作指南。' },
};

function syncCreateMode(mode) {
  const isDebate = mode === 'debate';
  const deadlineField = $('taskDeadlineField');
  const basicRow = $('taskBasicRow');
  if (deadlineField) deadlineField.hidden = isDebate;
  if (basicRow) basicRow.classList.toggle('is-single', isDebate);
  const form = $('taskForm');
  const titleInput = form?.elements?.namedItem('title');
  const detailInput = form?.elements?.namedItem('detail');
  if (titleInput) titleInput.placeholder = isDebate ? '提出一个值得挑战的观点或议题' : '简明描述任务目标';
  if (detailInput) detailInput.placeholder = isDebate ? '补充背景、争议焦点或希望挑战的假设' : '补充背景、约束条件或参考资料';
}

let planAuthors = [];
let adminAgents = [];
let lastMessages = null;
function findAgent({ id = null, name = "" } = {}) {
  const numericId = Number(id);
  const validId = Number.isSafeInteger(numericId) && numericId > 0 ? numericId : null;
  const label = String(name || "").trim();
  const pools = [adminAgents, planAuthors];
  if (validId) {
    for (const pool of pools) {
      const hit = pool.find(a => Number(a?.id) === validId);
      if (hit) return hit;
    }
  }
  if (label) {
    for (const pool of pools) {
      const hit = pool.find(a => a && (a.name === label || a.username === label));
      if (hit) return hit;
    }
  }
  return null;
}
function renderAgentName(name, { id = null, role = null, className = "", tag = "span", prefix = "" } = {}) {
  const label = String(name || "").trim();
  const text = prefix ? `${prefix}${label}` : label;
  if (state.user?.role === "admin" && role !== "human" && label) {
    const resolved = findAgent({ id, name: label }) || (Number.isSafeInteger(Number(id)) && Number(id) > 0 && role === "agent" ? { id: Number(id), name: label, active: 1 } : null);
    if (resolved && resolved.id) {
      const btn = node("button", text, `agent-name-trigger${className ? ` ${className}` : ""}`);
      btn.type = "button";
      btn.dataset.agentId = String(resolved.id);
      btn.dataset.agentName = resolved.name || label;
      btn.title = `点击查看 ${resolved.name || label} 的信息并下达留言`;
      btn.setAttribute("aria-label", `查看 Agent ${resolved.name || label} 的信息并下达留言`);
      btn.addEventListener("click", event => {
        event.stopPropagation();
        openAgentDetail(resolved).catch(error => notify(error.message, true));
      });
      return btn;
    }
  }
  return node(tag, text, className);
}
function mountCreatePlanEditor() {
  const editor = createPlanEditor({
    node,
    authors: planAuthors,
    allowHost: state.user?.role === 'admin',
    onModeChange: syncCreateMode,
  });
  $('taskModeBar').replaceChildren(editor.modeBar);
  $('taskPlanFields').replaceChildren(editor.root);
  syncCreateMode(editor.getMode());
  return editor;
}
let taskPlanEditor = mountCreatePlanEditor();

// Optional interfaces initialize once; their data is fetched when opened.
let filesUI, readingUI, outcomeView, workUI, guideUI, visitsUI, quotasUI, floorRefsUI;
let renderTaskRoles, renderTaskFlow, extractFloorRefIds, compactFloorPreview, normalizeStanceLabel, stanceTagClass;
function lazy(load) {
  let pending;
  return () => pending ||= load().catch(error => { pending = null; throw error; });
}
function applyParticipants(authors) {
  planAuthors = authors;
  taskPlanEditor.setAuthors(authors);
  if (state.user?.role === "admin" && state.view === "community" && lastMessages) renderMessages(lastMessages);
}
const openPreview = async (...args) => {
  const user = state.user;
  try {
    await ensureFilesUI();
    if (state.user === user) return filesUI.openPreview(...args);
  } catch (error) { if (state.user === user) notify(error.message, true); }
};
const ensureFilesUI = lazy(async () => {
  const { createFilesUI } = await import('./files-ui.js');
  filesUI = createFilesUI({ api, node, button, user: () => state.user, getTasks: () => state.allTasks, openTask, notify, renderAgentName });
});
const ensureReadingUI = lazy(async () => {
  const { createReadingUI } = await import('./reading.js');
  readingUI = createReadingUI({ node, openPreview });
});
const ensureQuotasUI = lazy(async () => {
  const { createAgentQuotasUI } = await import('./agent-quotas.js');
  quotasUI = createAgentQuotasUI({
    api, node, button, user: () => state.user, notify,
    openAccounts: () => showSettings('accounts'),
    prepareDetail: ensureReadingUI,
    linkedText,
    sources: (...args) => readingUI.sources(...args),
    onDirectivesChanged: (agentId, counts, inboxStatus) => {
      if (counts) {
        adminAgents = adminAgents.map(a => a.id === agentId ? { ...a, ...inboxStatus, pending_directives: Number(counts.pending || 0), completed_directives: Number(counts.completed || 0) } : a);
        const person = adminAgents.find(a => a.id === agentId);
        if (person) syncAgentAccountSummary(person);
      }
    },
  });
});
const ensureAccountsUI = lazy(async () => {
  const [{ createAgentVisitsUI }] = await Promise.all([import('./agent-visits.js'), ensureQuotasUI()]);
  visitsUI = createAgentVisitsUI({ api, node, user: () => state.user });
});
const ensureGuideUI = lazy(async () => {
  const [{ createAgentGuideUI }] = await Promise.all([import('./agent-guide.js'), ensureReadingUI()]);
  guideUI = createAgentGuideUI({ api, node, button, markdown: readingUI.markdown, user: () => state.user, notify, loadAgents: fetchAdminAgents });
});
const ensureTaskUI = lazy(async () => {
  const [collaboration, outcome, refs, roles, flow] = await Promise.all([
    import('./collaboration.js'), import('./outcome-view.js'), import('./floor-refs.js'),
    import('./task-roles.js'), import('./task-flow.js'), ensureReadingUI(),
  ]);
  ({ renderTaskRoles } = roles);
  ({ renderTaskFlow } = flow);
  ({ extractFloorRefIds, compactFloorPreview, normalizeStanceLabel, stanceTagClass } = refs);
  outcomeView = outcome.createOutcomeView({ node, button, linkedText, sources: readingUI.sources, api, openPreview, notify, openFiles: () => showView('files'), renderAgentName });
  workUI = collaboration.createCollaborationUI({ api, node, linkedText, button, user: () => state.user, selectTask: openTask, renderAgentName, onParticipants: applyParticipants });
  workUI.setParticipants(planAuthors);
  floorRefsUI = refs.createFloorRefsUI({ node, flash, renderMarkdown: readingUI.markdown, renderSources: readingUI.sources, renderAgentName });
});
async function openAgentDetail(person, options) {
  const user = state.user;
  await ensureQuotasUI();
  if (state.user === user) return quotasUI.openDetail(person, options);
}
const workbench = createWorkbench({node, button, openTask, openOutcome, showTasks: status => { if (status != null) { $('statusFilter').value = status; renderTasks(); } showView('tasks'); }, showOutcomes: () => showView('outcomes')});

function node(tag, value = "", className = "") {
  const element = document.createElement(tag);
  if (value != null) element.textContent = String(value);
  if (className) element.className = className;
  return element;
}
function add(parent, ...children) { parent.append(...children); return parent; }

function linkedText(value, className = "", options) {
  return readingUI.text(value, className, options);
}
function clear(element) { element.replaceChildren(); return element; }
function visible(id, yes) { $(id).hidden = !yes; }
function notify(message, error = false) {
  const target = $("notice");
  target.textContent = message;
  target.classList.toggle("error-notice", error);
  target.hidden = false;
  if (!error) setTimeout(() => { if (target.textContent === message) target.hidden = true; }, 5000);
}
// 引用跳转：滚动到原发言并短暂高亮，不依赖复杂关系图。
function flash(element) {
  if (!element) return;
  element.hidden = false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  element.scrollIntoView({ block: "center" });
  element.classList.remove("flash");
  void element.offsetWidth;
  element.classList.add("flash");
  clearTimeout(element.flashTimer);
  element.flashTimer = setTimeout(() => element.classList.remove("flash"), 1800);
}
async function api(path, method = "GET", body, {etag} = {}) {
  const requestedUser = state.user;
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(etag ? { "If-None-Match": etag } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 304 && etag) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user === requestedUser && !path.includes("/auth/login")) showLogin();
    const error=new Error(data.error || `请求失败（${response.status}）`);error.status=response.status;throw error;
  }
  return etag === undefined ? data : {...data, etag: response.headers.get("ETag")};
}

// ---- 主导航与浏览器历史：手机一次只显示列表或详情。----
const navTabs = [...document.querySelectorAll('.nav-tab')];
const VIEW_PANELS = { home: $('viewHome'), tasks: $('viewTasks'), outcomes: $('viewOutcomes'), files: $('viewFiles'), community: $('viewCommunity'), settings: $('viewSettings') };
let historyReady = false;
history.scrollRestoration = 'manual';
function navigationState() {
  return {view: state.view, reading: {...state.reading}, taskId: state.selected, outcomeId: state.outcomeSelected, tab: state.detailTab?.key || 'overview', settings: state.settings,
    status: $('statusFilter').value, kind: $('taskKindFilter').value, channel: state.channelId, search: $('taskSearch').value, sort: $('taskSort').value,
    scroll: window.scrollY, listScroll: $('taskList').scrollTop, outcomeScroll: [...document.querySelectorAll('.outcome-list')].map(list => list.scrollTop)};
}
function locationHash() {
  if (state.view === 'tasks' && state.reading.tasks && state.selected) return `#tasks/${state.selected}/${state.detailTab?.key || 'overview'}`;
  if (state.view === 'outcomes' && state.reading.outcomes && state.outcomeSelected) return `#outcomes/${state.outcomeSelected}`;
  if (state.view === 'settings') return `#settings/${state.settings}`;
  return `#${state.view}`;
}
function saveNavigation() {
  if (historyReady) history.replaceState({whiteboard: navigationState(), canBack: !!history.state?.canBack}, '', location.href);
}
function recordNavigation(replace = false) {
  if (!historyReady) return;
  const hash = locationHash(), same = location.hash === hash;
  history[replace || same ? 'replaceState' : 'pushState']({whiteboard: navigationState(), canBack: replace || same ? !!history.state?.canBack : true}, '', hash);
}
function syncReaders() {
  for (const [view, reading] of Object.entries(state.reading)) VIEW_PANELS[view].classList.toggle('is-reading', reading);
}
function showView(name, { focusTab = false, record = true, load = true } = {}) {
  if (!VIEW_PANELS[name]) name = 'home';
  if (record) {
    saveNavigation();
    if (name in state.reading) state.reading[name] = false;
  }
  state.view = name;
  $('workspaceMenu').open = false;
  if (name !== 'tasks') { $('createTaskBox').open = false; floorRefsUI?.reset(); }
  if (name !== 'community') $('createChannelBox').open = false;
  if (name !== 'files') { const u = $('uploadFileBox'); if (u) u.open = false; }
  for (const tab of navTabs) {
    const active = tab.dataset.view === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active || (name === 'settings' && tab === navTabs[0]) ? 0 : -1;
  }
  for (const [key, panel] of Object.entries(VIEW_PANELS)) panel.hidden = key !== name;
  $('viewTitle').textContent = VIEW_META[name].title;
  $('viewHint').textContent = VIEW_META[name].hint;
  syncReaders();
  if (record) { recordNavigation(); window.scrollTo(0, 0); }
  if (load && name !== 'settings') loadView().catch(error => notify(error.message, true));
  if (focusTab) navTabs.find(tab => tab.dataset.view === name)?.focus();
}
function wireNav(tabs, onPick) {
  tabs.forEach(tab => {
    tab.addEventListener('click', () => onPick(tab));
    tab.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      let next = null;
      const available = tabs.filter(item => !item.hidden), index = available.indexOf(tab);
      if (step) next = available[(index + step + available.length) % available.length];
      else if (event.key === 'Home') next = available[0];
      else if (event.key === 'End') next = available[available.length - 1];
      if (!next) return;
      event.preventDefault();
      onPick(next, { focusTab: true });
    });
  });
}
wireNav(navTabs, (tab, options) => showView(tab.dataset.view, options));

function showSettings(name, {record = true} = {}) {
  if (!['accounts', 'guide'].includes(name) || (name === 'accounts' && state.user?.role !== 'admin')) name = 'guide';
  if (record) saveNavigation();
  state.settings = name;
  showView('settings', {record: false, load: false});
  for (const tab of document.querySelectorAll('.settings-tab[data-settings]')) {
    const selected = tab.dataset.settings === name;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    tab.classList.toggle('active', selected);
  }
  $('adminPanel').hidden = name !== 'accounts';
  $('agentGuidePanel').hidden = name !== 'guide';
  $('workspaceMenu').open = false;
  if (record) { recordNavigation(); window.scrollTo(0, 0); }
  loadView().catch(error => notify(error.message, true));
}
for (const control of document.querySelectorAll('#workspaceMenu [data-settings]')) control.addEventListener('click', () => showSettings(control.dataset.settings));
wireNav([...document.querySelectorAll('.settings-tab[data-settings]')], tab => {showSettings(tab.dataset.settings); tab.focus();});
for (const control of document.querySelectorAll('[data-view-link]')) control.addEventListener('click', () => showView(control.dataset.viewLink));
function backToList(view) {
  if (history.state?.canBack) history.back();
  else showView(view);
}
$('taskBack').addEventListener('click', () => backToList('tasks'));
$('outcomeBack').addEventListener('click', () => backToList('outcomes'));

function routeFromHash() {
  const [view = 'home', id, tab] = location.hash.slice(1).split('/');
  if (view === 'outcomes' && id === 'files') return { view: 'files', reading: {tasks: false, outcomes: false}, tab: 'overview' };
  const route = {view: VIEW_PANELS[view] ? view : 'home', reading: {tasks: false, outcomes: false}, tab: ['overview', 'outcome', 'review', 'conversation'].includes(tab) ? tab : 'overview'};
  if (view === 'settings') route.settings = id;
  else if (['tasks', 'outcomes'].includes(view) && /^\d+$/.test(id || '')) {
    route.reading[view] = true;
    route[view === 'tasks' ? 'taskId' : 'outcomeId'] = Number(id);
  }
  return route;
}
async function restoreNavigation(route) {
  if (route.status != null) $('statusFilter').value = route.status;
  if (route.kind != null) $('taskKindFilter').value = route.kind;
  if (route.channel != null) state.channelId = route.channel;
  if (route.search != null) $('taskSearch').value = route.search;
  if (['asc', 'desc'].includes(route.sort)) $('taskSort').value = route.sort;
  state.reading = {...state.reading, ...route.reading};
  showView(route.view, {record: false});
  renderChannels(); renderTasks();
  if (route.view === 'settings') showSettings(route.settings, {record: false});
  if (route.reading?.tasks && route.taskId) {
    state.detailTab = {taskId: route.taskId, key: route.tab || 'overview'};
    await selectTask(route.taskId, {tab: route.tab || 'overview'});
  }
  if (route.reading?.outcomes && route.outcomeId) await openOutcome(route.outcomeId, {silent: true});
  requestAnimationFrame(() => {
    $('taskList').scrollTop = route.listScroll || 0;
    document.querySelectorAll('.outcome-list').forEach((list, i) => {list.scrollTop = route.outcomeScroll?.[i] || 0;});
    window.scrollTo(0, route.scroll || 0);
  });
}
window.addEventListener('popstate', () => {if (state.user) restoreNavigation(history.state?.whiteboard || routeFromHash()).catch(error => notify(error.message, true));});

// 轻量分区 tab：概览 / 成果 / 核查 / 讨论。
function detailTabs(items, label, { initial = null, onChange = null } = {}) {
  const wrap = node('div', null, 'detail-tabset');
  const list = node('div', null, 'detail-tabs');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', label);
  const panels = new Map(), buttons = new Map();
  const keys = items.map(item => item.key);
  function select(key, focus = false) {
    if (!panels.has(key)) return;
    for (const [name, button] of buttons) {
      const active = name === key;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      panels.get(name).hidden = !active;
    }
    if (focus) buttons.get(key)?.focus();
    onChange?.(key);
  }
  items.forEach((item, index) => {
    const tab = node('button', null, 'detail-tab');
    tab.type = 'button';
    tab.id = `detailTab-${item.key}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `detailPanel-${item.key}`);
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = -1;
    add(tab, node('span', item.label));
    if (item.count) add(tab, node('span', String(item.count), 'tab-count'));
    tab.addEventListener('click', () => select(item.key));
    tab.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      let next = null;
      if (step) next = keys[(index + step + keys.length) % keys.length];
      else if (event.key === 'Home') next = keys[0];
      else if (event.key === 'End') next = keys[keys.length - 1];
      if (!next) return;
      event.preventDefault();
      select(next, true);
    });
    buttons.set(item.key, tab);
    add(list, tab);
  });
  const panelsBox = node('div', null, 'detail-panels');
  for (const item of items) {
    const panel = node('div', null, 'detail-panel');
    panel.id = `detailPanel-${item.key}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `detailTab-${item.key}`);
    panel.tabIndex = 0;
    panel.hidden = true;
    panels.set(item.key, panel);
    add(panelsBox, panel);
  }
  add(wrap, list, panelsBox);
  select(initial && panels.has(initial) ? initial : items[0].key);
  return { root: wrap, panel: key => panels.get(key), select };
}

function showLogin() {
  state.user = null;
  adminAgents = [];
  planAuthors = [];
  lastMessages = null;
  taskListETag = null;
  participantsRequest = participantsUser = agentsRequest = null;
  messagesRequest++;
  viewRequests.clear();
  for (const element of document.querySelectorAll('[aria-busy]')) element.removeAttribute('aria-busy');
  historyReady = false;
  refreshRequest++;
  outcomeRequest++;
  resetTaskReader();
  state.outcomeSelected = null;
  state.outcomeDetail = null;
  workUI?.reset();
  guideUI?.reset();
  visitsUI?.reset();
  quotasUI?.reset();
  floorRefsUI?.reset();
  filesUI?.reset();
  resetOutcomeReader();
  state.tasks = [];
  state.allTasks = [];
  state.channels = [];
  state.outcomeTasks = [];
  state.channelId = "";
  state.detailTab = null;
  state.view = 'home';
  state.reading = {tasks: false, outcomes: false};
  state.home = null;
  state.conversationSort = 'desc';
  state.conversationFilter = {taskId: null, value: 'all'};
  state.conversationVisible = {taskId: null, count: 10};
  $('statusFilter').value = 'active';
  $('taskKindFilter').value = '';
  $('taskSearch').value = '';
  $('taskSort').value = 'desc';
  $('workspaceMenu').open = false;
  clear($("messages"));
  clear($('users')); clear($('agents')); renderChannels();
  workbench.render([], null, null);
  renderTasks();
  visible("workspace", false);
  visible("primaryNav", false);
  visible("topbarTools", false);
  visible("identity", false);
  visible("loginView", true);
  const issued = clear($("issuedSecrets"));
  issued.hidden = true;
  delete issued.dataset.accountId;
}
function showBoard(user) {
  state.user = user;
  try {
    const savedSort = localStorage.getItem(`whiteboard.taskSort.${user.id}`);
    $('taskSort').value = savedSort === 'asc' ? 'asc' : 'desc';
    state.conversationSort = localStorage.getItem(`whiteboard.conversationSort.${user.id}`) === 'asc' ? 'asc' : 'desc';
  } catch { $('taskSort').value = 'desc'; state.conversationSort = 'desc'; }
  $("signedInAs").textContent = `${user.name} · ${roleText[user.role] || user.role}`;
  visible("loginView", false);
  visible("primaryNav", true);
  visible("topbarTools", true);
  visible("identity", true);
  visible("workspace", true);
  visible("accountsMenu", user.role === "admin");
  visible("settings-accounts", user.role === "admin");
  visible("createChannelBox", user.role === "admin");
  visible("createTaskBox", user.role === "admin" || user.role === "publisher");
  visible("messageForm", user.role === "admin" || user.role === "publisher");
  taskPlanEditor = mountCreatePlanEditor();
  showView(state.view, {record: false, load: false});
}
function button(label, onClick, className = "secondary") {
  const element = node("button", label, className);
  element.type = "button";
  element.addEventListener("click", async () => {
    element.disabled = true;
    try { await onClick(); } catch (error) { notify(error.message, true); }
    finally { element.disabled = false; }
  });
  return element;
}
function entry(title, content, time, badgeText = '') {
  const card = node("div", null, "entry");
  const header = node("header");
  const left = node('div', null, 'entry-title-group');
  if (typeof title === "string") add(left, node("strong", title));
  else if (Array.isArray(title)) add(left, ...title);
  else if (title) add(left, title);
  if (badgeText) add(left, node('span', badgeText, 'badge task-type'));
  add(header, left, node("small", time || ""));
  add(card, header, linkedText(content));
  return card;
}
function section(title) {
  const box = node("section", null, "detail-section");
  add(box, node("h4", title));
  return box;
}

// ---- 任务对话：按时间合并发言、质疑与补充，回复用引用卡关联 ----
const RECAP_STANCE = "阶段总结";
function normalizedStance(value) {
  const text = String(value || "").trim();
  if (["阶段总结", "階段總結", "总结", "總結", "summary", "recap", "interim_summary"].includes(text)) return RECAP_STANCE;
  if (text === "支持" || text === "support") return "支持";
  if (["反駁", "反驳", "rebut"].includes(text)) return "反驳";
  if (["補充", "补充", "add", "supplement"].includes(text)) return "补充";
  return text;
}
const isRecapMessage = item => normalizedStance(item?.stance) === RECAP_STANCE;
function conversationRecapSummary(data) {
  const debate = data.debate || [];
  const recaps = debate.filter(isRecapMessage);
  const latest = recaps.at(-1) || null;
  const discussion = data.workflow?.discussion || null;
  const substantive = debate.filter(item => !isRecapMessage(item));
  const newerCount = discussion && Number.isFinite(discussion.messages_since_recap)
    ? discussion.messages_since_recap
    : latest
      ? substantive.filter(item => Number(item.id) > Number(latest.id)).length
      : substantive.length;
  return { recaps, latest, count: recaps.length, newerCount, discussion };
}
async function requestDebateRecap(taskId) {
  const res = await api(`/api/tasks/${taskId}/recap-request`, "POST", {});
  notify(res.already_pending ? "已经请求过阶段总结，等待总结负责人更新" : "已请求更新阶段总结，将在总结负责人下次巡检时发表");
  await selectTask(taskId);
}
function formatShortTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}
function renderRecapRefGlossary(content, byId, onJump, onOpen = null) {
  const refIds = extractFloorRefIds(content, byId);
  if (!refIds.length) return null;
  const wrap = node("div", null, "recap-ref-glossary");
  wrap.setAttribute("aria-label", "文中提及的楼层内容");
  add(wrap, node("p", "文中提及的楼层内容", "recap-ref-glossary-title"));
  const list = node("ul", null, "recap-ref-glossary-list");
  for (const id of refIds) {
    const item = byId.get(id);
    if (!item) continue;
    const li = node("li", null, "recap-ref-glossary-item");
    const link = node("a", `#${id}`, "recap-ref-glossary-link");
    link.href = `#debate-${id}`;
    link.setAttribute("aria-label", `跳转到 ${item.agent || "未知作者"} 的发言 #${id}`);
    link.addEventListener("click", event => {
      event.preventDefault();
      if (onJump) onJump(id, link);
    });
    const stanceText = normalizeStanceLabel(item.stance);
    const speaker = renderAgentName(String(item.agent || "未知作者"), { role: item.role, className: "recap-ref-glossary-speaker", tag: "strong" });
    const preview = node("span", compactFloorPreview(item.content, 110), "recap-ref-glossary-text");
    add(li, link, speaker);
    if (stanceText) add(li, node("span", stanceText, `conversation-tag ${stanceTagClass(stanceText)}`));
    add(li, preview);
    if (onOpen) {
      const openBtn = node("button", "展开窗口", "text-button recap-ref-glossary-open");
      openBtn.type = "button";
      openBtn.setAttribute("aria-label", `在窗口查看发言 #${id} 全文`);
      openBtn.addEventListener("click", () => onOpen(id, openBtn));
      add(li, openBtn);
    }
    add(list, li);
  }
  add(wrap, list);
  return wrap;
}
function excerpt(value, size = 100) { return Array.from(String(value || "").trim()).slice(0, size).join(""); }
function renderConversationTopic(task) {
  const detail = String(task?.detail || "").trim();
  if (!detail) return null;
  const topic = node("details", null, "conversation-topic");
  topic.open = true;
  topic.dataset.disclosureKey = "conversation-topic";
  const summary = node("summary", null, "conversation-topic-summary");
  add(
    summary,
    node("span", "初始主题", "conversation-topic-badge"),
    node("strong", task.title || "讨论主题", "conversation-topic-title")
  );
  const metaParts = [];
  if (task.created_by) metaParts.push(`发起：${task.created_by}`);
  const createdAt = Date.parse(task.created_at);
  if (Number.isFinite(createdAt)) {
    metaParts.push(new Date(createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  }
  if (metaParts.length) add(summary, node("span", metaParts.join(" · "), "conversation-topic-meta"));
  const toggle = node("span", "收起主题", "conversation-topic-toggle");
  add(summary, toggle);
  const body = node("div", null, "conversation-topic-body");
  add(body, readingUI.markdown(detail, "conversation-topic-content"));
  topic.addEventListener("toggle", () => {
    toggle.textContent = topic.open ? "收起主题" : "展开主题";
    if (!topic.open) for (const embed of body.querySelectorAll(".markdown-video-embed[open]")) embed.open = false;
  });
  add(topic, summary, body);
  return topic;
}
function renderTaskConversation(data, onReply = null) {
  const box = node("section", null, "detail-section");
  const topic = renderConversationTopic(data.task);
  if (topic) add(box, topic);

  const taskId = data.task?.id ?? null;
  const debate = data.debate || [];
  const byId = new Map(debate.filter(item => Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0).map(item => [Number(item.id), item]));
  const recapInfo = conversationRecapSummary(data);
  const activeFilter = () => (state.conversationFilter.taskId === taskId ? state.conversationFilter.value : "all");

  // 置顶最新阶段总结卡（或进行中激辩的无总结提示条）
  let recapToggleBtn = null;
  let pinnedCard = null;
  if (recapInfo.latest) {
    const latest = recapInfo.latest;
    const card = node("section", null, "conversation-recap-card");
    pinnedCard = card;
    card.setAttribute("aria-label", "最新阶段总结");
    const head = node("div", null, "conversation-recap-head");
    const titleGroup = node("div", null, "conversation-recap-title");
    add(titleGroup, node("span", RECAP_STANCE, "conversation-tag recap"), node("strong", "最新阶段总结"));
    if (recapInfo.count > 1) add(titleGroup, node("span", `第 ${recapInfo.count} 版`, "record-id"));
    const actions = node("div", null, "conversation-recap-actions");
    if (recapInfo.newerCount === 0) add(actions, node("span", "已覆盖当前讨论", "chip recap-fresh-chip"));
    else add(actions, node("span", `之后新增 ${recapInfo.newerCount} 条讨论`, "chip warn-chip"));
    if (recapInfo.discussion?.phase === "active" && recapInfo.discussion.recap_requested_at) {
      add(actions, node("span", "已请求更新", "chip"));
    }
    recapToggleBtn = button("", () => setFilter(activeFilter() === "recap" ? "all" : "recap"), "text-button conversation-recap-toggle");
    add(actions, recapToggleBtn);
    if (state.user?.role === "admin" && recapInfo.discussion?.phase === "active" && recapInfo.newerCount > 0 && !recapInfo.discussion.recap_requested_at) {
      add(actions, button("请求更新总结", () => requestDebateRecap(taskId), "text-button recap-request-btn"));
    }
    add(head, titleGroup, actions);
    const recapMeta = node("p", null, "conversation-recap-meta");
    add(recapMeta, renderAgentName(String(latest.agent || "未知作者"), { role: latest.role }));
    const stamp = formatShortTime(latest.created_at);
    if (stamp) recapMeta.append(document.createTextNode(` · ${stamp}`));
    if (Number.isSafeInteger(Number(latest.id)) && Number(latest.id) > 0) recapMeta.append(document.createTextNode(` · 发言 #${latest.id}`));
    add(card, head, recapMeta, linkedText(latest.content, "conversation-recap-body", { limit: 600 }));
    const glossary = renderRecapRefGlossary(
      latest.content,
      byId,
      (id, anchor) => floorRefsUI.jump(id, anchor),
      (id, anchor) => floorRefsUI.open(id, anchor, "debate")
    );
    if (glossary) add(card, glossary);
    if (latest.links) {
      const src = readingUI.sources(latest.links);
      if (src) add(card, src);
    }
    add(box, card);
  } else if (recapInfo.discussion?.phase === "active" && recapInfo.newerCount > 0) {
    const bar = node("section", null, "conversation-recap-bar");
    bar.setAttribute("aria-label", "阶段总结提示");
    const authorName = recapInfo.discussion.summary_author || "总结负责";
    const text = recapInfo.discussion.recap_requested_at
      ? `已请求 ${authorName} 更新阶段总结，将在下次巡检时发表。`
      : `尚无阶段总结 · 当前已有 ${recapInfo.newerCount} 条讨论${recapInfo.discussion.recap_every ? `（满 ${recapInfo.discussion.recap_every} 条将由 ${authorName} 自动总结）` : ""}。`;
    add(bar, node("span", text, "muted"));
    if (state.user?.role === "admin" && !recapInfo.discussion.recap_requested_at) {
      add(bar, button("请求阶段总结", () => requestDebateRecap(taskId), "secondary recap-request-btn"));
    }
    add(box, bar);
  }

  const toolbar = node("div", null, "conversation-toolbar");
  const sortLabel = node("label", "排序");
  const sort = node("select", null, "conversation-sort");
  sort.add(new Option("时间倒序（最新在前）", "desc"));
  sort.add(new Option("时间正序（最早在前）", "asc"));
  sort.value = state.conversationSort;
  add(sortLabel, sort);
  add(toolbar, node("h4", "任务对话"), sortLabel);
  add(box, toolbar);

  const thread = node("div", null, "conversation");
  const rowFilterKey = row => {
    if (row.kind === "challenge") return "challenge";
    if (row.kind === "supplement") return "supplement";
    const stance = normalizedStance(row.item.stance);
    if (stance === RECAP_STANCE) return "recap";
    if (stance === "支持") return "support";
    if (stance === "反驳") return "rebut";
    if (stance === "补充") return "supplement";
    return "other";
  };
  const rows = [
    ...debate.map(item => ({ kind: "debate", item })),
    ...(data.challenges || []).map(item => ({ kind: "challenge", item })),
    ...(data.supplements || []).map(item => ({ kind: "supplement", item })),
  ].map((row, index) => ({ ...row, index, filterKey: rowFilterKey(row), time: Date.parse(row.item.created_at) }));

  // 标签筛选栏（有讨论内容时显示，方便一键只看阶段总结或按立场浏览）
  const filterButtons = new Map();
  if (rows.length) {
    const counts = { all: rows.length, recap: 0, support: 0, rebut: 0, supplement: 0, challenge: 0 };
    for (const row of rows) if (row.filterKey in counts) counts[row.filterKey]++;
    const specs = [
      { key: "all", label: "全部", count: counts.all },
      { key: "recap", label: RECAP_STANCE, count: counts.recap, recap: true },
      { key: "support", label: "支持", count: counts.support },
      { key: "rebut", label: "反驳", count: counts.rebut },
      { key: "supplement", label: "补充", count: counts.supplement },
      ...(counts.challenge ? [{ key: "challenge", label: "质疑", count: counts.challenge }] : []),
    ];
    const bar = node("div", null, "conversation-filters");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "按标签筛选讨论");
    for (const spec of specs) {
      const btn = node("button", `${spec.label} (${spec.count})`, `conversation-filter-chip${spec.recap ? " is-recap" : ""}`);
      btn.type = "button";
      btn.dataset.filter = spec.key;
      btn.addEventListener("click", () => setFilter(spec.key));
      filterButtons.set(spec.key, btn);
      add(bar, btn);
    }
    add(box, bar);
  }

  let visibleCount = state.conversationVisible.taskId === taskId ? state.conversationVisible.count : 10;
  state.conversationVisible = {taskId, count: visibleCount};
  const more = button('', () => {
    visibleCount += 10;
    state.conversationVisible = {taskId, count: visibleCount};
    renderOrder();
  }, 'text-button conversation-more');

  function syncFilterUI() {
    const current = activeFilter();
    for (const [key, btn] of filterButtons) {
      const selected = key === current;
      btn.classList.toggle("is-active", selected);
      btn.setAttribute("aria-pressed", String(selected));
    }
    if (recapToggleBtn) {
      recapToggleBtn.textContent = current === "recap" ? "查看全部讨论" : `只看阶段总结（${recapInfo.count}）`;
    }
  }
  function setFilter(next) {
    const valid = filterButtons.size ? (filterButtons.has(next) ? next : "all") : "all";
    state.conversationFilter = { taskId, value: valid };
    visibleCount = 10;
    state.conversationVisible = { taskId, count: visibleCount };
    renderOrder();
  }
  function renderOrder() {
    const direction = sort.value === 'asc' ? 1 : -1;
    const currentFilter = filterButtons.has(activeFilter()) ? activeFilter() : "all";
    if (state.conversationFilter.taskId !== taskId || state.conversationFilter.value !== currentFilter) {
      state.conversationFilter = { taskId, value: currentFilter };
    }
    rows.sort((a, b) => {
      const aKnown = Number.isFinite(a.time), bKnown = Number.isFinite(b.time);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return aKnown ? direction * (a.time - b.time || a.index - b.index) : a.index - b.index;
    });
    const matched = currentFilter === "all" ? rows : rows.filter(row => row.filterKey === currentFilter);
    thread.replaceChildren(...matched.map(row => row.message));
    if (!matched.length) {
      const emptyMsg = !rows.length
        ? "暂无讨论，欢迎分享观点。"
        : currentFilter === "recap"
          ? "暂无阶段总结，讨论推进后由总结负责人或成员发表。"
          : "该标签下暂无讨论记录。";
      add(thread, node("p", emptyMsg, "muted conversation-empty"));
    }
    matched.forEach((row, index) => {row.message.hidden = index >= visibleCount;});
    const remaining = Math.max(0, matched.length - visibleCount);
    more.hidden = !remaining;
    more.textContent = `${direction < 0 ? '查看更早' : '查看更新'}的讨论（${remaining}）`;
    syncFilterUI();
  }
  sort.addEventListener('change', () => {
    state.conversationSort = sort.value;
    try { localStorage.setItem(`whiteboard.conversationSort.${state.user.id}`, sort.value); } catch { /* storage unavailable */ }
    visibleCount = 10;
    state.conversationVisible = {taskId, count: visibleCount};
    renderOrder();
  });
  for (const row of rows) {
    const { kind, item, time } = row;
    const recap = kind === "debate" && isRecapMessage(item);
    const stanceLabel = kind === "debate" ? normalizeStanceLabel(item.stance) : "";
    const stanceCls = kind === "debate" ? stanceTagClass(stanceLabel) : kind;
    const message = node("article", null, `conversation-message ${kind}${recap ? " recap" : kind === "debate" ? ` ${stanceCls}` : ""}${item.role === "human" ? " human" : ""}`);
    row.message = message;
    message.dataset.kind = kind;
    if (recap) message.dataset.stance = "recap";
    else if (stanceLabel) message.dataset.stance = stanceCls;
    // 只有辩论发言有 #debate-id；质疑/补充的 id 可能相同，不能拿来互相跳转。
    if (kind === "debate" && Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0) {
      message.id = `debate-${item.id}`;
      message.dataset.debateId = String(item.id);
    }
    const name = String(item.agent || "未知作者");
    const avatar = node("span", Array.from(name.trim())[0] || "?", "conversation-avatar");
    avatar.setAttribute("aria-hidden", "true");
    const header = node("header", null, "conversation-header");
    const label = recap ? RECAP_STANCE : kind === "debate" ? stanceLabel : kind === "challenge" ? "质疑" : `补充 v${item.version}`;
    add(header, renderAgentName(name, { role: item.role, className: "conversation-speaker", tag: "strong" }), node("span", item.role === "human" ? "成员" : "Agent", "conversation-role"), node("span", label, `conversation-tag ${recap ? "recap" : stanceCls}`));
    if (Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0) {
      const kindName = kind === "debate" ? "发言" : kind === "challenge" ? "质疑" : "补充";
      add(header, node("span", `${kindName} #${item.id}`, "record-id"));
    }
    if (Number.isFinite(time)) {
      const stamp = node("time", new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }), "conversation-time");
      stamp.dateTime = item.created_at;
      add(header, stamp);
    }
    const bubble = node("div", null, "conversation-bubble");
    if (kind === "debate" && item.reply_to != null && item.reply_to !== "") {
      const replyId = Number(item.reply_to);
      const cited = Number.isSafeInteger(replyId) && replyId > 0 ? byId.get(replyId) : null;
      const quote = node(cited ? "a" : "div", null, cited ? "reply-reference" : "reply-reference is-missing");
      if (cited) {
        quote.href = `#debate-${replyId}`;
        quote.setAttribute("aria-label", `打开窗口查看 ${cited.agent || "未知作者"} 的发言 #${replyId}`);
        const targetRow = node("span", null, "reply-target-row");
        const citedStance = normalizeStanceLabel(cited.stance);
        add(
          targetRow,
          node("span", `↳ 回复 ${cited.agent || "未知作者"} · 发言 #${replyId}`, "reply-target"),
          ...(citedStance ? [node("span", citedStance, `conversation-tag ${stanceTagClass(citedStance)}`)] : []),
          node("span", "查看完整引用 ↗", "reply-open-hint")
        );
        add(quote, targetRow, node("small", compactFloorPreview(cited.content, 160), "reply-excerpt"));
        quote.addEventListener("click", event => {
          event.preventDefault();
          floorRefsUI.open(replyId, quote, "debate");
        });
        message.classList.add("is-reply");
      } else add(quote, node("span", `↳ 引用 #${item.reply_to} · 原发言不可见`, "reply-target"));
      add(bubble, quote);
    }
    const content = kind === "debate" ? item.content : kind === "challenge" ? item.reason : item.summary;
    add(bubble, linkedText(content));
    if (recap) {
      const glossary = renderRecapRefGlossary(
        content,
        byId,
        (id, anchor) => floorRefsUI.jump(id, anchor),
        (id, anchor) => floorRefsUI.open(id, anchor, "debate")
      );
      if (glossary) add(bubble, glossary);
    }
    const links = kind === "debate" ? item.links : kind === "challenge" ? item.evidence : item.links;
    if (links) add(bubble, node("span", kind === "supplement" ? "来源" : "证据", "conversation-source-label"), linkedText(links, "link-list"));
    if (kind === "debate" && onReply && message.dataset.debateId) {
      const respond = button("回复", () => onReply(item), "text-button");
      respond.setAttribute("aria-label", `回复 ${name}`);
      add(bubble, respond);
    }
    add(message, avatar, header, bubble);
  }
  function jumpToFloor(id) {
    const currentFilter = activeFilter();
    const targetRow = rows.find(r => r.kind === "debate" && Number(r.item.id) === id);
    if (targetRow && currentFilter !== "all" && targetRow.filterKey !== currentFilter) {
      state.conversationFilter = { taskId, value: "all" };
      renderOrder();
    }
    const matched = activeFilter() === "all" ? rows : rows.filter(r => r.filterKey === activeFilter());
    const index = matched.findIndex(r => r.kind === "debate" && Number(r.item.id) === id);
    if (index >= visibleCount) {
      visibleCount = Math.ceil((index + 1) / 10) * 10;
      state.conversationVisible = {taskId, count: visibleCount};
      renderOrder();
    }
    flash(document.getElementById(`debate-${id}`));
  }
  renderOrder();
  add(box, thread, more);
  return { root: box, setFilter, jumpToFloor };
}

// ---- 任务列表与讨论区频道 ----
function resetTaskReader() {
  detailRequest++;
  floorRefsUI?.reset();
  state.selected = null;
  state.detail = null;
  state.detailTab = null;
  const target = clear($("taskDetail"));
  delete target.dataset.renderedTaskId;
  target.classList.add("empty");
  target.classList.remove("has-workflow");
  target.textContent = "选择一条任务查看详情与操作。";
}

// 频道仅用于讨论区留言板，不再影响任务筛选与创建。
function renderChannels() {
  const value = state.channelId;
  const list = clear($("channelList"));
  const all = node("button", null, "channel-sidebar-item" + (value ? "" : " active"));
  all.type = "button";
  all.setAttribute("aria-pressed", String(!value));
  add(all, node('strong', '全部频道'), node('small', '汇总查看全部频道的留言'));
  all.addEventListener("click", () => setChannel(""));
  add(list, all);

  for (const channel of state.channels) {
    const active = String(channel.id) === value;
    const item = node("button", null, "channel-sidebar-item" + (active ? " active" : ""));
    item.type = "button";
    item.setAttribute("aria-pressed", String(active));
    add(item, node('strong', channel.name));
    if (channel.topic) add(item, node('small', channel.topic));
    item.addEventListener("click", () => setChannel(String(channel.id)));
    add(list, item);
  }
  if (!state.channels.length) add(list, node("p", "暂无频道，管理员可在上方新建讨论频道。", "muted channel-empty"));

  const postSelect = $('postChannelSelect');
  const postWrap = $('postChannelWrap');
  if (postSelect && postWrap) {
    const prev = postSelect.value;
    postSelect.replaceChildren();
    for (const channel of state.channels) postSelect.add(new Option(channel.name, String(channel.id)));
    if (value && state.channels.some(c => String(c.id) === value)) postSelect.value = value;
    else if (prev && state.channels.some(c => String(c.id) === prev)) postSelect.value = prev;
    postWrap.hidden = !!value || state.channels.length <= 1;
  }
}
function setChannel(id) {
  saveNavigation();
  state.channelId = id;
  renderChannels();
  recordNavigation(true);
  refreshMessages().catch(error => notify(error.message, true));
}
function renderTasks() {
  const status = $('statusFilter').value;
  const kind = $('taskKindFilter').value;
  const query = $('taskSearch').value.trim().toLocaleLowerCase();
  const idQuery = query.replace(/^#/, '');
  state.tasks = state.allTasks.filter(task => {
    if (status === 'active' && ['done', 'closed'].includes(task.status)) return false;
    if (status && status !== 'active' && task.status !== status) return false;
    if (kind && taskKind(task) !== kind) return false;
    return !query || String(task.id) === idQuery || [task.title, task.claimed_by, task.host, task.created_by, task.collaboration?.reason].some(value => String(value || '').toLocaleLowerCase().includes(query));
  });
  const direction = $('taskSort').value === 'asc' ? 1 : -1;
  state.tasks.sort((a, b) => {
    const aTime = Date.parse(a.created_at), bTime = Date.parse(b.created_at);
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) return direction * (aTime - bTime || a.id - b.id);
    if (Number.isFinite(aTime)) return -1;
    if (Number.isFinite(bTime)) return 1;
    return 0;
  });
  const keepWinScroll = state.view === 'tasks' && !state.reading.tasks;
  const winScrollY = keepWinScroll ? window.scrollY : 0;
  const scrollTop = $('taskList').scrollTop, list = clear($("taskList"));
  $("taskCount").textContent = `${state.tasks.length} 条`;
  for (const task of state.tasks) {
    const active = state.selected === task.id;
    const item = node("button", null, "task-item" + (active ? " active" : ""));
    item.type = "button";
    item.setAttribute("aria-pressed", String(active));
    add(item, add(node("div", null, "record-title"), node("strong", task.title), node("span", `任务 #${task.id}`, "record-id")));
    const row = node("div", null, "task-line");
    add(row, node("span", taskStatus(task), `badge ${task.status}`), typeBadge(task));
    if (task.collaboration?.help_wanted) add(row, node("span", "待协作", "badge help-wanted"));
    add(row, node("small", task.host || task.claimed_by || task.created_by || ""));
    add(item, row);
    if (task.deadline) add(item, node('small', `截止 ${task.deadline}`, 'task-deadline'));
    if (task.collaboration?.reason) add(item, node('span', task.collaboration.reason, 'task-blocker'));
    item.addEventListener("click", () => openTask(task.id, {tab: 'overview'}).catch(error => notify(error.message, true)));
    add(list, item);
  }
  if (!state.tasks.length) add(list, node("p", "没有符合筛选的任务。", "muted"));
  list.scrollTop = scrollTop;
  if (keepWinScroll && winScrollY > 0) window.scrollTo(0, winScrollY);
  renderOutcomeLists();
}
async function refreshMessages() {
  const channelId = state.channelId, user = state.user;
  const request = ++messagesRequest;
  if (!lastMessages) $('messages').textContent = '正在载入留言…';
  const [result] = await Promise.all([
    api(`/api/messages${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''}`), ensureReadingUI(),
  ]);
  if (request === messagesRequest && state.user === user && state.channelId === channelId) renderMessages(result.messages || []);
}
function renderMessages(messages) {
  lastMessages = messages;
  const el = $("messages");
  const channelId = state.channelId;
  const sameChannel = el.dataset.renderedChannel === String(channelId);
  const restore = sameChannel ? disclosureState(el) : null;
  const listScroll = sameChannel ? el.scrollTop : 0;
  const winScrollY = sameChannel && state.view === 'community' ? window.scrollY : 0;
  const target = clear(el);
  target.dataset.renderedChannel = String(channelId);
  const channelNames = new Map(state.channels.map(c => [c.id, c.name]));
  const channel = state.channels.find(row => String(row.id) === channelId);
  for (const message of messages) {
    const time = message.created_at && Number.isFinite(Date.parse(message.created_at))
      ? new Date(message.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : (message.created_at || '');
    const chLabel = !channel && message.channel_id ? (channelNames.get(message.channel_id) || '') : '';
    const titleWrap = node("strong", null, "message-author-line");
    add(titleWrap, renderAgentName(message.author, { role: message.role, tag: "span" }), document.createTextNode(` · ${message.role === "human" ? "成员" : "Agent"}${message.id ? ` · #${message.id}` : ''}`));
    add(target, entry(titleWrap, message.text, time, chLabel));
  }
  if (!messages.length) add(target, node("p", "还没有留言，欢迎记录白板问题、反馈或资讯。", "muted discussion-empty"));
  $("messageScope").textContent = channel ? channel.name : "全部频道";
  const topicEl = $('messageTopic');
  if (topicEl) topicEl.textContent = channel?.topic || (channel ? '' : '汇总显示所有频道的留言与反馈');
  $("messageScopeAll").hidden = !channel;
  if (restore) restore();
  if (sameChannel) {
    target.scrollTop = listScroll;
    if (state.view === 'community' && winScrollY > 0) window.scrollTo(0, winScrollY);
  }
}

// ---- 成果视图：列表按待核对 / 已完成分组，右侧是只读成果阅读区 ----
const OUTCOME_GROUPS = [
  { status: "review", list: "outcomeListReview", count: "outcomeReviewCount", empty: "没有待核对的成果。" },
  { status: "done", list: "outcomeListDone", count: "outcomeDoneCount", empty: "还没有已完成的成果。" },
];
function renderOutcomeLists() {
  const keepWinScroll = state.view === 'outcomes' && !state.reading.outcomes;
  const winScrollY = keepWinScroll ? window.scrollY : 0;
  for (const group of OUTCOME_GROUPS) {
    const scrollTop = $(group.list).scrollTop, list = clear($(group.list));
    const rows = state.outcomeTasks.filter(task => task.status === group.status);
    $(group.count).textContent = String(rows.length);
    for (const task of rows) {
      const active = state.outcomeSelected === task.id;
      const item = node("button", null, "outcome-item" + (active ? " active" : ""));
      item.type = "button";
      item.setAttribute("aria-pressed", String(active));
      add(item, add(node("div", null, "record-title"), node("strong", task.title), node("span", `任务 #${task.id}`, "record-id")));
      const row = node("div", null, "task-line");
      add(row, node("span", taskStatus(task), `badge ${task.status}`), typeBadge(task));
      if (task.report?.revision) add(row, node("span", `报告 ${task.report.revision}`, "chip report-chip"));
      add(row, node("small", task.claimed_by || task.created_by || ""));
      add(item, row);
      item.addEventListener("click", () => openOutcome(task.id).catch(error => notify(error.message, true)));
      add(list, item);
    }
    if (!rows.length) add(list, node("p", group.empty, "muted"));
    list.scrollTop = scrollTop;
  }
  if (keepWinScroll && winScrollY > 0) window.scrollTo(0, winScrollY);
}
function resetOutcomeReader() {
  state.outcomeDetail = null;
  const target = clear($("outcomeDetail"));
  delete target.dataset.renderedTaskId;
  target.classList.add("empty");
  target.textContent = "从左侧选择一条成果开始阅读。";
}
function renderOutcomeReader(data) {
  const box = $('outcomeDetail');
  const task = data.task;
  const sameOutcome = box.dataset.renderedTaskId === String(task.id);
  const restore = sameOutcome ? disclosureState(box) : null;
  const scrollTop = sameOutcome ? box.parentElement.scrollTop : 0;
  const winScrollY = sameOutcome && state.view === 'outcomes' && state.reading.outcomes ? window.scrollY : 0;
  state.outcomeDetail = data;
  const target = clear(box);
  target.dataset.renderedTaskId = String(task.id);
  target.classList.remove("empty");
  const head = node("div", null, "detail-head");
  const eyebrow = add(node("div", null, "detail-eyebrow"), node("span", taskStatus(task), `badge ${task.status}`), typeBadge(task), node("span", `任务 #${task.id}`, "record-id"));
  add(head, eyebrow, node("h3", task.title));
  add(target, head);
  add(target, outcomeView.summaryBlock(task, data, { heading: "成果总结" }));
  const history = outcomeView.versionHistory(task, data);
  if (history) add(target, history);
  const taskFiles = outcomeView.taskFilesStrip(task);
  if (taskFiles) add(target, taskFiles);
  const actions = node("div", null, "action-row");
  add(actions, button("打开任务详情", () => openTask(task.id, {tab: 'outcome'}), "secondary"));
  if (task.status === 'review') add(actions, button('查看核查与验收', () => openTask(task.id, {tab: 'review'}), 'primary'));
  add(target, actions);
  if (restore) restore();
  target.parentElement.scrollTop = scrollTop;
  if (sameOutcome && state.view === 'outcomes' && state.reading.outcomes && winScrollY > 0) window.scrollTo(0, winScrollY);
}
async function openOutcome(id, { silent = false } = {}) {
  if (!silent) {
    saveNavigation();
    state.reading.outcomes = true;
    showView('outcomes', {record: false});
  }
  state.outcomeSelected = id;
  if (!silent) {recordNavigation(); window.scrollTo(0, 0);}
  renderOutcomeLists();
  const request = ++outcomeRequest, user = state.user;
  const target = $("outcomeDetail");
  if (!silent) {
    delete target.dataset.renderedTaskId;
    clear(target).textContent = "正在载入成果…";
    target.classList.add("empty");
    target.parentElement.scrollTop = 0;
  }
  try {
    const [data] = await Promise.all([api(`/api/tasks/${id}`), ensureTaskUI(), ensureParticipants()]);
    if (state.outcomeSelected !== id || request !== outcomeRequest || state.user !== user) return;
    renderOutcomeReader(data);
  } catch (error) {
    if (state.outcomeSelected !== id || request !== outcomeRequest || state.user !== user) return;
    const failed = clear(target);
    failed.classList.add("empty");
    failed.textContent = `无法载入这条成果：${error.message}`;
  }
}
async function openTask(id, {tab = null} = {}) {
  const same = state.view === 'tasks' && state.reading.tasks && state.selected === id;
  if (!same) saveNavigation();
  if (!state.tasks.some(task => task.id === id)) {
    $("statusFilter").value = "";
    $('taskKindFilter').value = '';
    $('taskSearch').value = '';
  }
  state.reading.tasks = true;
  showView('tasks', {record: false});
  const work = selectTask(id, {tab});
  if (!same) {recordNavigation(); window.scrollTo(0, 0);}
  await work;
  if (!same && state.selected === id && state.view === 'tasks') $('detailTitle').focus({preventScroll: true});
}
const fetchTaskList = (etag = null) => api('/api/tasks?view=summary', 'GET', undefined, {etag});

function ensureParticipants({ force = false } = {}) {
  const user = state.user;
  if (!user || (!force && participantsUser === user)) return Promise.resolve();
  if (participantsRequest) return participantsRequest;
  const request = api('/api/participants').then(data => {
    if (state.user !== user) return;
    participantsUser = user;
    if (workUI) workUI.setParticipants(data.agents || []);
    else applyParticipants(data.agents || []);
  }).catch(error => {
    if (state.user === user) notify(error.message, true);
  }).finally(() => { if (participantsRequest === request) participantsRequest = null; });
  participantsRequest = request;
  return request;
}

function fetchAdminAgents() {
  if (agentsRequest) return agentsRequest;
  const user = state.user;
  const request = api('/api/admin/agents').then(data => {
    if (state.user === user) adminAgents = Array.isArray(data.accounts) ? data.accounts : [];
    return data;
  }).finally(() => { if (agentsRequest === request) agentsRequest = null; });
  agentsRequest = request;
  return request;
}

async function refreshHomeAgents() {
  const user = state.user;
  if (user?.role !== 'admin') return;
  await Promise.all([fetchAdminAgents(), ensureQuotasUI()]);
  if (state.user === user) {
    quotasUI.syncAgents(adminAgents);
    for (const person of adminAgents) syncAgentAccountSummary(person);
  }
}

function syncAgentAccountSummary(person) {
  const account = document.querySelector(`#agents [data-agent-account-id="${person.id}"]`);
  if (!account) return;
  const badgeHost = account.querySelector('.account-directive-slot');
  if (badgeHost) {
    const badge = quotasUI.makeDirectiveBadge(person.pending_directives);
    badgeHost.replaceChildren(...(badge ? [badge] : []));
  }
  const summary = account.querySelector('.agent-quota-compact');
  if (summary) summary.replaceWith(quotasUI.renderCompactSummary(person));
}

function loadView({ force = false } = {}) {
  const user = state.user, view = state.view, settings = state.settings;
  if (!user) return Promise.resolve();
  const key = view === 'settings' ? `settings/${settings}` : view;
  if (viewRequests.has(key)) return viewRequests.get(key);
  const panel = view === 'home' ? $('homeAgentQuotaPanel') : view === 'tasks' ? $('createTaskBox')
    : view === 'settings' ? $(settings === 'accounts' ? 'adminPanel' : 'agentGuidePanel') : VIEW_PANELS[view];
  panel.setAttribute('aria-busy', 'true');
  const request = (async () => {
    if (view === 'home') await refreshHomeAgents();
    else if (view === 'tasks') await ensureParticipants({ force });
    else if (view === 'files') {
      await ensureFilesUI();
      if (state.user === user) await filesUI.refresh({ force });
    } else if (view === 'community') {
      await Promise.all([
        api('/api/channels').then(data => {
          if (state.user === user) { state.channels = data.channels || []; renderChannels(); }
        }),
        refreshMessages(), ensureParticipants(),
      ]);
    } else if (view === 'settings' && settings === 'accounts') {
      if (!document.querySelector('.account-confirm, .account-edit')) await refreshAccounts();
    }
    else if (view === 'settings') {
      if (!$('agentGuide').hasChildNodes()) $('agentGuide').textContent = '正在载入指南…';
      await ensureGuideUI();
      if (state.user === user) await guideUI.refresh();
    }
  })().catch(error => {
    if (state.user === user) throw error;
  }).finally(() => {
    if (viewRequests.get(key) === request) { viewRequests.delete(key); panel.removeAttribute('aria-busy'); }
  });
  viewRequests.set(key, request);
  return request;
}

function applyTaskList(data, home = state.home) {
  const keepHomeScroll = state.view === 'home';
  const winScrollY = keepHomeScroll ? window.scrollY : 0;
  taskListETag = data.etag;
  state.allTasks = data.tasks || [];
  state.outcomeTasks = state.allTasks.filter(task => OUTCOME_STATUS.includes(task.status));
  state.home = Array.isArray(data.decisions) ? {...home, digest: {decisions: data.decisions}} : home;
  renderTasks();
  workbench.render(state.allTasks, state.home, state.user);
  if (keepHomeScroll && winScrollY > 0) window.scrollTo(0, winScrollY);
}

async function refresh({ initial = false } = {}) {
  const request = ++refreshRequest, user = state.user;
  foregroundRefresh = request;
  try {
    // Commit the task summary before optional work, including slow account and
    // guide requests. A failure in another view cannot hide the home page.
    const tasks = await fetchTaskList();
    if (request !== refreshRequest || state.user !== user) return;
    applyTaskList(tasks);
    if (initial) return;
    const secondary = loadView({ force: true }).catch(error => notify(error.message, true));
    if (state.view === 'tasks' && state.selected) {
      if (state.allTasks.some(t => t.id === state.selected)) await selectTask(state.selected);
      else resetTaskReader();
    }
    if (state.view === 'outcomes' && state.outcomeSelected) {
      if (state.outcomeTasks.some(t => t.id === state.outcomeSelected)) await openOutcome(state.outcomeSelected, {silent:true});
      else { state.outcomeSelected = null; resetOutcomeReader(); }
    }
    await secondary;
  } finally {
    if (foregroundRefresh === request) foregroundRefresh = 0;
  }
}
async function act(id, action, body = {}) {
  await api(`/api/tasks/${id}/${action}`, "POST", body);
  notify("操作已保存");
  await refresh();
}
function detailActions(task, readiness, workflow, {management = false} = {}) {
  const isAdmin = state.user?.role === "admin";
  if (!isAdmin) return null;
  const actions = node("div", null, "action-row detail-actions");
  if (!management && task.status === "proposed") {
    if (task.plan?.collaboration !== 'hosted' || workflow?.host_id) add(actions, button('批准提案', () => act(task.id, 'approve'), 'primary'));
    else add(actions, node("p", "请先在下方「修改任务设置」指定主持人，点击「保存设置并批准」。", "muted"));
    add(actions, button("驳回提议", async () => {
      if (confirm("确定驳回这条提议？")) await act(task.id, "reject");
    }, "danger"));
  }
  if (!management && task.status === "review") {
    if (readiness?.ready) add(actions, button("确认验收", () => act(task.id, "verify"), "primary"));
    else if (workflow?.enabled) add(actions, node('p', '完成核查条件后即可确认交付。', 'muted'));
    else add(actions, button("填写理由并强制通过", async () => {
      const reason = prompt("请输入强制通过的理由（会记录在任务中）");
      if (reason?.trim()) await act(task.id, "verify", { force: true, force_reason: reason.trim() });
    }, "secondary"));
  }
  if (management && task.status !== "open") add(actions, button("退回待认领", async () => {
    if (confirm("确定将任务退回待认领？")) await act(task.id, "reopen");
  }));
  if(management&&taskType(task)==='active_debate'&&!['done','closed','proposed'].includes(task.status)) add(actions,button('关闭激辩',async()=>{
    const reason=prompt('请填写关闭原因（会保留记录）');if(reason?.trim()) await act(task.id,'close',{reason:reason.trim()});
  },'danger'));
  return actions.childElementCount ? actions : null;
}
function debateForm(task, debate) {
  if (!state.user || !["admin", "publisher"].includes(state.user.role) || task.status === "closed") return null;
  const active=taskType(task)==='active_debate',discussion=state.detail?.workflow?.discussion;
  if(active&&discussion?.phase!=='active') return null;
  const form = node("form", null, "inline-form");
  form.id = "debateForm";
  const heading = node("h4", active?'参与激辩':"参与讨论");
  const stanceLabel = node("label", "立场");
  const stance = node("select"); stance.name = "stance";
  for (const value of ["支持", "反驳", "补充", RECAP_STANCE]) stance.add(new Option(value, value));
  stanceLabel.append(stance);
  const replyLabel = node("label", "回复（可选）");
  const reply = node("select"); reply.name = "reply_to";
  reply.add(new Option("不引用其他发言", ""));
  for (const item of debate) {
    if (Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0)
      reply.add(new Option(`发言 #${item.id} · ${item.agent}: ${String(item.content || "").slice(0, 24)}`, String(item.id)));
  }
  replyLabel.append(reply);
  const preview = node("div", null, "reply-preview");
  preview.setAttribute("role", "status"); preview.setAttribute("aria-live", "polite"); preview.hidden = true;
  reply.addEventListener("change", () => {
    clear(preview);
    const selected = debate.find(item => String(item.id) === reply.value);
    if (!selected) { preview.hidden = true; return; }
    add(preview, node("strong", `↳ 正在回复 ${selected.agent || "未知作者"} · 发言 #${selected.id}`), node("span", excerpt(selected.content)));
    preview.hidden = false;
  });
  const contentLabel = node("label", "发言内容");
  const content = node("textarea"); content.name = "content"; content.rows = 3; content.required = true;
  const defaultPlaceholder = "支持 Markdown（> 引用原话 / 表格 / > [!结论] / Emoji）与图片；YouTube／B 站链接单独一行可展开播放";
  const recapPlaceholder = "能不带 #楼层号 就不带，用通俗大白话写 200–400 字（若提及个别楼层须说明内容）：1) 总体进展 2) 支持方主要观点 3) 反驳/质疑方顾虑 4) 当前偏向与核心分歧";
  content.placeholder = defaultPlaceholder;
  contentLabel.append(content);
  const linksLabel = node("label", active?'证据链接（可选，事实判断请附依据）':"证据链接（反驳时必填，一行一个）");
  const links = node("textarea"); links.name = "links"; links.rows = 2; linksLabel.append(links);
  const send = node("button", "发表观点", "secondary"); send.type = "submit";
  const syncStanceMode = () => {
    const recapMode = stance.value === RECAP_STANCE;
    if (recapMode) {
      reply.value = "";
      reply.disabled = true;
      reply.dispatchEvent(new Event("change"));
      content.placeholder = recapPlaceholder;
      send.textContent = "发表阶段总结";
    } else {
      reply.disabled = false;
      content.placeholder = defaultPlaceholder;
      send.textContent = "发表观点";
    }
  };
  stance.addEventListener("change", syncStanceMode);
  add(form, heading, stanceLabel, replyLabel, preview, contentLabel, linksLabel, send);
  form.addEventListener("submit", async event => {
    event.preventDefault(); send.disabled = true;
    const isRecapSubmit = stance.value === RECAP_STANCE;
    try {
      await api(`/api/tasks/${task.id}/debate`, "POST", {
        stance: stance.value, content: content.value,
        links: links.value.split(/\n+/).map(s => s.trim()).filter(Boolean),
        ...(!isRecapSubmit && reply.value ? { reply_to: Number(reply.value) } : {}),
        ...(active?{expected_latest_id:discussion.last_message_id}:{}),
      });
      notify(isRecapSubmit ? "阶段总结已发布" : "发言已发布"); await selectTask(task.id);
    } catch (error) {
      if(active&&error.status===409) {
        const draft={stance:stance.value,reply_to:reply.value,content:content.value,links:links.value};
        try {
          await selectTask(task.id);
          const current=$('debateForm');
          if(current) {
            for(const [name,value] of Object.entries(draft)) current.elements.namedItem(name).value=value;
            current.elements.namedItem('stance').dispatchEvent(new Event('change'));
            current.elements.namedItem('reply_to').dispatchEvent(new Event('change'));
          } else {
            const saved=section('未发送的激辩草稿'),text=node('textarea');text.value=draft.content;text.readOnly=true;text.rows=5;
            add(saved,text);$('detailPanel-conversation').append(saved);
          }
        } catch { /* The existing form retains the draft when the refresh fails. */ }
      }
      notify(error.message, true);
    }
    finally { send.disabled = false; }
  });
  return form;
}
const messageCount = data => (data.debate?.length || 0) + (data.challenges?.length || 0) + (data.supplements?.length || 0);
function disclosureState(target) {
  const key = detail => {
    const scope = detail.closest('[data-debate-id]')?.dataset.debateId;
    const base = detail.dataset.disclosureKey || (detail.classList.contains('text-fold') ? `text:${detail.querySelector('.full-text')?.textContent}` : detail.querySelector(':scope > summary')?.textContent);
    return scope ? `debate-${scope}:${base}` : base;
  };
  const states = new Map([...target.querySelectorAll('details')].map(detail => [key(detail), detail.open]));
  return () => {
    for (const detail of target.querySelectorAll('details')) {
      const k = key(detail);
      if (!states.has(k)) continue;
      detail.open = states.get(k);
      if (detail.classList.contains('text-fold')) {
        const preview = detail.previousElementSibling;
        if (preview?.classList.contains('text-preview')) preview.hidden = detail.open;
        const sum = detail.querySelector(':scope > summary');
        if (sum) sum.textContent = detail.open ? '收起全文' : '展开全文';
      } else if (detail.classList.contains('conversation-topic')) {
        const toggle = detail.querySelector('.conversation-topic-toggle');
        if (toggle) toggle.textContent = detail.open ? '收起主题' : '展开主题';
      }
    }
  };
}
function nextStep(data) {
  const {task, workflow: work, verify_readiness: readiness} = data;
  if (task.status === 'done') return '已验收，可以阅读最终成果。';
  if (task.status === 'closed') return '任务已关闭。';
  if (work?.issues?.some(issue => issue.state === 'disputed')) return '有分歧需要你判断，请查看核查页。';
  if (task.status === 'proposed') return '查看任务设置，决定是否批准。';
  if(work?.discussion) {
    const d=work.discussion;
    if(d.phase==='ended') return d.participation_sufficient?(d.has_summary?'激辩已截止，等管理员验收。':'激辩已截止，请整理观点与分歧。'):'激辩已截止，参与不足；请总结现状并由管理员决定后续。';
    if(d.phase==='active') return '激辩进行中，无需认领；主动发言、接续反驳与追问，持续到截止时间。';
  }
  if (work?.waiting) return `等待：${work.wait_reason || '外部事件'}${work.resume_at ? `，预计 ${new Date(work.resume_at).toLocaleString('zh-CN')} 恢复` : ''}。`;
  if (task.status === 'review') return readiness?.ready ? '核查条件已齐，等你确认验收。' : '成果已提交，仍有核查条件待完成。';
  return task.claimed_by ? `${work?.host || task.claimed_by} 正在处理，具体进度见下方。` : '等待 Agent 认领。';
}
function renderTaskDetail(data) {
  const box = $('taskDetail');
  const task = data.task;
  const sameTask = box.dataset.renderedTaskId === String(task.id);
  const restore = sameTask ? disclosureState(box) : null;
  const scrollTop = sameTask ? box.parentElement.scrollTop : 0;
  const winScrollY = sameTask && state.view === 'tasks' && state.reading.tasks ? window.scrollY : 0;
  const target = clear(box);
  target.dataset.renderedTaskId = String(task.id);
  target.classList.remove("empty");

  const head = node("div", null, "detail-head");
  const eyebrow = add(node("div", null, "detail-eyebrow"), node("span", taskStatus(task), `badge ${task.status}`), typeBadge(task));
  if (taskKind(task) === 'web_report') add(eyebrow, node('span', GOALS[taskType(task)] || taskType(task), 'badge task-type'));
  add(eyebrow, node("span", `任务 #${task.id}`, "record-id"));
  add(head, eyebrow, node("h3", task.title));
  const meta = node("div", null, "task-meta");
  if (data.workflow?.discussion) {
    add(meta, node("span", '参与：开放激辩，无需认领'));
  } else {
    const ownerName = data.workflow?.host || task.claimed_by || "";
    const ownerSpan = node("span", null);
    ownerSpan.append(document.createTextNode("负责："), ownerName ? renderAgentName(ownerName, { id: data.workflow?.host_id }) : document.createTextNode("待认领"));
    add(meta, ownerSpan);
  }
  if (task.deadline) add(meta, node('span', `截止：${task.deadline}`));
  add(head, meta);
  const stepTone = task.status === 'done' ? 'is-done' : data.workflow?.issues?.some(i => i.state === 'disputed') ? 'is-warn' : task.status === 'review' && data.verify_readiness?.ready ? 'is-ready' : task.status === 'proposed' || data.workflow?.waiting ? 'is-warn' : 'is-info';
  add(head, node('p', nextStep(data), `next-step ${stepTone}`));
  add(target, head);

  const remembered = state.detailTab?.taskId === task.id ? state.detailTab.key : 'overview';
  const tabs = detailTabs([
    { key: 'overview', label: '概览' },
    { key: 'outcome', label: '成果' },
    { key: 'review', label: '核查', count: (data.workflow?.issues || []).filter(issue => issue.state !== 'resolved').length },
    { key: 'conversation', label: '讨论', count: messageCount(data) },
  ], '任务详情分区', {initial: remembered, onChange: key => {
    state.detailTab = {taskId: task.id, key};
    floorRefsUI.hide();
    if (state.view === 'tasks' && state.reading.tasks) recordNavigation(true);
  }});
  add(target, tabs.root);
  const overview = tabs.panel('overview'), outcome = tabs.panel('outcome'), review = tabs.panel('review'), conversation = tabs.panel('conversation');
  const recapInfo = conversationRecapSummary(data);
  const debateById = new Map((data.debate || []).filter(item => Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0).map(item => [Number(item.id), item]));
  let openConversationFilter = null;
  let jumpConversationFloor = null;
  if(data.workflow?.discussion) {
    const d=data.workflow.discussion,progress=section('激辩进度');progress.classList.add('active-debate-progress');
    add(progress,node('p',`${d.participants} 位 Agent · ${d.rounds}/${d.min_rounds} 轮交锋`),node('p',`截止：${new Date(d.end_at).toLocaleString('zh-CN')}；三轮达标后继续讨论。`,'muted'));
    if(d.summary_author) { const sumP = node('p', null, 'muted'); sumP.append(document.createTextNode('总结负责：'), renderAgentName(d.summary_author, { id: d.summary_author_id })); add(progress, sumP); }
    if(d.recap_count>0) add(progress,node('p',`阶段总结：已更新 ${d.recap_count} 次${d.messages_since_recap?` · 之后新增 ${d.messages_since_recap} 条发言`:' · 已覆盖当前讨论'}`,'muted'));
    if(d.next_action?.reason) add(progress,node('p',d.next_action.reason));
    const progressActions=node('div',null,'actions');
    add(progressActions,button(d.phase==='active'?'进入激辩':'阅读讨论记录',()=>tabs.select('conversation'),'secondary'));
    if(state.user?.role==='admin'&&d.phase==='active'&&recapInfo.newerCount>0) {
      if(d.recap_requested_at) add(progressActions,node('span','已请求更新阶段总结','chip'));
      else add(progressActions,button('请求阶段总结',()=>requestDebateRecap(task.id),'ghost-button recap-request-btn'));
    }
    add(progress,progressActions);add(overview,progress);
  }
  if (recapInfo.latest) {
    const latest = recapInfo.latest;
    const recapBox = node('section', null, 'detail-section overview-recap-card');
    recapBox.setAttribute('aria-label', '最新阶段总结预览');
    const headRow = node('div', null, 'overview-recap-head');
    const titleLeft = node('div', null, 'conversation-recap-title');
    add(titleLeft, node('h4', '最新阶段总结'), node('span', recapInfo.count > 1 ? `第 ${recapInfo.count} 版` : RECAP_STANCE, 'conversation-tag recap'));
    const statusRight = node('div', null, 'conversation-recap-actions');
    if (recapInfo.newerCount === 0) add(statusRight, node('span', '已覆盖当前讨论', 'chip recap-fresh-chip'));
    else add(statusRight, node('span', `之后新增 ${recapInfo.newerCount} 条讨论`, 'chip warn-chip'));
    add(headRow, titleLeft, statusRight);
    const overviewRecapMeta = node('p', null, 'conversation-recap-meta');
    overviewRecapMeta.append(renderAgentName(String(latest.agent || '未知作者'), { role: latest.role }));
    const overviewRecapStamp = formatShortTime(latest.created_at);
    if (overviewRecapStamp) overviewRecapMeta.append(document.createTextNode(` · ${overviewRecapStamp}`));
    const footerActions = node('div', null, 'actions');
    add(footerActions,
      button(`查看全部阶段总结（${recapInfo.count}）`, () => {
        if (openConversationFilter) openConversationFilter('recap');
        tabs.select('conversation');
      }, 'text-button'),
      button('进入完整讨论', () => {
        if (openConversationFilter) openConversationFilter('all');
        tabs.select('conversation');
      }, 'text-button')
    );
    add(recapBox, headRow, overviewRecapMeta, readingUI.text(latest.content, 'overview-recap-body', { limit: 280 }));
    const overviewGlossary = renderRecapRefGlossary(
      latest.content,
      debateById,
      id => {
        tabs.select('conversation');
        if (jumpConversationFloor) jumpConversationFloor(id);
      },
      (id, anchor) => floorRefsUI.open(id, anchor, 'debate')
    );
    if (overviewGlossary) add(recapBox, overviewGlossary);
    add(recapBox, footerActions);
    add(overview, recapBox);
  }
  add(overview, renderTaskFlow(data, {node, openTask, api, renderText: (value, className) => readingUI.text(value,className,{limit:240}), onNavigate: tab => {
    tabs.select(tab === 'arrange' ? 'overview' : tab);
    if (tab === 'arrange') {arrangements.open = true; arrangements.scrollIntoView({block: 'start', behavior: 'smooth'});}
  }}));
  add(overview, renderTaskRoles(data, {node, agents: planAuthors, renderAgentName}));
  const subs = data.workflow?.subtasks || [];
  if (subs.length) {
    const progress = section('分工进度');
    add(progress, node('p', `${subs.filter(item => item.state === 'done').length}/${subs.length} 项已完成`, 'muted'));
    add(overview, progress);
  }
  if (task.detail) {
    const brief = section('任务说明');
    add(brief, readingUI.text(task.detail, 'task-intro', {limit: 280}));
    add(overview, brief);
  }
  if (data.collaboration?.help_wanted) {
    const hint = node("section", null, "detail-section collaboration-hint");
    const labels = { claim: "认领", debate: "参与讨论", challenge: "提出质疑", supplement: "补充来源", respond: "回应问题", outcome: "整理成果", review: "独立核查", coordinate: "协调分工", wait: "等待恢复" };
    add(hint, node("h4", "协作提示"), node("p", data.collaboration.reason || "还需要其他 Agent 参与。", "muted"));
    if (data.collaboration.suggested_action) add(hint, node("span", `建议 Agent：${labels[data.collaboration.suggested_action] || data.collaboration.suggested_action}`, "badge help-wanted"));
    add(overview, hint);
  }

  const currentSummary = data.workflow?.outcomes?.[0]?.summary || task.result_summary;
  if (currentSummary) {
    const preview = section('成果预览');
    add(preview, readingUI.text(currentSummary, 'outcome-preview', {limit: 200}), button('阅读成果', () => tabs.select('outcome'), 'text-button'));
    add(overview, preview);
  }
  const arrangements = node('details', null, 'work-editor arrangements-fold');
  add(arrangements, node('summary', '任务设置与管理'));
  const arrange = node('div'); add(arrangements, arrange); add(overview, arrangements);
  if (task.status === 'proposed') {
    const controls = detailActions(task, data.verify_readiness, data.workflow);
    if (controls) add(overview, controls);
    if (task.plan?.collaboration === 'hosted' && !data.workflow?.host_id) arrangements.open = true;
  }
  const management = detailActions(task, data.verify_readiness, data.workflow, {management: true});
  if (management) add(arrange, management);

  // 成果和核查分别阅读，长正文与来源不会再把页签推到下方。
  const extras = node("div", null, "outcome-extras");
  const outcomeBlock = outcomeView.summaryBlock(task, data, {
    heading: "当前成果",
    onJumpFloor: id => {
      tabs.select('conversation');
      if (jumpConversationFloor) jumpConversationFloor(id);
    },
    onOpenFloor: (id, anchor) => floorRefsUI.open(id, anchor, 'debate'),
  });
  add(outcome, outcomeBlock);
  const versionHistory = outcomeView.versionHistory(task, data);
  if (versionHistory) add(outcome, versionHistory);
  const taskFiles = outcomeView.taskFilesStrip(task);
  if (taskFiles) add(outcome, taskFiles);
  add(outcome, extras);
  if (task.status === 'review' || currentSummary) add(review, outcomeView.summaryBlock(task, data, {heading: '本次交付', compact: true}));

  const readiness = node("section", null, "work-section verify-checks");
  add(readiness, node("h4", "核对条件"));
  const checks = data.verify_readiness?.checks || [];
  for (const check of checks) {
    const item = node("div", null, `check ${check.na ? "na" : check.met ? "met" : ""}`);
    add(item, node("span", check.na ? "—" : check.met ? "✓" : "!", "indicator"), node("span", `${check.na ? "不适用 · " : ""}${check.label} · ${check.detail}`));
    add(readiness, item);
  }
  if (!checks.length) add(readiness, node("p", "没有额外的核对条件。", "muted"));
  add(review, readiness);
  if (task.status === 'review') {
    const controls = detailActions(task, data.verify_readiness, data.workflow);
    if (controls) add(review, controls);
  }

  workUI.renderTask(data, { outcome: extras, review, arrange });
  if (!arrange.childElementCount) add(arrange, node("p", "这条任务没有额外设置。", "muted"));
  if (data.force_approvals?.length) {
    const audits = section("强制通过记录");
    for (const row of data.force_approvals) add(audits, entry(row.agent, row.reason, row.created_at));
    add(review, audits);
  }

  const form = debateForm(task, data.debate || []);
  const conversationView = renderTaskConversation(data, form ? item => {
    const stanceEl = form.querySelector('select[name="stance"]');
    if (stanceEl && stanceEl.value === RECAP_STANCE) {
      stanceEl.value = "补充";
      stanceEl.dispatchEvent(new Event("change"));
    }
    const reply = form.querySelector('select[name="reply_to"]');
    reply.value = String(item.id);
    reply.dispatchEvent(new Event("change"));
    form.scrollIntoView({ block: "center" });
    form.querySelector('textarea[name="content"]').focus();
  } : null);
  openConversationFilter = conversationView.setFilter;
  jumpConversationFloor = conversationView.jumpToFloor;
  if (form) add(conversationView.root, form);
  add(conversation, conversationView.root);

  // 全页签统一注入引用上下文（发言 #id / 问题 #id / 成果 #id / 子任务 #id），
  // 任意页签均可悬停预览、点击原地打开引用详情窗口，并支持跨页签定位与返回。
  floorRefsUI.setContext(data, {
    currentTab: () => state.detailTab?.key || 'overview',
    selectTab: key => tabs.select(key),
    onJumpFloor: id => {
      tabs.select('conversation');
      if (jumpConversationFloor) jumpConversationFloor(id);
    },
    onJumpIssue: id => {
      tabs.select('review');
      const el = document.getElementById(`issue-${id}`);
      if (el) flash(el);
    },
    onJumpOutcome: id => {
      tabs.select('outcome');
      const el = document.getElementById(`outcome-${id}`) || outcomeBlock;
      if (el) flash(el);
    },
    onJumpSubtask: id => {
      tabs.select('overview');
      arrangements.open = true;
      const el = document.getElementById(`subtask-${id}`);
      if (el) flash(el);
    },
  });
  for (const panel of [overview, outcome, review, conversation]) floorRefsUI.decorate(panel);

  if (restore) restore();
  target.parentElement.scrollTop = scrollTop;
  if (sameTask && state.view === 'tasks' && state.reading.tasks && winScrollY > 0) window.scrollTo(0, winScrollY);
}
async function selectTask(id, {tab = null} = {}) {
  if (state.selected !== id) {
    state.detailTab = {taskId: id, key: tab || 'overview'};
    state.detail = null;
    const target = clear($("taskDetail"));
    delete target.dataset.renderedTaskId;
    target.classList.add("empty");
    target.textContent = "正在载入任务…";
    target.parentElement.scrollTop = 0;
  }
  if (tab) state.detailTab = {taskId: id, key: tab};
  state.selected = id;
  const request = ++detailRequest, user = state.user;
  renderTasks();
  try {
    const [data] = await Promise.all([api(`/api/tasks/${id}`), ensureTaskUI(), ensureParticipants()]);
    if (request !== detailRequest || state.selected !== id || state.user !== user) return;
    state.detail = data;
    renderTasks();
    renderTaskDetail(data);
  } catch (error) {
    if (request !== detailRequest || state.selected !== id || state.user !== user) return;
    if (!state.detail) $('taskDetail').textContent = `无法载入任务：${error.message}`;
    throw error;
  }
}
function showSecrets(account) {
  const target = clear($("issuedSecrets"));
  add(target, node("strong", `${account.name || account.username} 的凭据（仅显示一次，请私下交给本人）`));
  for (const [key, label] of [["password", "控制台登录密码"], ["muse_token", "个人发布令牌"], ["token", "Agent API 令牌"]]) {
    if (account[key]) add(target, node("pre", `${label}：${account[key]}`));
  }
  target.dataset.accountId = String(account.id);
  target.hidden = false;
  target.scrollIntoView({ block: "center" });
}
function confirmAccountAction(item, message, label, onConfirm, destructive = false) {
  item.querySelector(".account-confirm")?.remove();
  const box = node("div", null, "account-confirm");
  const error = node("p", "", "error");
  error.setAttribute("role", "alert");
  const controls = node("div", null, "action-row");
  add(controls, button(label, async () => {
    error.textContent = "";
    try { await onConfirm(); box.remove(); }
    catch (cause) { error.textContent = cause.message; }
  }, destructive ? "danger" : "primary"), button("取消", () => box.remove()));
  add(box, node("p", message), controls, error);
  item.append(box);
  box.scrollIntoView({ block: "nearest" });
}
function editAccountName(item, kind, person) {
  item.querySelector(".account-confirm")?.remove();
  const form = node("form", null, "account-confirm account-edit");
  const label = node("label", "显示名称");
  const input = node("input");
  input.name = "name"; input.maxLength = 80; input.required = true; input.value = person.name;
  label.append(input);
  const actions = node("div", null, "action-row");
  const save = node("button", "保存名称", "primary"); save.type = "submit";
  add(actions, save, button("取消", () => form.remove()));
  const error = node("p", "", "error"); error.setAttribute("role", "alert");
  add(form, label, node("p", "只改显示名称；账号、令牌和已认领任务保持不变。", "muted"), actions, error);
  form.addEventListener("submit", async event => {
    event.preventDefault(); save.disabled = true; error.textContent = "";
    try {
      const changed = await api(`/api/admin/${kind}/${person.id}/name`, "POST", { name: input.value });
      if (kind === "users" && person.id === state.user.id) {
        state.user.name = changed.name;
        $("signedInAs").textContent = `${changed.name} · ${roleText[state.user.role] || state.user.role}`;
      }
      const issued = $("issuedSecrets");
      if (issued.dataset.accountId === String(person.id)) {
        const heading = issued.querySelector("strong");
        if (heading) heading.textContent = `${changed.name} 的凭据（仅显示一次，请私下交给本人）`;
      }
      await refreshAccounts(); notify("显示名称已更新");
    } catch (cause) { error.textContent = cause.message; }
    finally { save.disabled = false; }
  });
  item.append(form);
  input.focus(); form.scrollIntoView({ block: "nearest" });
}
async function refreshAccounts() {
  const user = state.user;
  const [users, agents] = await Promise.all([api("/api/admin/users"), fetchAdminAgents(), ensureAccountsUI()]);
  if (state.user !== user || user?.role !== 'admin') return;
  adminAgents = Array.isArray(agents.accounts) ? agents.accounts : [];
  participantsUser = null;
  for (const [kind, rows, targetId] of [["users", users.accounts, "users"], ["agents", agents.accounts, "agents"]]) {
    const target = clear($(targetId));
    for (const person of rows) {
      const item = node("div", null, "account-item");
      if (kind === 'agents') item.dataset.agentAccountId = String(person.id);
      const row = node("div", null, "account-row");
      const info = node("div", null, "account-info");
      if (kind === 'agents') {
        const heading = node("div", null, "account-name-row");
        const titleWrap = node("strong", null, "account-agent-heading");
        add(titleWrap, renderAgentName(person.name, { id: person.id, role: "agent", className: "account-agent-trigger" }), document.createTextNode(` · ${roleText[person.role] || person.role}`));
        const directiveSlot = node("span", null, "account-directive-slot");
        const pendingBadge = quotasUI.makeDirectiveBadge(person.pending_directives);
        if (pendingBadge) directiveSlot.append(pendingBadge);
        add(heading, titleWrap, quotasUI.makePill(person.quota), directiveSlot);
        add(info, heading, node("span", `${person.username}${person.active ? "" : " · 已停用"}`, "account-sub"));
      } else {
        add(info, node("strong", `${person.name} · ${roleText[person.role] || person.role}`), node("span", `${person.username}${person.active ? "" : " · 已停用"}`, "account-sub"));
      }
      add(row, info);
      const controls = node("div", null, "action-row");
      if (kind === 'agents') {
        add(controls, button("详情", () => quotasUI.openDetail(person), "secondary agent-detail-btn"));
        if (person.active) add(controls, button("留言", () => quotasUI.openDetail(person, { focusDirective: true }), "secondary agent-directive-btn"));
      }
      add(controls, button("改名", () => editAccountName(item, kind, person)));
      if (person.active && person.id !== state.user.id) {
        add(controls, button("轮换", () => confirmAccountAction(item, `轮换 ${person.name} 的凭据？旧凭据将立即失效。`, "确认轮换", async () => {
          const changed = await api(`/api/admin/${kind}/${person.id}/rotate`, "POST", {});
          showSecrets({ ...changed, name: person.name }); notify("新凭据已签发");
        })), button("停用", () => confirmAccountAction(item, `停用 ${person.name}？其会话和令牌将立即失效。`, "确认停用", async () => {
          await api(`/api/admin/${kind}/${person.id}/revoke`, "POST", {});
          const issued = $("issuedSecrets");
          if (issued.dataset.accountId === String(person.id)) {
            clear(issued); issued.hidden = true; delete issued.dataset.accountId;
          }
          await refreshAccounts(); notify("账号已停用");
        }, true), "danger"));
      }
      add(row, controls);
      add(item, row);
      if (kind === 'agents') {
        add(item, quotasUI.renderCompactSummary(person, () => quotasUI.openDetail(person)));
        add(item, visitsUI.render(person));
      }
      add(target, item);
    }
  }
  quotasUI.syncAgents(agents.accounts || []);
}

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault(); $("loginError").textContent = "";
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try { const result = await api("/api/auth/login", "POST", data); form.reset(); await startBoard(result.user); }
  catch (error) { $("loginError").textContent = error.message; }
});
$("logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", "POST", {}); } catch { /* expired session */ }
  showLogin();
  history.replaceState(null, '', location.pathname);
});
$("refresh").addEventListener("click", () => refresh().catch(error => notify(error.message, true)));
function updateTaskFilter() {
  resetTaskReader(); state.reading.tasks = false;
  renderTasks(); syncReaders(); recordNavigation(true);
}
$("statusFilter").addEventListener("change", updateTaskFilter);
$("taskKindFilter").addEventListener("change", updateTaskFilter);
$('taskSearch').addEventListener('input', updateTaskFilter);
$('taskSort').addEventListener('change', () => {
  try { localStorage.setItem(`whiteboard.taskSort.${state.user.id}`, $('taskSort').value); } catch { /* storage unavailable */ }
  $('taskList').scrollTop = 0;
  renderTasks();
  recordNavigation(true);
});
$("messageScopeAll").addEventListener("click", () => setChannel(""));
document.addEventListener("click", event => {
  const menu = $("workspaceMenu");
  if (menu?.open && !menu.contains(event.target)) menu.open = false;
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  for (const id of ["workspaceMenu", "createTaskBox", "createChannelBox", "uploadFileBox"]) {
    const el = $(id);
    if (el?.open) el.open = false;
  }
});

$("taskForm").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
  try {
    const plan = taskPlanEditor.read();
    const hostId = taskPlanEditor.readHostId();
    const isDebate = plan.goal === 'active_debate';
    const result = await api("/api/tasks", "POST", {
      title: data.title,
      detail: data.detail,
      deadline: isDebate ? '' : (data.deadline || ''),
      plan,
      ...(hostId != null ? { host_id: hostId } : {}),
      type: legacyType(plan.goal),
      channelId: null,
    });
    form.reset();
    taskPlanEditor = mountCreatePlanEditor();
    $("createTaskBox").open = false;
    notify("任务已发布"); await refresh(); await openTask(result.id);
  } catch (error) { notify(error.message, true); }
});
$("channelForm").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget;
  try {
    const created = await api("/api/channels", "POST", Object.fromEntries(new FormData(form)));
    form.reset(); $("createChannelBox").open = false;
    if (created?.id) state.channelId = String(created.id);
    notify("频道已创建"); await refresh();
  } catch (error) { notify(error.message, true); }
});
$("messageForm").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget;
  const targetChannel = state.channelId || $('postChannelSelect')?.value || state.channels[0]?.id || 1;
  try {
    await api("/api/messages", "POST", { text: new FormData(form).get("text"), channelId: Number(targetChannel) });
    form.reset(); notify("留言已发送"); await refreshMessages();
  } catch (error) { notify(error.message, true); }
});
for (const [formId, resource] of [["userForm", "users"], ["agentForm", "agents"]]) {
  $(formId).addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget;
    try { const result = await api(`/api/admin/${resource}`, "POST", Object.fromEntries(new FormData(form))); showSecrets(result); form.reset(); notify("账号已创建，请私下交付凭据"); await refreshAccounts(); }
    catch (error) { notify(error.message, true); }
  });
}
async function startBoard(user) {
  const route = routeFromHash();
  for (const id of ['workspace', 'primaryNav', 'topbarTools']) $(id).inert = true;
  $('workspace').setAttribute('aria-busy', 'true');
  showBoard(user);
  try {
    await refresh({ initial: true });
  } finally {
    for (const id of ['workspace', 'primaryNav', 'topbarTools']) $(id).inert = false;
    $('workspace').removeAttribute('aria-busy');
  }
  if (state.user !== user) return;
  await restoreNavigation(route);
  if (state.user === user) { historyReady = true; recordNavigation(true); }
}
export async function startApp(session) {
  try {
    const result = await session;
    if (!result.ok) { showLogin(); return; }
    await startBoard(result.data.user);
  } catch (error) {
    if (state.user) notify(error.message, true);
    else showLogin();
  }
}
let backgroundRefreshPending = false;
async function backgroundRefresh() {
  if (!state.user || document.hidden || foregroundRefresh || backgroundRefreshPending) return;
  const request = refreshRequest, user = state.user;
  backgroundRefreshPending = true;
  try {
    const jobs = [];
    if (taskListETag) jobs.push((async () => {
      const data = await fetchTaskList(taskListETag);
      if (data && request === refreshRequest && state.user === user) applyTaskList(data);
    })());
    const mailboxVisible = state.view === 'home' || (state.view === 'settings' && state.settings === 'accounts')
      || document.getElementById('agentDetailModal')?.hidden === false;
    // Mailbox age can cross its timeout while task data stays unchanged (304).
    // Refresh it independently, including empty boards without a task ETag.
    if (user.role === 'admin' && mailboxVisible) jobs.push(refreshHomeAgents());
    await Promise.allSettled(jobs);
  }
  catch {}
  finally { backgroundRefreshPending = false; }
}
setInterval(backgroundRefresh, 120_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) backgroundRefresh(); });
