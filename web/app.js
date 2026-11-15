const $ = id => document.getElementById(id);
const state = { user: null, channels: [], tasks: [], selected: null, detail: null };
const statusText = { open: "待认领", in_progress: "进行中", review: "待核对", proposed: "待审批", done: "已完成", closed: "已关闭" };
const typeText = { research: "调研", creative: "创意", debate: "辩论", data: "数据" };
const taskType = task => Object.hasOwn(typeText, task.type) ? task.type : "research";
const typeBadge = task => node("span", typeText[taskType(task)], `badge task-type ${taskType(task)}`);
const roleText = { admin: "管理员", publisher: "发布者", viewer: "只读成员", agent: "Agent" };

function node(tag, value = "", className = "") {
  const element = document.createElement(tag);
  if (value != null) element.textContent = String(value);
  if (className) element.className = className;
  return element;
}
function add(parent, ...children) { parent.append(...children); return parent; }

const previewCache = new Map();
function linkTo(url, label = url, className = "plain-link") {
  const link = node("a", label, className);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
function previewLink(url, slot) {
  if (!previewCache.has(url)) previewCache.set(url, api(`/api/link-preview?url=${encodeURIComponent(url)}`).catch(() => null));
  previewCache.get(url).then(data => {
    if (!slot.isConnected || !data?.ok) return;
    const card = linkTo(url, null, "link-card");
    add(card, node("span", data.domain || new URL(url).hostname, "link-domain"), node("strong", data.title || url));
    if (data.description) add(card, node("span", data.description, "link-description"));
    slot.replaceWith(card);
  });
}
function linkedText(value, className = "") {
  const text = String(value || "");
  const target = node("p", null, className);
  const previews = node("span", null, "preview-list");
  const seen = new Set();
  const pattern = /https?:\/\/[^\s<>"'`]+/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    target.append(document.createTextNode(text.slice(offset, match.index)));
    const url = match[0].replace(/[.,;:!?)\]}，。；！？）】]+$/u, "");
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw Error("invalid protocol");
      target.append(linkTo(url));
      if (!seen.has(url)) {
        seen.add(url);
        const slot = node("span", null, "preview-slot");
        previews.append(slot);
        previewLink(url, slot);
      }
    } catch { target.append(document.createTextNode(url)); }
    target.append(document.createTextNode(match[0].slice(url.length)));
    offset = match.index + match[0].length;
  }
  target.append(document.createTextNode(text.slice(offset)));
  if (seen.size) target.append(previews);
  return target;
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
async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.includes("/auth/login")) showLogin();
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return data;
}
function showLogin() {
  state.user = null;
  visible("workspace", false);
  visible("identity", false);
  visible("loginView", true);
  const issued = clear($("issuedSecrets"));
  issued.hidden = true;
  delete issued.dataset.accountId;
}
function showBoard(user) {
  state.user = user;
  $("signedInAs").textContent = `${user.name} · ${roleText[user.role] || user.role}`;
  visible("loginView", false);
  visible("identity", true);
  visible("workspace", true);
  visible("adminPanel", user.role === "admin");
  visible("createChannelBox", user.role === "admin");
  visible("createTaskBox", user.role === "admin" || user.role === "publisher");
  visible("messageForm", user.role === "admin" || user.role === "publisher");
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
  for (const { kind, item, time } of rows) {
    const message = node("article", null, `conversation-message ${kind}${item.role === "human" ? " human" : ""}`);
    message.dataset.kind = kind;
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
      const quote = node(cited ? "a" : "div", null, "reply-reference");
      if (cited) {
        quote.href = `#debate-${replyId}`;
        add(quote, node("span", `↳ 回复 ${cited.agent || "未知作者"} · #${replyId}`, "reply-target"), node("small", Array.from(String(cited.content || "").trim()).slice(0, 100).join(""), "reply-excerpt"));
      } else add(quote, node("span", `↳ 回复 #${item.reply_to} · 原发言不可见`, "reply-target"));
      add(bubble, quote);
    }
    const content = kind === "debate" ? item.content : kind === "challenge" ? item.reason : item.summary;
    add(bubble, linkedText(content));
    const links = kind === "debate" ? item.links : kind === "challenge" ? item.evidence : item.links;
    if (links) add(bubble, linkedText(links, "link-list"));
    if (kind === "debate" && onReply && message.dataset.debateId) add(bubble, button("回复", () => onReply(item), "text-button"));
    add(message, avatar, header, bubble);
    add(thread, message);
  }
  if (!rows.length) add(thread, node("p", "暂无讨论，欢迎分享观点。", "muted conversation-empty"));
  add(box, thread);
  return box;
}
function renderChannels() {
  const select = $("channelFilter");
  const value = select.value;
  select.replaceChildren(new Option("全部频道", ""));
  const list = clear($("channelList"));
  for (const channel of state.channels) {
    select.add(new Option(channel.name, String(channel.id)));
    add(list, node("p", `${channel.name}${channel.topic ? ` · ${channel.topic}` : ""}`));
  }
  select.value = value;
  if (!state.channels.length) add(list, node("p", "暂无频道"));
}
function renderTasks() {
  const list = clear($("taskList"));
  $("taskCount").textContent = `${state.tasks.length} 条`;
  for (const task of state.tasks) {
    const item = node("button", null, "task-item" + (state.selected === task.id ? " active" : ""));
    item.type = "button";
    add(item, node("strong", task.title));
    const row = node("div", null, "task-line");
    add(row, node("span", statusText[task.status] || task.status, `badge ${task.status}`), typeBadge(task), node("small", task.claimed_by || task.created_by || ""));
    add(item, row);
    item.addEventListener("click", () => selectTask(task.id));
    add(list, item);
  }
  if (!state.tasks.length) add(list, node("p", "没有符合筛选的任务。", "muted"));
}
function renderMessages(messages) {
  const target = clear($("messages"));
  for (const message of messages) add(target, entry(`${message.author} · ${message.role === "human" ? "成员" : "Agent"}`, message.text, message.created_at));
  if (!messages.length) add(target, node("p", "还没有讨论，欢迎发出第一条消息。", "muted"));
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
async function refresh() {
  const filter = new URLSearchParams();
  if ($("statusFilter").value) filter.set("status", $("statusFilter").value);
  if ($("channelFilter").value) filter.set("channelId", $("channelFilter").value);
  const channelId = $("channelFilter").value;
  const [channels, tasks, messages, ranking] = await Promise.all([
    api("/api/channels"), api(`/api/tasks?${filter}`),
    api(`/api/messages${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ""}`), api("/api/leaderboard"),
  ]);
  state.channels = channels.channels;
  state.tasks = tasks.tasks;
  renderChannels(); renderTasks(); renderMessages(messages.messages); renderLeaderboard(ranking.leaderboard);
  if (state.selected) {
    if (state.tasks.some(t => t.id === state.selected)) await selectTask(state.selected);
    else { state.selected = null; clear($("taskDetail")).textContent = "选择一条任务查看详情与操作。"; }
  }
  if (state.user?.role === "admin" && !document.querySelector(".account-confirm")) await refreshAccounts();
}
async function act(id, action, body = {}) {
  await api(`/api/tasks/${id}/${action}`, "POST", body);
  notify("操作已保存");
  await refresh();
}
function detailActions(task, readiness) {
  const isAdmin = state.user?.role === "admin";
  if (!isAdmin) return null;
  const actions = node("div", null, "action-row");
  if (task.status === "proposed") {
    add(actions, button("批准提议", () => act(task.id, "approve"), "primary"), button("驳回提议", async () => {
      if (confirm("确定驳回这条提议？")) await act(task.id, "reject");
    }, "danger"));
  }
  if (task.status === "review") {
    if (readiness?.ready) add(actions, button("核对通过", () => act(task.id, "verify"), "primary"));
    else add(actions, button("填写理由并强制通过", async () => {
      const reason = prompt("请输入强制通过的理由（会记录在任务中）");
      if (reason?.trim()) await act(task.id, "verify", { force: true, force_reason: reason.trim() });
    }, "secondary"));
  }
  if (task.status !== "open") add(actions, button("退回待认领", async () => {
    if (confirm("确定将任务退回待认领？")) await act(task.id, "reopen");
  }));
  return actions.childElementCount ? actions : null;
}
function debateForm(task, debate) {
  if (!state.user || !["admin", "publisher"].includes(state.user.role) || task.status === "closed") return null;
  const form = node("form", null, "inline-form");
  form.id = "debateForm";
  const heading = node("h4", "参与辩论");
  const stanceLabel = node("label", "立场");
  const stance = node("select"); stance.name = "stance";
  for (const value of ["支持", "反驳", "补充"]) stance.add(new Option(value, value));
  stanceLabel.append(stance);
  const replyLabel = node("label", "回复（可选）");
  const reply = node("select"); reply.name = "reply_to";
  reply.add(new Option("不引用其他发言", ""));
  for (const item of debate) reply.add(new Option(`#${item.id} · ${item.agent}: ${item.content.slice(0, 24)}`, String(item.id)));
  replyLabel.append(reply);
  const contentLabel = node("label", "发言内容");
  const content = node("textarea"); content.name = "content"; content.rows = 3; content.required = true; contentLabel.append(content);
  const linksLabel = node("label", "证据链接（反驳时必填，一行一个）");
  const links = node("textarea"); links.name = "links"; links.rows = 2; linksLabel.append(links);
  const send = node("button", "发表观点", "secondary"); send.type = "submit";
  add(form, heading, stanceLabel, replyLabel, contentLabel, linksLabel, send);
  form.addEventListener("submit", async event => {
    event.preventDefault(); send.disabled = true;
    try {
      await api(`/api/tasks/${task.id}/debate`, "POST", {
        stance: stance.value, content: content.value,
        links: links.value.split(/\n+/).map(s => s.trim()).filter(Boolean),
        ...(reply.value ? { reply_to: Number(reply.value) } : {}),
      });
      notify("辩论已发布"); await selectTask(task.id);
    } catch (error) { notify(error.message, true); }
    finally { send.disabled = false; }
  });
  return form;
}
async function selectTask(id) {
  state.selected = id;
  const data = await api(`/api/tasks/${id}`);
  state.detail = data;
  renderTasks();
  const task = data.task;
  const target = clear($("taskDetail")); target.classList.remove("empty");
  add(target, node("span", statusText[task.status] || task.status, `badge ${task.status}`), typeBadge(task), node("h3", task.title));
  if (task.detail) add(target, linkedText(task.detail));
  const meta = node("div", null, "task-meta");
  add(meta, node("span", `发布：${task.created_by || "—"}`), node("span", `认领：${task.claimed_by || "—"}`), node("span", `截止：${task.deadline || "—"}`));
  add(target, meta);
  if (task.result_summary || task.result_links) {
    const result = section("结果与来源");
    if (task.result_summary) add(result, linkedText(task.result_summary));
    if (task.result_links) add(result, linkedText(task.result_links, "link-list"));
    add(target, result);
  }
  const readiness = section("核对条件");
  for (const check of data.verify_readiness?.checks || []) {
    const item = node("div", null, `check ${check.na ? "na" : check.met ? "met" : ""}`);
    add(item, node("span", check.na ? "—" : check.met ? "✓" : "!", "indicator"), node("span", `${check.na ? "不适用 · " : ""}${check.label} · ${check.detail}`));
    add(readiness, item);
  }
  add(target, readiness);
  const controls = detailActions(task, data.verify_readiness);
  if (controls) add(target, controls);
  const conversation = renderTaskConversation(data);
  const form = debateForm(task, data.debate || []);
  if (form) add(conversation, form);
  add(target, conversation);
  if (data.force_approvals?.length) {
    const audits = section("强制通过记录");
    for (const row of data.force_approvals) add(audits, entry(row.agent, row.reason, row.created_at));
    add(target, audits);
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
  const [users, agents] = await Promise.all([api("/api/admin/users"), api("/api/admin/agents")]);
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
      add(target, item);
    }
  }
}

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault(); $("loginError").textContent = "";
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try { const result = await api("/api/auth/login", "POST", data); form.reset(); showBoard(result.user); await refresh(); }
  catch (error) { $("loginError").textContent = error.message; }
});
$("logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", "POST", {}); } catch { /* expired session */ }
  showLogin();
});
$("refresh").addEventListener("click", () => refresh().catch(error => notify(error.message, true)));
$("statusFilter").addEventListener("change", () => { state.selected = null; refresh().catch(error => notify(error.message, true)); });
$("channelFilter").addEventListener("change", () => { state.selected = null; refresh().catch(error => notify(error.message, true)); });
$("taskForm").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
  try {
    const result = await api("/api/tasks", "POST", { title: data.title, detail: data.detail, deadline: data.deadline, type: data.type, channelId: Number($("channelFilter").value || state.channels[0]?.id || 1) });
    form.reset(); notify("任务已发布"); await refresh(); await selectTask(result.id);
  } catch (error) { notify(error.message, true); }
});
$("channelForm").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api("/api/channels", "POST", Object.fromEntries(new FormData(form))); form.reset(); notify("频道已创建"); await refresh(); }
  catch (error) { notify(error.message, true); }
});
$("messageForm").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api("/api/messages", "POST", { text: new FormData(form).get("text"), channelId: Number($("channelFilter").value || state.channels[0]?.id || 1) }); form.reset(); notify("讨论已发送"); await refresh(); }
  catch (error) { notify(error.message, true); }
});
for (const [formId, resource] of [["userForm", "users"], ["agentForm", "agents"]]) {
  $(formId).addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget;
    try { const result = await api(`/api/admin/${resource}`, "POST", Object.fromEntries(new FormData(form))); showSecrets(result); form.reset(); notify("账号已创建，请私下交付凭据"); await refreshAccounts(); }
    catch (error) { notify(error.message, true); }
  });
}
api("/api/auth/me").then(result => { showBoard(result.user); return refresh(); }).catch(() => showLogin());
setInterval(() => { if (state.user && !document.hidden) refresh().catch(() => {}); }, 30_000);
