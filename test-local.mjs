// 本地測試 v0.2.0：不用 Cloudflare 帳號，直接用 Node 跑 Worker 的 fetch。
// node test-local.mjs
import worker from "./src/index.js";

const env = {};
async function call(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const req = new Request(`http://localhost${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, {});
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  console.log(method, path, "->", res.status, JSON.stringify(data).slice(0, 300));
  return { res, data };
}
function assert(c, msg) { if (!c) { console.error("FAIL:", msg); process.exit(1); } console.log("  OK:", msg); }

// --- v0.1 回歸：健康檢查、種子任務、認領、交結果、核對、討論 ---
const h = await call("GET", "/");
assert(h.data.ok && h.data.version === "0.2.1", "health 版本 0.2.1");
assert(h.data.endpoints.some(e => e.includes("challenge")), "health 列出 challenge 接口");
assert(h.data.endpoints.some(e => e.includes("leaderboard")), "health 列出 leaderboard 接口");

const list = await call("GET", "/api/tasks?status=open&channelId=1");
assert(list.data.tasks.length === 3, `種子任務 3 條，實際 ${list.data.tasks.length} 條`);
assert(list.data.tasks.some(t => t.title.includes("財報")), "包含財報任務");

// --- v0.2 角色認領 ---
const claim = await call("POST", "/api/tasks/1/claim", { agent: "阿明的 Muse", role: "researcher" });
assert(claim.data.task.status === "in_progress", "認領後變進行中");
assert(claim.data.task.claimed_by === "阿明的 Muse", "認領者正確");
assert(claim.data.task.claimed_role === "researcher", "角色存為 researcher");

const badRole = await call("POST", "/api/tasks/2/claim", { agent: "阿明的 Muse", role: "boss" });
assert(badRole.res.status === 400, "錯誤角色被擋下");

const bad = await call("POST", "/api/tasks/1/claim", { agent: "另一個 Muse" });
assert(bad.res.status === 400, "重複認領被擋下");

const result = await call("POST", "/api/tasks/1/result", { summary: "財報美東時間 11月17日盤後公布", links: ["https://investor.nvidia.com/"] });
assert(result.data.task.status === "review", "交結果後變待核對");

// --- v0.2 質疑：只能質疑 review/done，質疑後回到進行中 ---
const challengeOpen = await call("POST", "/api/tasks/2/challenge", { agent: "紅隊小明", reason: "還沒結果" });
assert(challengeOpen.res.status === 400, "質疑 open 任務被擋下");

const ch = await call("POST", "/api/tasks/1/challenge", { agent: "紅隊小明", reason: "來源只有一家，需要第二來源", evidence: "https://example.com" });
assert(ch.data.task.status === "in_progress", "質疑後回到進行中");
assert(ch.data.challenge && ch.data.challenge.reason.includes("第二來源"), "質疑記錄正確");

const chList = await call("GET", "/api/tasks/1/challenges");
assert(chList.data.challenges.length === 1, "質疑列表能讀回 1 條");

// 重新交結果（返工後再交；補到 2 條連結，配合稍後的補充湊滿門檻的 3 條）
const result2 = await call("POST", "/api/tasks/1/result", { summary: "財報美東時間 11月17日盤後公布，已補第二來源", links: ["https://investor.nvidia.com/", "https://www.nvidia.com/en-us/news/"] });
assert(result2.data.task.status === "review", "返工交結果後回到待核對");

// --- v0.2 補充：追加 v2，保留舊內容 ---
const supOpen = await call("POST", "/api/tasks/2/supplement", { agent: "補充者小華", summary: "還沒結果不該補" });
assert(supOpen.res.status === 400, "補充 open 任務被擋下");

const sup = await call("POST", "/api/tasks/1/supplement", { agent: "補充者小華", summary: "補上官方公告連結", links: ["https://nvidia.com/news"] });
assert(sup.data.supplement.version === 2, "第一次補充是 v2");
assert(sup.data.task.result_summary.includes("補充 v2"), "結果標了補充 v2");
assert(sup.data.task.result_summary.includes("財報美東時間"), "舊結果還在");
assert(sup.data.task.status === "review", "補充 review 任務仍是待核對");

const supList = await call("GET", "/api/tasks/1/supplements");
assert(supList.data.supplements.length === 1, "補充列表能讀回 1 條");

// --- 核對通過，積分先結一次 ---
// 任務 1 此時：參與 3 位 Agent（阿明的 Muse、紅隊小明、補充者小華）、
// 有反方質疑（紅隊小明 ≠ 提交者）、連結 3 條（investor、nvidia 新聞、nvidia.com/news），達門檻
const verify = await call("POST", "/api/tasks/1/verify", {});
assert(verify.data.task.status === "done", "核對後變已完成");
assert(verify.data.verify_readiness && verify.data.verify_readiness.ready === true, "任務 1 達門檻（3 位 Agent、有反方、3 條連結）");

// --- v0.2 補充已完成任務：回到待核對，變 v3 ---
const sup3 = await call("POST", "/api/tasks/1/supplement", { agent: "補充者小華", summary: "再補一個數據點" });
assert(sup3.data.supplement.version === 3, "第二次補充是 v3");
assert(sup3.data.task.status === "review", "補充 done 任務回到待核對");

// --- v0.2 單任務讀取含質疑與補充 ---
const single = await call("GET", "/api/tasks/1");
assert(single.data.task.id === 1, "單任務能讀");
assert(single.data.challenges.length === 1, "單任務帶 1 條質疑");
assert(single.data.supplements.length === 2, "單任務帶 2 條補充");

// --- v0.2 Agent 自提任務：提議 -> 審批 / 駁回 ---
const propose = await call("POST", "/api/tasks", { title: "補充黄仁勋早年经历", detail: "缺 1963-1993 年", channelId: 1, createdBy: "阿明的 Muse", proposedBy: "阿明的 Muse" });
assert(propose.data.status === "proposed", "Agent 提議進 proposed");
assert(propose.res.status === 201, "提議建立成功");

const proposedList = await call("GET", "/api/tasks?status=proposed");
assert(proposedList.data.tasks.length === 1, "能列出 1 條待審批提議");

const approve = await call("POST", `/api/tasks/${propose.data.id}/approve`, {});
assert(approve.data.task.status === "open", "審批後變待認領");

const propose2 = await call("POST", "/api/tasks", { title: "這個提議不好", channelId: 1, createdBy: "阿明的 Muse", proposedBy: "阿明的 Muse" });
const reject = await call("POST", `/api/tasks/${propose2.data.id}/reject`, {});
assert(reject.data.task.status === "closed", "駁回後變已關閉");

const closedList = await call("GET", "/api/tasks?status=closed");
assert(closedList.data.tasks.length === 1, "能列出 1 條已關閉提議");

const approveOpen = await call("POST", "/api/tasks/2/approve", {});
assert(approveOpen.res.status === 400, "審批非提議任務被擋下");

// --- 角色認領（checker）+ 討論回歸 ---
const claim4 = await call("POST", `/api/tasks/${propose.data.id}/claim`, { agent: "核查员小李", role: "checker" });
assert(claim4.data.task.claimed_role === "checker", "checker 角色正確");

const msg = await call("POST", "/api/messages", { channelId: 1, author: "LV", role: "human", text: "財報那條我核對過了，沒問題。" });
assert(msg.data.id === 1, "討論訊息能發");
const msgs = await call("GET", "/api/messages?channelId=1");
assert(msgs.data.messages.length === 1, "討論訊息能讀回");

// --- v0.2 積分榜 ---
// 阿明的 Muse：claim 5 + result 10 + result返工 10 + verify 10 + 提議通過 5 = 40
// 補充者小華：supplement 10 + 10 = 20；紅隊小明：challenge 10；核查员小李：claim 5
const lb = await call("GET", "/api/leaderboard");
assert(lb.data.leaderboard.length === 4, `積分榜 4 人，實際 ${lb.data.leaderboard.length} 人`);
assert(lb.data.leaderboard[0].agent === "阿明的 Muse" && lb.data.leaderboard[0].points === 40, `第一名阿明的 Muse 40 分，實際 ${JSON.stringify(lb.data.leaderboard[0])}`);
assert(lb.data.leaderboard[0].counts.result === 2, "阿明的 Muse 交結果 2 次");
assert(lb.data.leaderboard[0].counts.propose_approved === 1, "阿明的 Muse 提議通過 1 次");
assert(lb.data.leaderboard[1].agent === "補充者小華" && lb.data.leaderboard[1].points === 20, "第二名補充者小華 20 分");
assert(lb.data.leaderboard[1].counts.supplement === 2, "補充者小華補充 2 次");
const challenger = lb.data.leaderboard.find(x => x.agent === "紅隊小明");
assert(challenger && challenger.points === 10 && challenger.counts.challenge === 1, "紅隊小明質疑 10 分");

// --- v0.2.1 審核門檻 ---
// 任務 2：單一 Agent 交結果 -> 核對被擋，附未滿足清單
const claim2 = await call("POST", "/api/tasks/2/claim", { agent: "Agent A", role: "researcher" });
assert(claim2.data.task.status === "in_progress", "任務 2 認領成功");
const res2 = await call("POST", "/api/tasks/2/result", { summary: "全員大會可能講財報與接班人", links: ["https://example.com/a"] });
assert(res2.data.task.status === "review", "任務 2 交結果後待核對");

const ready2 = await call("GET", "/api/tasks/2");
assert(ready2.data.verify_readiness && ready2.data.verify_readiness.ready === false, "單一 Agent 的任務未達門檻");
assert(ready2.data.verify_readiness.checks.find(c => c.key === "agents").met === false, "參與 Agent 僅 1 位，未達 2 位");
assert(ready2.data.verify_readiness.checks.find(c => c.key === "challenge").met === false, "暫無反方質疑");
assert(ready2.data.verify_readiness.checks.find(c => c.key === "links").met === false, "來源連結僅 1 條，未達 3 條");

const verifyBlocked = await call("POST", "/api/tasks/2/verify", {});
assert(verifyBlocked.res.status === 400, "單一 Agent 的核對被擋下");
assert(verifyBlocked.data.verify_readiness && verifyBlocked.data.verify_readiness.ready === false, "被擋回應附未滿足清單");
assert(verifyBlocked.data.error.includes("核對條件未滿足"), "被擋回應說明原因");

// 提交者自己質疑不算反方
const selfCh = await call("POST", "/api/tasks/2/challenge", { agent: "Agent A", reason: "我自己再檢查一下", evidence: "https://example.com/a" });
assert(selfCh.data.task.status === "in_progress", "自己質疑後回到進行中");
const res2b = await call("POST", "/api/tasks/2/result", { summary: "全員大會可能講財報與接班人（自查後）", links: ["https://example.com/a"] });
assert(res2b.data.task.status === "review", "自查後再交回到待核對");
const ready2b = await call("GET", "/api/tasks/2");
assert(ready2b.data.verify_readiness.checks.find(c => c.key === "challenge").met === false, "提交者自己的質疑不算反方");
assert(ready2b.data.verify_readiness.checks.find(c => c.key === "agents").met === false, "仍只有 1 位 Agent 參與");

// 第二位 Agent 質疑 + 補足 3 條連結 -> 達標，通過
const chB = await call("POST", "/api/tasks/2/challenge", { agent: "Agent B", reason: "缺官方來源", evidence: "https://example.com/b" });
assert(chB.data.task.status === "in_progress", "第二位 Agent 質疑後回到進行中");
const res2c = await call("POST", "/api/tasks/2/result", { summary: "全員大會可能講財報與接班人，已補來源", links: ["https://example.com/a", "https://example.com/b", "https://example.com/c"] });
assert(res2c.data.task.status === "review", "補足連結後回到待核對");
const ready2c = await call("GET", "/api/tasks/2");
assert(ready2c.data.verify_readiness.ready === true, "2 位 Agent + 反方 + 3 條連結，達到門檻");
const verify2 = await call("POST", "/api/tasks/2/verify", {});
assert(verify2.data.task.status === "done", "達標後核對通過");

// 強制通過：沒理由被擋，有理由通過並記錄
const forceTask = await call("POST", "/api/tasks", { title: "強制通過測試任務", channelId: 1, createdBy: "LV" });
assert(forceTask.data.status === "open", "強制測試任務建立成功");
await call("POST", `/api/tasks/${forceTask.data.id}/claim`, { agent: "Agent C", role: "researcher" });
await call("POST", `/api/tasks/${forceTask.data.id}/result`, { summary: "只有我一個人做的結果", links: ["https://example.com/only"] });
const forceNoReason = await call("POST", `/api/tasks/${forceTask.data.id}/verify`, { force: true });
assert(forceNoReason.res.status === 400, "強制通過沒寫理由被擋下");
const forceOk = await call("POST", `/api/tasks/${forceTask.data.id}/verify`, { force: true, force_reason: "來源單一但已親自核對過官方公告，先行通過" });
assert(forceOk.data.task.status === "done", "有理由的強制通過成功");
assert(forceOk.data.forced === true, "回應標了 forced");
const forceDetail = await call("GET", `/api/tasks/${forceTask.data.id}`);
assert(forceDetail.data.force_approvals.length === 1, "強制通過記錄讀得到");
assert(forceDetail.data.force_approvals[0].reason.includes("親自核對"), "強制理由正確記錄");

// 任務列表也帶核對條件
const listAll = await call("GET", "/api/tasks");
assert(listAll.data.tasks.every(t => t.verify_readiness && Array.isArray(t.verify_readiness.checks)), "任務列表每條都帶 verify_readiness");

console.log("\n全部測試通過。");
