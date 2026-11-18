import { createCollaborationUI } from './collaboration.js';
import { createAgentGuideUI } from './agent-guide.js';
import { GOALS, legacyGoal, legacyType } from './task-model.js';
import { createPlanEditor, reportLink } from './task-plan-ui.js';
import { createOutcomeView } from './outcome-view.js';
import { createReadingUI } from './reading.js';
import { createWorkbench } from './workbench.js';
import { renderTaskRoles } from './task-roles.js';
import { renderTaskFlow } from './task-flow.js';
import { createAgentVisitsUI } from './agent-visits.js';

const $ = id => document.getElementById(id);
const state = { user: null, channels: [], channelId: '', allTasks: [], tasks: [], outcomeTasks: [], selected: null, detail: null, view: 'home', outcomeSelected: null, outcomeDetail: null, detailTab: null, reading: {tasks: false, outcomes: false, community: false}, settings: 'guide', home: null, topicSelected: null };
let detailRequest = 0;
let outcomeRequest = 0;
let refreshRequest = 0;
const statusText = { open: "待认领", in_progress: "进行中", review: "待核对", proposed: "待审批", done: "已完成", closed: "已关闭" };
const taskType = task => task.plan?.goal || task.goal || legacyGoal(task.type);
const taskStatus = task => taskType(task)==='active_debate'&&task.status==='open'?'激辩开放':statusText[task.status]||task.status;
const typeBadge = task => node("span", GOALS[taskType(task)] || taskType(task), `badge task-type ${taskType(task)}`);
const roleText = { admin: "管理员", publisher: "发布者", viewer: "只读成员", agent: "Agent" };
// 成果视图只收纳「已提交成果」与「已完成」两类任务。
const OUTCOME_STATUS = ['review', 'done'];
const VIEW_META = {
  home: { title: '工作台', hint: '先处理需要你决定的事，再看最新成果。' },
  tasks: { title: '任务', hint: '查看进度、负责人和卡点。' },
  outcomes: { title: '成果', hint: '先看答案，详情和来源按需展开。' },
  community: { title: '交流', hint: '话题与频道讨论。' },
  settings: { title: '管理与工具', hint: '成员、Agent、工作指南与积分。' },
};
let taskPlanEditor = createPlanEditor({ node }), planAuthors = [];
$("taskPlanFields").append(taskPlanEditor.root);
const readingUI = createReadingUI({ node });
const outcomeView = createOutcomeView({ node, linkedText, sources: readingUI.sources });
const workUI = createCollaborationUI({ api, node, linkedText, button, user: () => state.user, selectTask: openTask, onTopicOpen: revealTopic, notify, flash, onParticipants: authors => { planAuthors = authors; taskPlanEditor.setAuthors(authors); } });
const guideUI = createAgentGuideUI({ api, node, button, markdown: readingUI.markdown, user: () => state.user, notify });
const visitsUI = createAgentVisitsUI({api, node, user: () => state.user});
const workbench = createWorkbench({node, button, openTask, openOutcome, showTasks: () => showView('tasks')});

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
async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.includes("/auth/login")) showLogin();
    const error=new Error(data.error || `请求失败（${response.status}）`);error.status=response.status;throw error;
  }
  return data;
}

// ---- 主导航与浏览器历史：手机一次只显示列表或详情。----
const navTabs = [...document.querySelectorAll('.nav-tab')];
const VIEW_PANELS = { home: $('viewHome'), tasks: $('viewTasks'), outcomes: $('viewOutcomes'), community: $('viewCommunity'), settings: $('viewSettings') };
let historyReady = false;
history.scrollRestoration = 'manual';
function navigationState() {
  return {view: state.view, reading: {...state.reading}, taskId: state.selected, outcomeId: state.outcomeSelected, topicId: state.topicSelected, tab: state.detailTab?.key || 'overview', settings: state.settings,
    status: $('statusFilter').value, channel: state.channelId, search: $('taskSearch').value, sort: $('taskSort').value,
    scroll: window.scrollY, listScroll: $('taskList').scrollTop, outcomeScroll: [...document.querySelectorAll('.outcome-list')].map(list => list.scrollTop)};
}
function locationHash() {
  if (state.view === 'tasks' && state.reading.tasks && state.selected) return `#tasks/${state.selected}/${state.detailTab?.key || 'overview'}`;
  if (state.view === 'outcomes' && state.reading.outcomes && state.outcomeSelected) return `#outcomes/${state.outcomeSelected}`;
  if (state.view === 'community' && state.reading.community && state.topicSelected) return `#community/${state.topicSelected}`;
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
function showView(name, { focusTab = false, record = true } = {}) {
  if (!VIEW_PANELS[name]) name = 'home';
  if (record) {
    saveNavigation();
    if (name in state.reading) state.reading[name] = false;
  }
  state.view = name;
  $('workspaceMenu').open = false;
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
  if (record && name === 'community') refreshMessages().catch(error => notify(error.message, true));
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
  if (!['accounts', 'guide', 'ranking'].includes(name) || (name === 'accounts' && state.user?.role !== 'admin')) name = 'guide';
  if (record) saveNavigation();
  state.settings = name;
  showView('settings', {record: false});
  for (const tab of document.querySelectorAll('.settings-tab')) {
    const selected = tab.dataset.settings === name;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    tab.classList.toggle('active', selected);
  }
  $('adminPanel').hidden = name !== 'accounts';
  $('agentGuidePanel').hidden = name !== 'guide';
  $('rankingPanel').hidden = name !== 'ranking';
  $('workspaceMenu').open = false;
  if (record) { recordNavigation(); window.scrollTo(0, 0); }
}
for (const control of document.querySelectorAll('#workspaceMenu [data-settings]')) control.addEventListener('click', () => showSettings(control.dataset.settings));
wireNav([...document.querySelectorAll('.settings-tab')], tab => {showSettings(tab.dataset.settings); tab.focus();});
for (const control of document.querySelectorAll('[data-view-link]')) control.addEventListener('click', () => showView(control.dataset.viewLink));
function backToList(view) {
  if (history.state?.canBack) history.back();
  else showView(view);
}
$('taskBack').addEventListener('click', () => backToList('tasks'));
$('outcomeBack').addEventListener('click', () => backToList('outcomes'));
$('topicBack').addEventListener('click', () => backToList('community'));
function revealTopic(id) {
  if (state.view === 'community' && state.reading.community && state.topicSelected === id) return;
  saveNavigation();
  state.topicSelected = id;
  state.reading.community = true;
  showView('community', {record: false});
  recordNavigation(); window.scrollTo(0, 0);
}
function routeFromHash() {
  const [view = 'home', id, tab] = location.hash.slice(1).split('/');
  const route = {view: VIEW_PANELS[view] ? view : 'home', reading: {tasks: false, outcomes: false, community: false}, tab: ['overview', 'outcome', 'review', 'conversation'].includes(tab) ? tab : 'overview'};
  if (view === 'settings') route.settings = id;
  else if (['tasks', 'outcomes', 'community'].includes(view) && /^\d+$/.test(id || '')) {
    route.reading[view] = true;
    route[view === 'tasks' ? 'taskId' : view === 'outcomes' ? 'outcomeId' : 'topicId'] = Number(id);
  }
  return route;
}
async function restoreNavigation(route) {
  const was = state.view;
  if (route.status != null) $('statusFilter').value = route.status;
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
  if (route.reading?.community && route.topicId) {
    state.topicSelected = route.topicId;
    await workUI.showTopic(route.topicId);
  }
  if (was !== state.view && state.view === 'community') refreshMessages().catch(error => notify(error.message, true));
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
  historyReady = false;
  refreshRequest++;
  outcomeRequest++;
  resetTaskReader();
  state.outcomeSelected = null;
  state.outcomeDetail = null;
  workUI.reset();
  guideUI.reset();
  visitsUI.reset();
  resetOutcomeReader();
  state.tasks = [];
  state.allTasks = [];
  state.channels = [];
  state.outcomeTasks = [];
  state.channelId = "";
  state.detailTab = null;
  state.view = 'home';
  state.reading = {tasks: false, outcomes: false, community: false};
  state.topicSelected = null;
  state.home = null;
  $('statusFilter').value = 'active';
  $('taskSearch').value = '';
  $('taskSort').value = 'desc';
  $('workspaceMenu').open = false;
  clear($("messages"));
  clear($("leaderboard"));
  clear($('users')); clear($('agents')); renderChannels();
  workbench.render([], null, null);
  renderTasks();
  visible("workspace", false);
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
  } catch { $('taskSort').value = 'desc'; }
  $("signedInAs").textContent = `${user.name} · ${roleText[user.role] || user.role}`;
  visible("loginView", false);
  visible("identity", true);
  visible("workspace", true);
  visible("accountsMenu", user.role === "admin");
  visible("settings-accounts", user.role === "admin");
  visible("createChannelBox", user.role === "admin");
  visible("createTaskBox", user.role === "admin" || user.role === "publisher");
  visible("messageForm", user.role === "admin" || user.role === "publisher");
  showView(state.view, {record: false});
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
function entry(title, content, time) {
  const card = node("div", null, "entry");
  const header = node("header");
  add(header, node("strong", title), node("small", time || ""));
  add(card, header, linkedText(content));
  return card;
}
function section(title) {
  const box = node("section", null, "detail-section");
  add(box, node("h4", title));
  return box;
}

// ---- 任务对话：chronological 合并发言、质疑与补充，回复用引用卡关联 ----
function excerpt(value, size = 100) { return Array.from(String(value || "").trim()).slice(0, size).join(""); }
function renderTaskConversation(data, onReply = null) {
  const box = section("任务对话");
  const thread = node("div", null, "conversation");
  const debate = data.debate || [];
  const byId = new Map(debate.filter(item => Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0).map(item => [Number(item.id), item]));
  const rows = [
    ...debate.map(item => ({ kind: "debate", item })),
    ...(data.challenges || []).map(item => ({ kind: "challenge", item })),
    ...(data.supplements || []).map(item => ({ kind: "supplement", item })),
  ].map((row, index) => ({ ...row, index, time: Date.parse(row.item.created_at) }));
  rows.sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity) || a.index - b.index);
  let firstVisible = Math.max(0, rows.length - 10);
  const more = button('', () => {
    firstVisible = Math.max(0, firstVisible - 10);
    [...thread.children].forEach((message, index) => {message.hidden = index < firstVisible;});
    updateMore();
  }, 'text-button conversation-more');
  function updateMore() {more.hidden = !firstVisible; more.textContent = `查看更早的讨论（${firstVisible}）`;}
  updateMore(); add(box, more);
  for (const [position, { kind, item, time }] of rows.entries()) {
    const message = node("article", null, `conversation-message ${kind}${item.role === "human" ? " human" : ""}`);
    message.hidden = position < firstVisible;
    message.dataset.kind = kind;
    // 只有辩论发言有 #debate-id；质疑/补充的 id 可能相同，不能拿来互相跳转。
    if (kind === "debate" && Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0) {
      message.id = `debate-${item.id}`;
      message.dataset.debateId = String(item.id);
    }
    const name = String(item.agent || "未知作者");
    const avatar = node("span", Array.from(name.trim())[0] || "?", "conversation-avatar");
    avatar.setAttribute("aria-hidden", "true");
    const header = node("header", null, "conversation-header");
    const label = kind === "debate" ? item.stance : kind === "challenge" ? "质疑" : `补充 v${item.version}`;
    add(header, node("strong", name, "conversation-speaker"), node("span", item.role === "human" ? "成员" : "Agent", "conversation-role"), node("span", label, `conversation-tag ${kind}`));
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
        quote.setAttribute("aria-label", `跳到 ${cited.agent || "未知作者"} 的第 ${replyId} 条发言`);
        add(quote, node("span", `↳ 回复 ${cited.agent || "未知作者"} · #${replyId}`, "reply-target"), node("small", excerpt(cited.content), "reply-excerpt"));
        quote.addEventListener("click", event => {
          event.preventDefault();
          flash(document.getElementById(`debate-${replyId}`));
        });
        message.classList.add("is-reply");
      } else add(quote, node("span", `↳ 引用 #${item.reply_to} · 原发言不可见`, "reply-target"));
      add(bubble, quote);
    }
    const content = kind === "debate" ? item.content : kind === "challenge" ? item.reason : item.summary;
    add(bubble, linkedText(content));
    const links = kind === "debate" ? item.links : kind === "challenge" ? item.evidence : item.links;
    if (links) add(bubble, node("span", kind === "supplement" ? "来源" : "证据", "conversation-source-label"), linkedText(links, "link-list"));
    if (kind === "debate" && onReply && message.dataset.debateId) {
      const respond = button("回复", () => onReply(item), "text-button");
      respond.setAttribute("aria-label", `回复 ${name}`);
      add(bubble, respond);
    }
    add(message, avatar, header, bubble);
    add(thread, message);
  }
  if (!rows.length) add(thread, node("p", "暂无讨论，欢迎分享观点。", "muted conversation-empty"));
  add(box, thread);
  return box;
}

// ---- 任务列表与频道筛选 ----
function resetTaskReader() {
  detailRequest++;
  state.selected = null;
  state.detail = null;
  state.detailTab = null;
  const target = clear($("taskDetail"));
  target.classList.add("empty");
  target.classList.remove("has-workflow");
  target.textContent = "选择一条任务查看详情与操作。";
}
// 频道用紧凑 chip 做筛选；选中状态用 aria-pressed 标出。
function renderChannels() {
  const value = state.channelId;
  const chips = clear($("channelList"));
  const all = node("button", "全部频道", "channel-chip" + (value ? "" : " active"));
  all.type = "button";
  all.setAttribute("aria-pressed", String(!value));
  all.addEventListener("click", () => setChannel(""));
  add(chips, all);
  for (const channel of state.channels) {
    const active = String(channel.id) === value;
    const chip = node("button", channel.name, "channel-chip" + (active ? " active" : ""));
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(active));
    chip.title = channel.topic ? `${channel.name} · ${channel.topic}` : channel.name;
    chip.addEventListener("click", () => setChannel(String(channel.id)));
    add(chips, chip);
  }
  if (!state.channels.length) add(chips, node("span", "暂无频道", "muted channel-empty"));
}
function setChannel(id) {
  saveNavigation();
  state.channelId = id;
  resetTaskReader();
  state.reading.tasks = false;
  syncReaders(); recordNavigation(true);
  refresh().catch(error => notify(error.message, true));
}
function renderTasks() {
  const status = $('statusFilter').value, query = $('taskSearch').value.trim().toLocaleLowerCase();
  state.tasks = state.allTasks.filter(task => {
    if (status === 'active' && ['done', 'closed'].includes(task.status)) return false;
    if (status && status !== 'active' && task.status !== status) return false;
    if (state.channelId && String(task.channel_id) !== state.channelId) return false;
    return !query || [task.title, task.claimed_by, task.host, task.created_by, task.collaboration?.reason].some(value => String(value || '').toLocaleLowerCase().includes(query));
  });
  const direction = $('taskSort').value === 'asc' ? 1 : -1;
  state.tasks.sort((a, b) => {
    const aTime = Date.parse(a.created_at), bTime = Date.parse(b.created_at);
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) return direction * (aTime - bTime || a.id - b.id);
    if (Number.isFinite(aTime)) return -1;
    if (Number.isFinite(bTime)) return 1;
    return 0;
  });
  const scrollTop = $('taskList').scrollTop, list = clear($("taskList"));
  $("taskCount").textContent = `${state.tasks.length} 条`;
  for (const task of state.tasks) {
    const active = state.selected === task.id;
    const item = node("button", null, "task-item" + (active ? " active" : ""));
    item.type = "button";
    item.setAttribute("aria-pressed", String(active));
    add(item, node("strong", task.title));
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
  renderOutcomeLists();
}
async function refreshMessages() {
  const channelId = state.channelId, user = state.user;
  const result = await api(`/api/messages${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''}`);
  if (state.user === user && state.channelId === channelId) renderMessages(result.messages || []);
}
function renderMessages(messages) {
  const target = clear($("messages"));
  for (const message of messages) add(target, entry(`${message.author} · ${message.role === "human" ? "成员" : "Agent"}`, message.text, message.created_at));
  if (!messages.length) add(target, node("p", "还没有讨论，欢迎发出第一条消息。", "muted"));
  const channelId = state.channelId;
  const channel = state.channels.find(row => String(row.id) === channelId);
  $("messageScope").textContent = channel ? channel.name : "全部频道";
  $("messageScopeAll").hidden = !channel;
}
function renderLeaderboard(rows) {
  const target = clear($("leaderboard"));
  for (const [i, row] of rows.entries()) {
    const line = node("div", null, "entry");
    add(line, node("span", `${i + 1}. ${row.agent}`), node("span", `${row.points} 分`, "score"));
    add(target, line);
  }
  if (!rows.length) add(target, node("p", "暂无积分记录。", "muted"));
}

// ---- 成果视图：列表按待核对 / 已完成分组，右侧是只读成果阅读区 ----
const OUTCOME_GROUPS = [
  { status: "review", list: "outcomeListReview", count: "outcomeReviewCount", empty: "没有待核对的成果。" },
  { status: "done", list: "outcomeListDone", count: "outcomeDoneCount", empty: "还没有已完成的成果。" },
];
function renderOutcomeLists() {
  for (const group of OUTCOME_GROUPS) {
    const scrollTop = $(group.list).scrollTop, list = clear($(group.list));
    const rows = state.outcomeTasks.filter(task => task.status === group.status);
    $(group.count).textContent = String(rows.length);
    for (const task of rows) {
      const active = state.outcomeSelected === task.id;
      const item = node("button", null, "outcome-item" + (active ? " active" : ""));
      item.type = "button";
      item.setAttribute("aria-pressed", String(active));
      add(item, node("strong", task.title));
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
}
function resetOutcomeReader() {
  state.outcomeDetail = null;
  const target = clear($("outcomeDetail"));
  target.classList.add("empty");
  target.textContent = "从左侧选择一条成果开始阅读。";
}
function originalSubmission(data) {
  const task = data.task;
  if (!data.workflow?.outcomes?.length || (!task.result_summary && !task.result_links)) return null;
  const box = node("details", null, "work-editor original-submission");
  add(box, node("summary", "原始提交与来源"));
  if (task.result_summary) add(box, linkedText(task.result_summary));
  if (task.result_links) add(box, linkedText(task.result_links, "link-list"));
  return box;
}
function renderOutcomeReader(data) {
  const restore = disclosureState($('outcomeDetail'));
  const scrollTop = $('outcomeDetail').parentElement.scrollTop;
  state.outcomeDetail = data;
  const task = data.task;
  const target = clear($("outcomeDetail"));
  target.classList.remove("empty");
  const head = node("div", null, "detail-head");
  add(head, node("span", taskStatus(task), `badge ${task.status}`), typeBadge(task), node("h3", task.title));
  add(target, head);
  add(target, outcomeView.summaryBlock(task, data, { heading: "成果总结" }));
  const original = originalSubmission(data);
  if (original) add(target, original);
  const outcomes = data.workflow?.outcomes || [];
  if (outcomes.length > 1) {
    const history = node("details", null, "work-editor");
    add(history, node("summary", `历史成果（${outcomes.length - 1}）`));
    for (const outcome of outcomes.slice(1)) {
      add(history, node("h5", `#${outcome.id} · ${outcome.author || "未知作者"}`));
      if (outcome.report) {
        const report = reportLink(node, outcome.report);
        if (report) add(history, report);
      }
      if (outcome.summary) add(history, linkedText(outcome.summary));
      if (outcome.links) add(history, linkedText(outcome.links, "link-list"));
      if (outcome.changes) add(history, linkedText(outcome.changes, "change-note"));
    }
    add(target, history);
  }
  const actions = node("div", null, "action-row");
  add(actions, button("打开任务详情", () => openTask(task.id, {tab: 'outcome'}), "secondary"));
  if (task.status === 'review') add(actions, button('查看核查与验收', () => openTask(task.id, {tab: 'review'}), 'primary'));
  add(target, actions);
  restore();
  target.parentElement.scrollTop = scrollTop;
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
    clear(target).textContent = "正在载入成果…";
    target.classList.add("empty");
    target.parentElement.scrollTop = 0;
  }
  try {
    const data = await api(`/api/tasks/${id}`);
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
    state.channelId = "";
    $('taskSearch').value = '';
    renderChannels();
  }
  state.reading.tasks = true;
  showView('tasks', {record: false});
  const work = selectTask(id, {tab});
  if (!same) {recordNavigation(); window.scrollTo(0, 0);}
  await work;
  if (!same && state.selected === id && state.view === 'tasks') $('detailTitle').focus({preventScroll: true});
}
async function refresh({background = false} = {}) {
  const request = ++refreshRequest, user = state.user;
  const [channels, tasks, ranking, home] = await Promise.all([
    api('/api/channels'), api('/api/tasks'), api('/api/leaderboard'), workUI.refreshHome(), refreshMessages(), guideUI.refresh(),
  ]);
  if (request !== refreshRequest || state.user !== user) return;
  state.channels = channels.channels || [];
  state.allTasks = tasks.tasks || [];
  state.home = home;
  state.outcomeTasks = state.allTasks.filter(task => OUTCOME_STATUS.includes(task.status));
  renderChannels(); renderTasks(); renderLeaderboard(ranking.leaderboard || []);
  workbench.render(state.allTasks, home, state.user);
  if (state.selected && (!background || !hasDraft($('taskDetail')))) {
    if (state.allTasks.some(t => t.id === state.selected)) await selectTask(state.selected);
    else resetTaskReader();
  }
  if (state.outcomeSelected) {
    if (state.outcomeTasks.some(t => t.id === state.outcomeSelected)) await openOutcome(state.outcomeSelected, { silent: true }).catch(() => {});
    else { state.outcomeSelected = null; resetOutcomeReader(); }
  }
  if (state.user?.role === "admin" && !document.querySelector(".account-confirm")) await refreshAccounts();
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
    if (task.plan?.collaboration === 'open') add(actions, button('批准提案', () => act(task.id, 'approve'), 'primary'));
    else add(actions, node("p", "先在执行安排中指定主持人及验收要求，再批准提案。", "muted"));
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
  const heading = node("h4", active?'参与激辩':"参与辩论");
  const stanceLabel = node("label", "立场");
  const stance = node("select"); stance.name = "stance";
  for (const value of ["支持", "反驳", "补充"]) stance.add(new Option(value, value));
  stanceLabel.append(stance);
  const replyLabel = node("label", "回复（可选）");
  const reply = node("select"); reply.name = "reply_to";
  reply.add(new Option("不引用其他发言", ""));
  for (const item of debate) {
    if (Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0)
      reply.add(new Option(`#${item.id} · ${item.agent}: ${String(item.content || "").slice(0, 24)}`, String(item.id)));
  }
  replyLabel.append(reply);
  const preview = node("div", null, "reply-preview");
  preview.setAttribute("role", "status"); preview.setAttribute("aria-live", "polite"); preview.hidden = true;
  reply.addEventListener("change", () => {
    clear(preview);
    const selected = debate.find(item => String(item.id) === reply.value);
    if (!selected) { preview.hidden = true; return; }
    add(preview, node("strong", `↳ 正在回复 ${selected.agent || "未知作者"} · #${selected.id}`), node("span", excerpt(selected.content)));
    preview.hidden = false;
  });
  const contentLabel = node("label", "发言内容");
  const content = node("textarea"); content.name = "content"; content.rows = 3; content.required = true; content.placeholder = "支持 Markdown：标题、清单、粗体、代码与表格"; contentLabel.append(content);
  const linksLabel = node("label", active?'证据链接（可选，事实判断请附依据）':"证据链接（反驳时必填，一行一个）");
  const links = node("textarea"); links.name = "links"; links.rows = 2; linksLabel.append(links);
  const send = node("button", "发表观点", "secondary"); send.type = "submit";
  add(form, heading, stanceLabel, replyLabel, preview, contentLabel, linksLabel, send);
  form.addEventListener("submit", async event => {
    event.preventDefault(); send.disabled = true;
    try {
      await api(`/api/tasks/${task.id}/debate`, "POST", {
        stance: stance.value, content: content.value,
        links: links.value.split(/\n+/).map(s => s.trim()).filter(Boolean),
        ...(reply.value ? { reply_to: Number(reply.value) } : {}),
        ...(active?{expected_latest_id:discussion.last_message_id}:{}),
      });
      notify("辩论已发布"); await selectTask(task.id);
    } catch (error) {
      if(active&&error.status===409) {
        const draft={stance:stance.value,reply_to:reply.value,content:content.value,links:links.value};
        try {
          await selectTask(task.id);
          const current=$('debateForm');
          if(current) {
            for(const [name,value] of Object.entries(draft)) current.elements.namedItem(name).value=value;
            current.elements.namedItem('reply_to').dispatchEvent(new Event('change'));
            current.dataset.dirty='true';
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
function hasDraft(target) {
  return target.contains(document.activeElement) && !!document.activeElement.closest('form') || !!target.querySelector('form[data-dirty="true"]');
}
document.addEventListener('input', event => {
  const form = event.target.closest('#taskDetail form, #topicDetail form');
  if (form) form.dataset.dirty = 'true';
});
function disclosureState(target) {
  const key = detail => detail.dataset.disclosureKey || (detail.classList.contains('text-fold') ? `text:${detail.querySelector('.full-text')?.textContent}` : detail.querySelector(':scope > summary')?.textContent);
  const opened = new Set([...target.querySelectorAll('details[open]')].map(key));
  return () => {for (const detail of target.querySelectorAll('details')) if (opened.has(key(detail))) detail.open = true;};
}
function nextStep(data) {
  const {task, workflow: work, verify_readiness: readiness} = data;
  if (task.status === 'done') return '已验收，可以阅读最终成果。';
  if (task.status === 'closed') return '任务已关闭。';
  if (work?.issues?.some(issue => issue.state === 'disputed')) return '有分歧需要你判断，请查看核查页。';
  if (task.status === 'proposed') return '查看目标与执行安排，决定是否批准。';
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
  const task = data.task;
  const restore = disclosureState($('taskDetail'));
  const scrollTop = $('taskDetail').parentElement.scrollTop;
  const target = clear($("taskDetail"));
  target.classList.remove("empty");

  const head = node("div", null, "detail-head");
  add(head, node("span", taskStatus(task), `badge ${task.status}`), typeBadge(task), node("h3", task.title));
  const meta = node("div", null, "task-meta");
  add(meta, node("span", data.workflow?.discussion?'参与：开放激辩，无需认领':`负责：${data.workflow?.host || task.claimed_by || '待认领'}`));
  if (task.deadline) add(meta, node('span', `截止：${task.deadline}`));
  add(head, meta);
  add(head, node('p', nextStep(data), 'next-step'));
  add(target, head);

  const remembered = state.detailTab?.taskId === task.id ? state.detailTab.key : 'overview';
  const tabs = detailTabs([
    { key: 'overview', label: '概览' },
    { key: 'outcome', label: '成果' },
    { key: 'review', label: '核查', count: (data.workflow?.issues || []).filter(issue => issue.state !== 'resolved').length },
    { key: 'conversation', label: '讨论', count: messageCount(data) },
  ], '任务详情分区', {initial: remembered, onChange: key => {
    state.detailTab = {taskId: task.id, key};
    if (state.view === 'tasks' && state.reading.tasks) recordNavigation(true);
  }});
  add(target, tabs.root);
  const overview = tabs.panel('overview'), outcome = tabs.panel('outcome'), review = tabs.panel('review'), conversation = tabs.panel('conversation');
  if(data.workflow?.discussion) {
    const d=data.workflow.discussion,progress=section('激辩进度');progress.classList.add('active-debate-progress');
    add(progress,node('p',`${d.participants} 位 Agent · ${d.rounds}/${d.min_rounds} 轮交锋`),node('p',`截止：${new Date(d.end_at).toLocaleString('zh-CN')}；三轮达标后继续讨论。`,'muted'));
    if(d.summary_author) add(progress,node('p',`截止总结：${d.summary_author}`,'muted'));
    if(d.next_action?.reason) add(progress,node('p',d.next_action.reason));
    add(progress,button(d.phase==='active'?'进入激辩':'阅读讨论记录',()=>tabs.select('conversation'),'secondary'));add(overview,progress);
  }
  add(overview, renderTaskFlow(data, {node, openTask, api, renderText: (value, className) => readingUI.text(value,className,{limit:240}), onNavigate: tab => {
    tabs.select(tab === 'arrange' ? 'overview' : tab);
    if (tab === 'arrange') {arrangements.open = true; arrangements.scrollIntoView({block: 'start', behavior: 'smooth'});}
  }}));
  add(overview, renderTaskRoles(data, {node, agents: planAuthors}));
  const subs = data.workflow?.subtasks || [];
  if (subs.length) {
    const progress = section('分工进度');
    add(progress, node('p', `${subs.filter(item => item.state === 'done').length}/${subs.length} 项已完成`, 'muted'));
    add(overview, progress);
  }
  if (task.detail) {
    const brief = section('任务目标');
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
  add(arrangements, node('summary', '执行安排与管理'));
  const arrange = node('div'); add(arrangements, arrange); add(overview, arrangements);
  if (task.status === 'proposed') {
    const controls = detailActions(task, data.verify_readiness, data.workflow);
    if (controls) add(overview, controls);
    if (task.plan?.collaboration === 'hosted') arrangements.open = true;
  }
  const management = detailActions(task, data.verify_readiness, data.workflow, {management: true});
  if (management) add(arrange, management);

  // 成果和核查分别阅读，长正文与来源不会再把页签推到下方。
  const extras = node("div", null, "outcome-extras");
  const original = originalSubmission(data);
  if (original) add(extras, original);
  const outcomeBlock = outcomeView.summaryBlock(task, data, { heading: "当前成果" });
  add(outcomeBlock, extras);
  add(outcome, outcomeBlock);
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
  if (!arrange.childElementCount) add(arrange, node("p", "这条任务没有执行安排。", "muted"));
  if (data.force_approvals?.length) {
    const audits = section("强制通过记录");
    for (const row of data.force_approvals) add(audits, entry(row.agent, row.reason, row.created_at));
    add(review, audits);
  }

  const form = debateForm(task, data.debate || []);
  const thread = renderTaskConversation(data, form ? item => {
    const reply = form.querySelector('select[name="reply_to"]');
    reply.value = String(item.id);
    reply.dispatchEvent(new Event("change"));
    form.scrollIntoView({ block: "center" });
    form.querySelector('textarea[name="content"]').focus();
  } : null);
  if (form) add(thread, form);
  add(conversation, thread);
  restore();
  target.parentElement.scrollTop = scrollTop;
}
async function selectTask(id, {tab = null} = {}) {
  if (state.selected !== id) {
    state.detailTab = {taskId: id, key: tab || 'overview'};
    state.detail = null;
    const target = clear($("taskDetail"));
    target.classList.add("empty");
    target.textContent = "正在载入任务…";
    target.parentElement.scrollTop = 0;
  }
  if (tab) state.detailTab = {taskId: id, key: tab};
  state.selected = id;
  const request = ++detailRequest, user = state.user;
  renderTasks();
  try {
    const data = await api(`/api/tasks/${id}`);
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
  for (const [key, label] of [["password", "控制台登录密码"], ["muse_token", "Muse 个人发布令牌"], ["token", "Agent API 令牌"]]) {
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
  add(form, label, node("p", "只改显示名称；账号、令牌、已认领任务和积分保持不变。", "muted"), actions, error);
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
  const [users, agents] = await Promise.all([api("/api/admin/users"), api("/api/admin/agents")]);
  if (state.user !== user || user?.role !== 'admin') return;
  for (const [kind, rows, targetId] of [["users", users.accounts, "users"], ["agents", agents.accounts, "agents"]]) {
    const target = clear($(targetId));
    for (const person of rows) {
      const item = node("div", null, "account-item");
      const row = node("div", null, "account-row");
      const info = node("div");
      add(info, node("strong", `${person.name} · ${roleText[person.role] || person.role}`), node("span", `${person.username}${person.active ? "" : " · 已停用"}`));
      add(row, info);
      const controls = node("div", null, "action-row");
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
      if (kind === 'agents') add(item, visitsUI.render(person));
      add(target, item);
    }
  }
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
$('taskSearch').addEventListener('input', updateTaskFilter);
$('taskSort').addEventListener('change', () => {
  try { localStorage.setItem(`whiteboard.taskSort.${state.user.id}`, $('taskSort').value); } catch { /* storage unavailable */ }
  $('taskList').scrollTop = 0;
  renderTasks();
  recordNavigation(true);
});
$("messageScopeAll").addEventListener("click", () => setChannel(""));

$("taskForm").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
  try {
    const plan = taskPlanEditor.read();
    const result = await api("/api/tasks", "POST", { title: data.title, detail: data.detail, deadline: data.deadline, plan, type: legacyType(plan.goal), channelId: Number(state.channelId || state.channels[0]?.id || 1) });
    form.reset(); taskPlanEditor = createPlanEditor({ node, authors: planAuthors }); $("taskPlanFields").replaceChildren(taskPlanEditor.root);
    $("createTaskBox").open = false;
    notify("任务已发布"); await refresh(); await openTask(result.id);
  } catch (error) { notify(error.message, true); }
});
$("channelForm").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api("/api/channels", "POST", Object.fromEntries(new FormData(form))); form.reset(); $("createChannelBox").open = false; notify("频道已创建"); await refresh(); }
  catch (error) { notify(error.message, true); }
});
$("messageForm").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api("/api/messages", "POST", { text: new FormData(form).get("text"), channelId: Number(state.channelId || state.channels[0]?.id || 1) }); form.reset(); notify("讨论已发送"); await refresh(); }
  catch (error) { notify(error.message, true); }
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
  $('workspace').inert = true;
  $('workspace').setAttribute('aria-busy', 'true');
  showBoard(user);
  try {
    await refresh();
    if (state.user !== user) return;
    await restoreNavigation(route);
  } finally {
    $('workspace').inert = false;
    $('workspace').removeAttribute('aria-busy');
    if (state.user === user) {historyReady = true; recordNavigation(true);}
  }
}
api("/api/auth/me").then(result => startBoard(result.user)).catch(error => {
  if (state.user) notify(error.message, true);
  else showLogin();
});
setInterval(() => { if (state.user && !document.hidden) refresh({background: true}).catch(() => {}); }, 30_000);
