// 本地測試 v0.2.4：不用 Cloudflare 帳號，直接用 Node 跑 Worker 的 fetch。
// node test-local.mjs
import worker, { parseLinkPreview, previewUrlAllowed } from "./src/index.js";
import http from "node:http";

const env = { TEST_MEMORY: "1" };
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
assert(h.data.ok && h.data.version === "0.2.4", "health 版本 0.2.4");
assert(h.data.endpoints.some(e => e.includes("link-preview")), "health 列出 link-preview 接口");
assert(h.data.endpoints.some(e => e.includes("challenge")), "health 列出 challenge 接口");
assert(h.data.endpoints.some(e => e.includes("debate")), "health 列出 debate 接口");
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

// --- v0.2.2 辯論 ---
// 新任務：Agent D 交結果（1 條連結），再用辯論湊門檻
const debateTask = await call("POST", "/api/tasks", { title: "辯論測試任務", channelId: 1, createdBy: "LV" });
assert(debateTask.data.status === "open", "辯論測試任務建立成功");
const dtid = debateTask.data.id;
await call("POST", `/api/tasks/${dtid}/claim`, { agent: "Agent D", role: "researcher" });
await call("POST", `/api/tasks/${dtid}/result`, { summary: "初步結論：A 說法成立", links: ["https://example.com/d1"] });

const debateEmpty = await call("GET", `/api/tasks/${dtid}/debate`);
assert(Array.isArray(debateEmpty.data.debate) && debateEmpty.data.debate.length === 0, "辯論一開始是空的");

const support = await call("POST", `/api/tasks/${dtid}/debate`, { agent: "Agent D", stance: "支持", content: "我同意這個結論，補一個理由" });
assert(support.res.status === 201, "支持發言成功，不用連結");
assert(support.data.message.stance === "支持", "立場存為 支持");

const rebutNoLink = await call("POST", `/api/tasks/${dtid}/debate`, { agent: "Agent D", stance: "反駁", content: "我不同意" });
assert(rebutNoLink.res.status === 400, "反駁沒附證據連結被擋下");
const rebutEmptyLinks = await call("POST", `/api/tasks/${dtid}/debate`, { agent: "Agent D", stance: "反駁", content: "我不同意", links: [] });
assert(rebutEmptyLinks.res.status === 400, "反駁連結為空被擋下");
const rebutNoContent = await call("POST", `/api/tasks/${dtid}/debate`, { agent: "Agent E", stance: "反駁", content: "  ", links: ["https://example.com/e1"] });
assert(rebutNoContent.res.status === 400, "反駁沒寫理由被擋下");
const badStance = await call("POST", `/api/tasks/${dtid}/debate`, { agent: "Agent E", stance: "中立", content: "我中立" });
assert(badStance.res.status === 400, "錯誤立場被擋下");
const debateMissing = await call("POST", "/api/tasks/999/debate", { agent: "Agent E", stance: "支持", content: "沒有這個任務" });
assert(debateMissing.res.status === 404, "辯論不存在的任務被擋下");

// 提交者自己的反駁不算反方
const selfRebut = await call("POST", `/api/tasks/${dtid}/debate`, { agent: "Agent D", stance: "反駁", content: "我自己再想想，這裡可能有問題", links: ["https://example.com/d2"] });
assert(selfRebut.res.status === 201, "提交者自己的反駁可以發（只是不算反方）");
const readySelfRebut = await call("GET", `/api/tasks/${dtid}`);
assert(readySelfRebut.data.verify_readiness.checks.find(c => c.key === "challenge").met === false, "提交者自己的辯論反駁不算反方");
assert(readySelfRebut.data.debate.length === 2, "單任務帶 2 條辯論");

// 第二位 Agent 反駁 + 回覆引用
const rebutE = await call("POST", `/api/tasks/${dtid}/debate`, { agent: "Agent E", stance: "反駁", content: "A 說法站不住腳，數據有另一種解讀", links: ["https://example.com/e1"] });
assert(rebutE.res.status === 201, "第二位 Agent 的反駁成功");
const addF = await call("POST", `/api/tasks/${dtid}/debate`, { agent: "Agent F", stance: "補充", content: "補一個第三方數據，兩邊說法各對一半", links: ["https://example.com/f1"], reply_to: rebutE.data.message.id });
assert(addF.res.status === 201, "補充發言成功");
assert(addF.data.message.reply_to === rebutE.data.message.id, "回覆引用了反駁訊息");
const badReply = await call("POST", `/api/tasks/${dtid}/debate`, { agent: "Agent F", stance: "補充", content: "回覆不存在的訊息", reply_to: 9999 });
assert(badReply.res.status === 400, "回覆不存在的訊息被擋下");

const debateList = await call("GET", `/api/tasks/${dtid}/debate`);
assert(debateList.data.debate.length === 4, "辯論列表讀回 4 條");
assert(debateList.data.debate[0].stance === "支持" && debateList.data.debate[3].stance === "補充", "辯論按時間順序排列");
assert(debateList.data.debate[3].reply_to === rebutE.data.message.id, "列表裡回覆引用正確");

// 辯論反駁計入門檻反方：此時 3 位 Agent、有反方、連結仍只有 1 條 -> 未達標
const readyDebate = await call("GET", `/api/tasks/${dtid}`);
assert(readyDebate.data.verify_readiness.checks.find(c => c.key === "challenge").met === true, "辯論反駁計入門檻反方");
assert(readyDebate.data.verify_readiness.checks.find(c => c.key === "agents").met === true, "辯論發言者計入參與 Agent（3 位）");
assert(readyDebate.data.verify_readiness.ready === false, "連結只有 1 條，仍未達標");
assert(readyDebate.data.debate.length === 4, "單任務回傳 debate 陣列");

// 補充（版本層）補足 3 條連結 -> 達標；辯論本身不產生版本
const supDebate = await call("POST", `/api/tasks/${dtid}/supplement`, { agent: "Agent F", summary: "補兩個來源", links: ["https://example.com/f2", "https://example.com/f3"] });
assert(supDebate.data.supplement.version === 2, "辯論測試任務的補充是 v2（辯論沒佔版本號）");
const readyDebate2 = await call("GET", `/api/tasks/${dtid}`);
assert(readyDebate2.data.verify_readiness.ready === true, "辯論反駁 + 補充湊滿 3 條連結，達到門檻");
const verifyDebate = await call("POST", `/api/tasks/${dtid}/verify`, {});
assert(verifyDebate.data.task.status === "done", "辯論湊滿門檻後核對通過");
const supListDebate = await call("GET", `/api/tasks/${dtid}/supplements`);
assert(supListDebate.data.supplements.length === 1, "辯論沒有產生補充版本（仍只有 1 個補充）");
assert(!readyDebate2.data.task.result_summary.includes("兩邊說法各對一半"), "辯論內容沒有混進結果正文");

// --- v0.2.3 任務類型 ---
// 預設 research；非法 type 被擋下
const defType = await call("POST", "/api/tasks", { title: "預設類型任務", channelId: 1, createdBy: "LV" });
assert(defType.data.status === "open", "預設類型任務建立成功");
const defTask = await call("GET", `/api/tasks/${defType.data.id}`);
assert(defTask.data.task.type === "research", "沒填 type 預設 research");
const badType = await call("POST", "/api/tasks", { title: "非法類型任務", channelId: 1, createdBy: "LV", type: "essay" });
assert(badType.res.status === 400, "非法 type 被擋下");

// research：單一 Agent + 0 連結未達標（與 v0.2.1 任務 2 同規則）
const resTask = await call("POST", "/api/tasks", { title: "調研類型任務", channelId: 1, createdBy: "LV", type: "research" });
const rid = resTask.data.id;
assert((await call("GET", `/api/tasks/${rid}`)).data.task.type === "research", "調研任務 type 正確");
await call("POST", `/api/tasks/${rid}/claim`, { agent: "Agent R", role: "researcher" });
await call("POST", `/api/tasks/${rid}/result`, { summary: "調研結論", links: [] });
const readyR = await call("GET", `/api/tasks/${rid}`);
assert(readyR.data.verify_readiness.ready === false, "調研類單一 Agent 未達標");

// creative：1 位 Agent、0 連結、0 質疑，交結果即達標（任務 5 的情形）
const creTask = await call("POST", "/api/tasks", { title: "寫秋天的詩句", detail: "盡可能多提供描寫秋天的詩句", channelId: 1, createdBy: "LV", type: "creative" });
const cid = creTask.data.id;
const creOpen = await call("GET", `/api/tasks/${cid}`);
assert(creOpen.data.verify_readiness.ready === false, "創意類沒交結果前未達標");
assert(creOpen.data.verify_readiness.checks.find(c => c.key === "result").met === false, "創意類結果檢查未滿足");
await call("POST", `/api/tasks/${cid}/claim`, { agent: "Agent P", role: "researcher" });
await call("POST", `/api/tasks/${cid}/result`, { summary: "杜牧《山行》：停車坐愛楓林晚，霜葉紅於二月花。", links: [] });
const readyC = await call("GET", `/api/tasks/${cid}`);
assert(readyC.data.verify_readiness.ready === true, "創意類 1 位 Agent、0 連結，交結果即達標");
assert(readyC.data.verify_readiness.checks.find(c => c.key === "links").na === true, "創意類連結顯示不適用");
assert(readyC.data.verify_readiness.checks.find(c => c.key === "challenge").na === true, "創意類質疑顯示不要求");
const verifyC = await call("POST", `/api/tasks/${cid}/verify`, {});
assert(verifyC.data.task.status === "done", "創意類核對通過");

// debate：只有支持不夠，正反雙方都發言才達標
const debTask = await call("POST", "/api/tasks", { title: "辯論類型任務", detail: "AI 是否會取代程式員", channelId: 1, createdBy: "LV", type: "debate" });
const did = debTask.data.id;
await call("POST", `/api/tasks/${did}/claim`, { agent: "Agent G", role: "researcher" });
await call("POST", `/api/tasks/${did}/result`, { summary: "初步結論：短期不會", links: [] });
await call("POST", `/api/tasks/${did}/debate`, { agent: "Agent G", stance: "支持", content: "我同意，創意工作難替代" });
const readyD1 = await call("GET", `/api/tasks/${did}`);
assert(readyD1.data.verify_readiness.ready === false, "辯論類只有支持未達標");
assert(readyD1.data.verify_readiness.checks.find(c => c.key === "stances").met === false, "正反雙方檢查未滿足");
assert(readyD1.data.verify_readiness.checks.find(c => c.key === "links").na === true, "辯論類連結顯示不適用");
await call("POST", `/api/tasks/${did}/debate`, { agent: "Agent H", stance: "反駁", content: "重複性編碼正在被替代", links: ["https://example.com/h1"] });
const readyD2 = await call("GET", `/api/tasks/${did}`);
assert(readyD2.data.verify_readiness.ready === true, "辯論類正反雙方到場即達標");
const verifyD = await call("POST", `/api/tasks/${did}/verify`, {});
assert(verifyD.data.task.status === "done", "辯論類核對通過");

// data：與 research 同規則，單一 Agent 擋下，補齊後通過
const dataTask = await call("POST", "/api/tasks", { title: "數據類型任務", channelId: 1, createdBy: "LV", type: "data" });
const daid = dataTask.data.id;
await call("POST", `/api/tasks/${daid}/claim`, { agent: "Agent S", role: "researcher" });
await call("POST", `/api/tasks/${daid}/result`, { summary: "數據已整理", links: ["https://example.com/s1"] });
const readyS = await call("GET", `/api/tasks/${daid}`);
assert(readyS.data.verify_readiness.ready === false, "數據類單一 Agent 未達標");
await call("POST", `/api/tasks/${daid}/challenge`, { agent: "Agent T", reason: "缺第二來源", evidence: "https://example.com/t1" });
await call("POST", `/api/tasks/${daid}/result`, { summary: "數據已整理（補來源）", links: ["https://example.com/s1", "https://example.com/s2", "https://example.com/s3"] });
const readyS2 = await call("GET", `/api/tasks/${daid}`);
assert(readyS2.data.verify_readiness.ready === true, "數據類補齊 2 位 Agent + 反方 + 3 連結達標");
const verifyS = await call("POST", `/api/tasks/${daid}/verify`, {});
assert(verifyS.data.task.status === "done", "數據類核對通過");

// --- v0.2.4 連結卡片 ---
// 解析：og 標籤優先於一般標籤，實體解碼，只回純文字
const sampleHtml = `<!doctype html><html><head><title>備用標題</title>
<meta property="og:title" content="黃仁勳辭職原因分析 &amp; 後續">
<meta property="og:description" content="董事會連夜開會後接受辭職的完整分析。">
<meta name="description" content="備用描述"></head><body>hi</body></html>`;
const parsed = parseLinkPreview(sampleHtml, "https://example.com/report/huang");
assert(parsed.title === "黃仁勳辭職原因分析 & 後續", "og:title 優先且實體解碼");
assert(parsed.description === "董事會連夜開會後接受辭職的完整分析。", "og:description 優先");
assert(parsed.domain === "example.com", "域名正確");
const parsed2 = parseLinkPreview(`<html><head><title>  純標題 &lt;測試&gt; </title><meta name="description" content="只有描述"></head></html>`, "https://news.example.org/a?x=1");
assert(parsed2.title === "純標題 <測試>", "無 og 時用 <title>，空白收合");
assert(parsed2.description === "只有描述", "無 og:description 時用 meta description");
assert(parseLinkPreview("<html><head></head><body>無標題</body></html>", "https://example.com/").title === "", "無標題時 title 為空字串");

// 網址守門：只放行公開 http/https，擋內網與中繼資料主機
assert(previewUrlAllowed("ftp://example.com/x").ok === false, "ftp 被擋下");
assert(previewUrlAllowed("not a url").ok === false, "無效網址被擋下");
assert(previewUrlAllowed("http://10.1.2.3/x").ok === false, "10.x 私網被擋下");
assert(previewUrlAllowed("http://192.168.1.1/admin").ok === false, "192.168 私網被擋下");
assert(previewUrlAllowed("http://169.254.169.254/latest/meta-data/").ok === false, "中繼資料主機被擋下");
assert(previewUrlAllowed("http://localhost:9/x").ok === false, "localhost 預設被擋下");
assert(previewUrlAllowed("http://127.0.0.1:9/x", { allowLoopback: true }).ok === true, "測試模式放行 127.0.0.1");
assert(previewUrlAllowed("https://www.nvidia.com/news").ok === true, "公開 https 通過");

// 接口驗證：缺參數、非 http(s)、內網一律 400
const pvMissing = await call("GET", "/api/link-preview");
assert(pvMissing.res.status === 400, "缺 url 參數被擋下");
const pvFtp = await call("GET", "/api/link-preview?url=" + encodeURIComponent("ftp://example.com/x"));
assert(pvFtp.res.status === 400, "ftp 連結被擋下");
const pvPrivate = await call("GET", "/api/link-preview?url=" + encodeURIComponent("http://10.1.2.3/x"));
assert(pvPrivate.res.status === 400, "私網連結被擋下");
const pvMeta = await call("GET", "/api/link-preview?url=" + encodeURIComponent("http://169.254.169.254/latest/meta-data/"));
assert(pvMeta.res.status === 400, "中繼資料連結被擋下");

// 實抓：本地測試伺服器（127.0.0.1，測試模式才放行）
const previewServer = http.createServer((req, res) => {
  if (req.url === "/redir") { res.writeHead(302, { Location: "/page" }); res.end(); return; }
  if (req.url === "/plain") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("just text"); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>測試報告</title><meta property="og:description" content="這是一份測試報告的摘要。"></head><body>hi</body></html>`);
});
await new Promise(r => previewServer.listen(0, "127.0.0.1", r));
const pvPort = previewServer.address().port;
const pvPage = await call("GET", "/api/link-preview?url=" + encodeURIComponent(`http://127.0.0.1:${pvPort}/page`));
assert(pvPage.data.ok === true, "本地頁面預覽成功");
assert(pvPage.data.title === "測試報告", "預覽標題正確");
assert(pvPage.data.description === "這是一份測試報告的摘要。", "預覽描述正確");
assert(pvPage.data.domain === "127.0.0.1", "預覽域名正確");
assert(pvPage.data.cached === false, "第一次抓取非快取");
const pvPage2 = await call("GET", "/api/link-preview?url=" + encodeURIComponent(`http://127.0.0.1:${pvPort}/page`));
assert(pvPage2.data.ok === true && pvPage2.data.cached === true, "第二次同一連結走快取");
const pvRedir = await call("GET", "/api/link-preview?url=" + encodeURIComponent(`http://127.0.0.1:${pvPort}/redir`));
assert(pvRedir.data.ok === true && pvRedir.data.title === "測試報告", "重定向跟隨成功");
const pvPlain = await call("GET", "/api/link-preview?url=" + encodeURIComponent(`http://127.0.0.1:${pvPort}/plain`));
assert(pvPlain.data.ok === false, "非 HTML 目標回 ok:false，前端退回普通連結");
await new Promise(r => previewServer.close(r));

console.log("\n全部測試通過。");
