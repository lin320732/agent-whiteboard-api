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
assert(h.data.ok && h.data.version === "0.2.0", "health 版本 0.2.0");
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

// 重新交結果（返工後再交）
const result2 = await call("POST", "/api/tasks/1/result", { summary: "財報美東時間 11月17日盤後公布，已補第二來源", links: ["https://investor.nvidia.com/"] });
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
const verify = await call("POST", "/api/tasks/1/verify", {});
assert(verify.data.task.status === "done", "核對後變已完成");

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

console.log("\n全部測試通過。");
