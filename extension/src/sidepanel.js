// 侧栏。两个视图：
//   划词解读 —— 本页自己渲染，不经过 iframe，因此不依赖 dsh 的鉴权、cookie 或
//               /api 的 RPC 通道；
//   设置     —— 把扩展选项页（options.html）同源内嵌进来，省得每次都跳到独立
//               标签页。
//
// 划词流程：网页内容脚本 → service worker 的 /dsh-insight 请求 → 结果同时回到
// 页面上的卡片和这里（background 会广播 { type: "insight", record }）。

import { renderMarkdown } from "./md.js";
import {
  applyAppearance,
  loadAppearance,
  watchAppearance,
} from "./appearance.js";

const insight = document.getElementById("insight");
const stopBtn = document.getElementById("stopCapture");
const settingsBtn = document.getElementById("settings");
const statusEl = document.getElementById("status");
const recordEl = document.getElementById("record");
const metaEl = document.getElementById("meta");
const quoteEl = document.getElementById("quote");
const quoteBoxEl = document.getElementById("quoteBox");
const quoteCountEl = document.getElementById("quoteCount");
const quoteToggleBtn = document.getElementById("quoteToggle");
const quoteEditBtn = document.getElementById("quoteEdit");
const quoteInputEl = document.getElementById("quoteInput");
const quoteActionsEl = document.getElementById("quoteActions");
const quoteReinterpretBtn = document.getElementById("quoteReinterpret");
const quoteCancelBtn = document.getElementById("quoteCancel");
// 折叠阈值：超过这么多字符才给「展开」。太短的内容套一层展开反而啰嗦。
const QUOTE_CLAMP_CHARS = 160;
const answerEl = document.getElementById("answer");
const emptyEl = document.getElementById("empty");
const optionsFrame = document.getElementById("optionsFrame");
const pendingEl = document.getElementById("pending");
const pendingTextEl = document.getElementById("pendingText");
const threadEl = document.getElementById("thread");
const askForm = document.getElementById("askForm");
const askEl = document.getElementById("ask");
const askSendBtn = document.getElementById("askSend");

let optionsLoaded = false;
// 当前视图：insight | settings。两者互斥。
let currentView = "insight";

let panelPort = connect();

function connect() {
  const p = chrome.runtime.connect({ name: "panel" });
  p.onMessage.addListener((msg) => {
    if (msg.type === "status") renderStatus(msg);
    // 开始解读 → 先显示「正在解读」；结果到了再收起来。
    if (msg.type === "insight-pending") showPending();
    if (msg.type === "insight") {
      hidePending();
      renderRecord(msg.record);
    }
  });
  p.onDisconnect.addListener(() => {
    panelPort = connect();
  });
  return p;
}

// ---- 「正在解读」指示 ----
//
// 一次解读实测要十几秒（有过 20 秒）。这期间面板上如果什么都不变，用户只会
// 以为「没反应」或者把上一条结果当成新的 —— 所以要明确地表示「在动」。
// 顺带把等了多少秒显示出来：不是假进度条，但比一个纯粹转圈更有信息量。

let pendingTimer = null;
let pendingStartedAt = 0;

function paintPending() {
  const sec = Math.max(0, Math.round((Date.now() - pendingStartedAt) / 1000));
  pendingTextEl.textContent = sec < 1 ? "正在解读…" : `正在解读… 已 ${String(sec)} 秒`;
}

function showPending() {
  pendingStartedAt = Date.now();
  pendingEl.hidden = false;
  // 压暗上一条记录：它在视觉上不该再像「当前结果」。
  insight.dataset.busy = "1";
  paintPending();
  if (pendingTimer === null) pendingTimer = window.setInterval(paintPending, 1000);
}

function hidePending() {
  pendingEl.hidden = true;
  insight.dataset.busy = "";
  if (pendingTimer !== null) {
    window.clearInterval(pendingTimer);
    pendingTimer = null;
  }
}

// 顶栏只说桥接状态（由 service worker 推送）。
let bridgeStatus = { kind: "", text: "" };

function paint() {
  statusEl.textContent = bridgeStatus.text || "";
  statusEl.dataset.kind = bridgeStatus.kind || "";
}

function renderStatus(s) {
  bridgeStatus = s;
  paint();
}

// ---- 划词记录 ----

// 追问讨论的往返（不含首次解读本身）。挂在「当前这条记录」上：划到新的选区就重开。
let thread = [];
let currentRecord = null;
let asking = false;

function recordKey(record) {
  return `${record?.at ?? ""}|${record?.url ?? ""}`;
}

// ---- 选区原文：折叠与就地编辑 ----

let quoteExpanded = false;
let quoteEditing = false;
// 编辑框里的文字是否被改过（用来决定「用这段重新解读」是否可点）
let quoteDirty = false;

/** 折叠态只在内容确实超出时才启用 —— 短文本不套展开按钮。 */
function applyQuoteClamp() {
  const text = quoteEl.textContent ?? "";
  const longEnough = text.length > QUOTE_CLAMP_CHARS;
  quoteEl.dataset.clamped = !quoteExpanded && longEnough ? "1" : "0";
  quoteToggleBtn.hidden = !longEnough || quoteEditing;
  quoteToggleBtn.textContent = quoteExpanded ? "收起" : "展开";
  quoteCountEl.textContent = text.length > 0 ? `${text.length} 字` : "";
}

function setQuoteEditing(on) {
  quoteEditing = on;
  quoteInputEl.hidden = !on;
  quoteEl.hidden = on;
  quoteActionsEl.hidden = !on;
  quoteEditBtn.hidden = on;
  if (on) {
    quoteInputEl.value = currentRecord?.text ?? "";
    quoteDirty = false;
    quoteReinterpretBtn.disabled = true;
    // 编辑时先把焦点放进去，省一次点击。
    quoteInputEl.focus();
  }
  applyQuoteClamp();
}

/** 侧栏里改完原文，用改过的内容重新解读一遍（划词常常选得不精确）。 */
async function reinterpretEdited() {
  const text = quoteInputEl.value.trim();
  if (text === "" || currentRecord === null) return;
  const { url, title } = currentRecord;
  setQuoteEditing(false);
  showPending();
  try {
    await chrome.runtime.sendMessage({
      type: "interpret",
      text,
      url: url ?? "",
      title: title ?? "",
      // 结果要回本面板；background 的兜底闸门据此判断「侧栏开着才解读」。
      target: "sidebar",
    });
  } catch (error) {
    hidePending();
    answerEl.dataset.kind = "error";
    answerEl.textContent = `解读失败：${String(error?.message ?? error)}`;
  }
}

quoteToggleBtn.addEventListener("click", () => {
  quoteExpanded = !quoteExpanded;
  applyQuoteClamp();
});
quoteEditBtn.addEventListener("click", () => setQuoteEditing(true));
quoteCancelBtn.addEventListener("click", () => setQuoteEditing(false));
quoteReinterpretBtn.addEventListener("click", () => {
  void reinterpretEdited();
});
quoteInputEl.addEventListener("input", () => {
  const edited = quoteInputEl.value.trim();
  quoteDirty = edited !== (currentRecord?.text ?? "").trim();
  // 只有真改过才允许重新解读 —— 否则等于重复问一遍同一个问题。
  quoteReinterpretBtn.disabled = !quoteDirty || edited === "";
  // 字数跟着改动走，否则头部的数字会在编辑期间变成过期的。
  quoteCountEl.textContent = quoteInputEl.value.length > 0 ? `${quoteInputEl.value.length} 字` : "";
});

async function renderRecord(record) {
  if (record === null || record === undefined) return;
  currentRecord = record;

  // 收起「还没有解读记录。」并显示记录区。少了这两行，解读结果整块都不会出现
  // —— 界面看起来就是「划词了但什么都没发生」。
  emptyEl.hidden = true;
  recordEl.hidden = false;

  const when = new Date(record.at);
  const time = Number.isNaN(when.getTime()) ? "" : when.toLocaleTimeString();
  metaEl.textContent = [time, record.title || record.url].filter((s) => s !== "").join(" · ");
  metaEl.title = record.url ?? "";
  quoteEl.textContent = record.text ?? "";
  // 换了一条记录：折叠与编辑状态都归零，否则新内容会继承上一条的展开/编辑态。
  quoteExpanded = false;
  setQuoteEditing(false);
  applyQuoteClamp();

  if (record.ok === true) {
    answerEl.dataset.kind = "ok";
    // 解读结果是 Markdown（代码围栏、加粗、列表……），渲染出来而不是原样显示标记。
    renderMarkdown(answerEl, record.answer ?? "");
  } else {
    answerEl.dataset.kind = "error";
    answerEl.textContent = `解读失败：${record.error ?? "未知错误"}`;
  }

  // 讨论区：只对成功的解读开放（失败的没有可讨论的回答）。
  askForm.hidden = record.ok !== true;
  const key = recordKey(record);
  const restored = await loadThread(key);
  // await 期间可能又来了新的一条，那就以后者为准，别把旧线程贴上去。
  if (recordKey(currentRecord) !== key) return;
  thread = record.ok === true ? restored : [];
  renderThread();
}

// ---- 追问讨论 ----
//
// 发给 host 的 history 形状：首次解读作为第一条 assistant，之后是往返。
// 也就是说「问第 n 个问题」时，history 里已经包含这第 n 个 user 轮。

async function loadThread(key) {
  try {
    const stored = await chrome.storage.local.get("insight_thread");
    const saved = stored.insight_thread;
    if (saved !== null && typeof saved === "object" && saved.key === key && Array.isArray(saved.turns)) {
      return saved.turns.filter(
        (t) => t !== null && typeof t === "object" && typeof t.text === "string" && (t.role === "user" || t.role === "assistant")
      );
    }
  } catch {}
  return [];
}

async function saveThread() {
  if (currentRecord === null) return;
  try {
    await chrome.storage.local.set({
      insight_thread: { key: recordKey(currentRecord), turns: thread },
    });
  } catch {}
}

function userTurn(text) {
  const div = document.createElement("div");
  div.className = "ask-q";
  div.textContent = text;
  return div;
}

function assistantTurn(text) {
  const div = document.createElement("div");
  div.className = "ask-a";
  renderMarkdown(div, text);
  return div;
}

function renderThread() {
  threadEl.textContent = "";
  for (const turn of thread) {
    threadEl.append(turn.role === "user" ? userTurn(turn.text) : assistantTurn(turn.text));
  }
  threadEl.hidden = thread.length === 0;
}

/** 追问中占位，等回答回来后替换掉。 */
function pendingTurn() {
  const div = document.createElement("div");
  div.className = "ask-a pending";
  div.textContent = "思考中…";
  return div;
}

async function ask() {
  if (asking || currentRecord === null || currentRecord.ok !== true) return;
  const question = askEl.value.trim();
  if (question === "") return;

  asking = true;
  askEl.value = "";
  askEl.disabled = true;
  askSendBtn.disabled = true;

  const history = [
    { role: "assistant", text: String(currentRecord.answer ?? "") },
    ...thread,
    { role: "user", text: question },
  ];
  // 先把问题落进线程并显示出来：请求失败也不会把用户打的字弄丢。
  thread.push({ role: "user", text: question });
  threadEl.hidden = false;
  const pending = pendingTurn();
  threadEl.append(userTurn(question), pending);
  await saveThread();

  let answer;
  let failed = false;
  try {
    const reply = await chrome.runtime.sendMessage({
      type: "discuss",
      text: currentRecord.text,
      url: currentRecord.url,
      title: currentRecord.title,
      history,
    });
    if (reply?.ok === true) answer = String(reply.text ?? "");
    else {
      failed = true;
      answer = `**追问失败**：${String(reply?.error ?? "未知错误")}`;
    }
  } catch (error) {
    failed = true;
    answer = `**追问失败**：${String(error?.message ?? error)}`;
  }

  pending.remove();
  thread.push({ role: "assistant", text: answer });
  const node = assistantTurn(answer);
  if (failed) node.dataset.kind = "error";
  threadEl.append(node);
  await saveThread();

  asking = false;
  askEl.disabled = false;
  askSendBtn.disabled = false;
  askEl.focus();
  node.scrollIntoView({ block: "nearest" });
}

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void ask();
});

// Enter 发送、Shift+Enter 换行 —— 追问大多是短句，别逼用户去点按钮。
askEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void ask();
  }
});

// ---- 顶部按钮 ----

stopBtn.addEventListener("click", () => {
  panelPort.postMessage({ type: "capture-stop" });
});

// ---- 视图切换 ----
//
// 两个视图互斥：划词解读（本页自己渲染）与 设置（内嵌选项页）。
// 按钮文案跟着当前视图走，永远表示「点一下会去哪儿」。

function showView(view) {
  currentView = view;
  insight.hidden = view !== "insight";
  optionsFrame.hidden = view !== "settings";
  settingsBtn.textContent = view === "settings" ? "返回解读" : "设置";
}

settingsBtn.addEventListener("click", () => {
  if (currentView === "settings") {
    showView("insight");
    return;
  }
  // 按需加载：第一次进设置才载入内嵌选项页。之后保持不动 —— 表单里没保存的输入
  // 不会因为切走而丢；想拿到重新载入过的（例如 host 换了预设），关掉侧栏再开即可。
  if (!optionsLoaded) {
    optionsFrame.src = "options.html?embed=1";
    optionsLoaded = true;
  }
  showView("settings");
});

// ---- 启动 ----

(async () => {
  // 外观（背景色/字号）：先把第一帧按已存设置画出来，之后在设置页改一下，
  // 这里不用重载就跟着变。
  watchAppearance(applyAppearance);
  applyAppearance(await loadAppearance());

  showView("insight");

  const stored = await chrome.storage.local.get("last_insight");
  if (stored.last_insight !== undefined) renderRecord(stored.last_insight);
})();
