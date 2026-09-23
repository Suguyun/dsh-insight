// dsh-insight service worker。
//
// 职责：
//   1. 与运行中的 dsh web 服务器保持 WebSocket 桥接
//      （ws://<dsh>/dsh-insight/bridge，由 dsh 侧插件注册）。
//   2. 执行 dsh 智能体浏览器工具发来的 `action` 帧
//      （get_page / list_tabs / navigate / click / open_tab / capture_*）。
//   3. 通过 Chrome DevTools 协议（chrome.debugger）抓取活动标签页的
//      HTTP 请求/响应，供智能体读取。
//   4. 监听页面变化（标签切换 / 主框架导航 / SPA 路由 pushState/replaceState），
//      防抖后把“当前页面”（URL/标题/正文，1,000,000 字符封顶，另带 truncated
//      标记）推给 dsh 侧，由页面注入器写进会话。只有活动标签页的导航会排队，
//      URL 与正文长度都没变的推送会跳过（桥接重连时例外，一定重发）。
//   5. 与侧栏之间的 port 通信（name "panel"）：广播桥接/抓包状态与错误，
//      接收“停止抓包”指令，并在 dsh 重启或模块图变化时让侧栏刷新。
//   6. 远程 CDP 通道：injectable() 按标签页 URL 事先判定能不能注入脚本，
//      判定为否的页面（非 http(s)——chrome:// / file: / 跨扩展页——以及
//      Chrome 应用商店）读取和点击都只走 http://127.0.0.1:9222 的远程调试
//      协议。这不是“注入失败后的回退”：普通 http(s) 页面即使注入失败也不会
//      改走 CDP（https 上的 PDF 同样按普通页面处理）。
//
// 侧栏页面本身只嵌入 dsh 网页界面（外加一条状态栏）；本 worker 是扩展里
// 唯一接触 Chrome API 的部分。

const DEFAULT_DSH_URL = "http://127.0.0.1:3080";

// ---- 配置 / 状态 ----

let dshUrl = DEFAULT_DSH_URL;
let ws = null;
let wsRetry = 2000;
let reconnectTimer = null;
let wasDown = false; // 桥接曾断开：重连后触发侧栏自动刷新（dsh 重启自恢复）

// 页面快照自动推送开关（本地修改）。
//
// 宿主侧的消费者 —— dsh-insight-page-injector —— 已经在
// ~/.dsh/profiles/web/cordis.patch.yml 里被禁用，推过去的快照没人接，
// 于是「每次切标签/导航都注入脚本抓一遍正文再发一帧」纯属白干。默认关。
//
// 恢复自动附带需要**两处一起开**：
//   1) cordis.patch.yml 里取消注释 insert 块，把注入器挂回来；
//   2) chrome.storage.local.set({ insight_autopush: true })
// 只开一处不会生效：生产端与消费端互不感知，一边开着另一边只会静默空转。
let autopush = false;

// 每个标签页的抓包状态。
const captures = new Map(); // tabId -> { attached: bool, entries: [], seq }
const MAX_ENTRIES = 500; // 每个标签页保留的请求条数
const MAX_BODY = 1_000_000; // 单个请求/响应体保留的字符数（1MB 保护阀）

/**
 * 截到 MAX_BODY 并复制成独立字符串。
 * slice 返回的是共享原串内存的视图，抓包条目最多留 500 条、直到标签页关闭
 * 才释放，直接存视图会把每条的完整原始响应体（可能几十 MB）一起钉住。
 */
const capBody = (s) => (s.length > MAX_BODY ? (" " + s.slice(0, MAX_BODY)).slice(1) : s);
// 自动推送的页面正文字符数上限。
// 本地修改：上游是 1_000_000。自动推送只是让智能体知道“你在看什么”，宿主侧
// 注入时还会再截到 4000 字符，1MB 既没必要又会把大页面整篇搬过 WebSocket。
const MAX_PAGE = 8_000;
// browser_get_page 按需读取的限额——与上面的自动注入是两套额度，
// README / docs/bridge-protocol.md 都引用这两个数字。
const GET_PAGE_TEXT_LIMIT = 40_000;
const GET_PAGE_MAX_LINKS = 400;

// ---- 侧栏通信 ----

const panelPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === "capture-stop") stopActiveCapture().catch(reportError);
  });
  broadcastStatus();
});

function toPanel(msg) {
  for (const port of panelPorts) {
    try {
      port.postMessage(msg);
    } catch {}
  }
}

function broadcastStatus() {
  const capturing = [...captures.values()].some((c) => c.attached);
  toPanel({
    type: "status",
    kind: ws ? "ok" : "warn",
    text: ws
      ? (capturing ? "桥接已连接 · 正在抓包" : "桥接已连接")
      : "桥接未连接 — dsh web 是否已启动？",
    capturing,
  });
}

function reportError(err) {
  toPanel({ type: "status", kind: "error", text: errMsg(err) });
}

// ---- 设置（dsh 地址 / 页面快照推送开关） ----

async function loadSettings() {
  const stored = await chrome.storage.local.get(["dsh_url", "insight_autopush"]);
  dshUrl = (stored.dsh_url || DEFAULT_DSH_URL).replace(/\/+$/, "");
  // 只有显式写入 true 才开；缺失/脏值一律当关（失败安全：宁可不推）。
  autopush = stored.insight_autopush === true;
}

// ---- 划词解读 ----

// 只取 origin：路由是本机精确路由，token 之类的查询串不参与。
function dshOrigin() {
  try {
    return new URL(dshUrl).origin;
  } catch {
    return dshUrl;
  }
}

/**
 * 该 URL 是否就是 dsh 自己的网页界面（按 origin 判断）。
 * 本地修改：自动注入要跳过它 —— 它的正文就是整段对话，而对话里又含有之前
 * 注入的“当前页面”消息，推它等于让注入自我复制、逐轮放大（实测把上下文顶到
 * 150 万 token 触发 400）。宿主侧还有一道正文回声检测兜底。
 */
function isDshPage(url) {
  try {
    return new URL(url).origin === dshOrigin();
  } catch {
    return false;
  }
}

/**
 * 把一次划词发到 dsh 的 /dsh-insight（host 侧 selection-insight 插件注册的
 * 精确路由，不在 /api 的 HOST/Origin + cookie 围栏内，所以不需要任何鉴权）。
 * @returns {{ok: boolean, text?: string, error?: string}}
 */
async function interpretSelection(input) {
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (text === "") return { ok: false, error: "选区为空" };

  // 自定义解读口径由设置页存成「已解析好的文本」；为空就让 host 用它自己的默认。
  let system = "";
  try {
    const stored = await chrome.storage.local.get("insight_system");
    if (typeof stored.insight_system === "string") system = stored.insight_system;
  } catch {}

  try {
    const response = await fetch(`${dshOrigin()}/dsh-insight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        url: input?.url ?? "",
        title: input?.title ?? "",
        ...(system === "" ? {} : { system }),
        // 追问讨论的往返历史。host 侧只认 user/assistant，且会再封一次顶。
        ...(Array.isArray(input?.history) && input.history.length > 0
          ? { history: input.history }
          : {}),
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      return {
        ok: false,
        error: String(payload?.error ?? `HTTP ${String(response.status)}`),
      };
    }
    return { ok: true, text: String(payload.text ?? "") };
  } catch (error) {
    return {
      ok: false,
      error: `连不上 dsh（${errMsg(error)}）— dsh web 在跑吗？`,
    };
  }
}

// 侧栏发来的消息。
//   interpret —— 网页划词：调 host 解读，并把这次结果落成「最近一条记录」+ 广播给侧栏。
//   discuss   —— 侧栏里的追问讨论：同一条 host 调用，但**不落记录、不广播** ——
//                讨论挂在当前那条解读上，不该覆盖「最近一条」。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "discuss") {
    interpretSelection({
      text: msg.text,
      url: msg.url,
      title: msg.title,
      history: msg.history,
    })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: errMsg(error) }));
    return true; // 异步回复
  }

  if (msg?.type !== "interpret") return undefined;
  (async () => {
    const started = Date.now();
    // 先告诉侧栏「开始了」。一次解读要十几秒（实测有过 20 秒），这期间面板上
    // 什么动静都没有，很容易被当成没反应 —— 尤其 auto-sidebar 模式下页面里
    // 本来就没有任何 UI。
    toPanel({
      type: "insight-pending",
      url: String(msg.url ?? ""),
      title: String(msg.title ?? ""),
    });
    const result = await interpretSelection(msg);
    const record = {
      at: new Date().toISOString(),
      url: String(msg.url ?? ""),
      title: String(msg.title ?? ""),
      text: String(msg.text ?? ""),
      ok: result.ok,
      answer: result.ok ? result.text : "",
      error: result.ok ? "" : String(result.error ?? ""),
      ms: Date.now() - started,
    };
    try {
      await chrome.storage.local.set({ last_insight: record });
    } catch {}
    // 侧栏开着时实时刷新（不依赖存储事件）。
    toPanel({ type: "insight", record });
    sendResponse(result);
  })();
  return true; // 异步回复
});

// ---- WebSocket 桥接 ----

function connectBridge() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  let sock;
  try {
    sock = new WebSocket(`${dshUrl.replace(/^http/, "ws")}/dsh-insight/bridge`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    wsRetry = 2000;
    broadcastStatus();
    // dsh 重启后桥接重连 → 自动刷新侧栏里的 dsh 页面（自我恢复）
    if (wasDown) {
      wasDown = false;
      toPanel({ type: "reload-gui" });
    }
    // 桥接恢复时补发一次当前页面。必须先清掉去重记录：dsh 侧在最后一个
    // socket 断开时就丢掉了 currentPage（见 host/bridge.js），所以哪怕页面
    // 没变也得重发一遍，否则 dsh 重启后智能体就一直不知道你在看什么，
    // 直到你碰巧导航到别处为止。
    lastPushed = null;
    pushCurrentPage().catch(() => {});
  };
  sock.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "action") handleAction(msg).catch((err) => sendResult(msg.id, false, null, errMsg(err)));
    if (msg.type === "graph-changed") {
      // dsh 模块图变化（安装/移除插件行）→ 让侧栏自动刷新，免手动刷新页面
      toPanel({ type: "reload-gui" });
      return;
    }
    if (msg.type === "pong") return;
  };
  sock.onclose = () => {
    if (ws === sock) {
      ws = null;
      wasDown = true;
    }
    broadcastStatus();
    scheduleReconnect();
  };
  sock.onerror = () => sock.close();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, wsRetry);
  wsRetry = Math.min(wsRetry * 2, 30000);
}

const bridgeOpen = () => Boolean(ws) && ws.readyState === WebSocket.OPEN;

function sendResult(id, ok, result, error) {
  if (!bridgeOpen()) return;
  ws.send(JSON.stringify({ type: "result", id, ok, result, error }));
}

function sendPage(tab) {
  if (!bridgeOpen() || !tab) return;
  ws.send(JSON.stringify({ type: "page", tab }));
}

// 空闲保活：有活动 WebSocket 时 MV3 的 service worker 不会被挂起，
// ping 同时用于检测连接健康。
setInterval(() => {
  if (bridgeOpen()) {
    ws.send(JSON.stringify({ type: "ping" }));
  } else {
    connectBridge();
  }
}, 15000);

// ---- 页面变化监听（当前页面自动推送） ----

let pageTimer = null;
let lastPushed = null; // { url, length } 上次推过的页面，用于跳过重复推送
function schedulePagePush() {
  if (!autopush) return; // 推送开关关着：连排队都不必
  if (pageTimer) clearTimeout(pageTimer);
  pageTimer = setTimeout(() => {
    pageTimer = null;
    pushCurrentPage().catch(() => {});
  }, 2000); // 防抖：快速连续导航只推最后一次
}

/**
 * 只有活动标签页的导航才值得重抓——推的永远是活动标签页。
 * 先同步判掉桥接没连上的情况：SPA 路由事件非常密集，dsh 没运行时不该为
 * 每一次都唤醒 worker 去查一次标签页。
 */
async function schedulePagePushFor(tabId) {
  // 开关在查标签页之前判：SPA 路由事件非常密集，关掉时就别再去问一次活动标签页。
  if (!autopush) return;
  if (!bridgeOpen()) return;
  const tab = await activeTab();
  if (tab && tab.id === tabId) schedulePagePush();
}

chrome.tabs.onActivated.addListener(() => schedulePagePush());
// 主框架的真实导航
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) schedulePagePushFor(details.tabId).catch(() => {});
});
// SPA 路由（history.pushState/replaceState）不会触发 onCommitted，
// 必须单独监听，否则单页应用换“页面”时智能体看到的还是旧内容。
// 这类事件比真实导航密集得多（后台标签页里的 Gmail/Slack 也会一直发），
// 所以务必先确认是活动标签页再排队。
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) schedulePagePushFor(details.tabId).catch(() => {});
});

async function pushCurrentPage() {
  // 开关关着：不抓正文、不发帧。这里也判一次，是因为桥接重连（sock.onopen）会
  // 直接调用本函数补推，绕过上面两个排队入口。
  if (!autopush) return;
  // 桥接没连上时 sendPage 会直接丢弃这一帧，所以先查连接再抓取：否则
  // dsh 没运行时每次切标签/导航都白做一次全文提取（还可能触发 CDP 请求）。
  if (!bridgeOpen()) return;
  const tab = await activeTab();
  if (!tab) return;
  // chrome:// 等内部页面、Chrome 应用商店页等不可注入，直接跳过。
  // url 为空（标签页尚未提交导航，只有 pendingUrl）时同样跳过。
  if (!injectable(tab.url)) return;
  // 本地修改：不推送 dsh 自己的界面（自指放大，见 isDshPage 注释）。
  if (isDshPage(tab.url)) return;
  const page = await scrapeTab(tab, MAX_PAGE, 0);
  // replaceState 常常反复推同一个页面：URL 与正文长度都没变就别再注入一遍
  // （每次注入都是一条最大 1MB 的用户消息）。
  if (lastPushed && lastPushed.url === page.url && lastPushed.length === page.text.length) return;
  lastPushed = { url: page.url, length: page.text.length };
  sendPage({ url: page.url, title: page.title, content: page.text, truncated: Boolean(page.truncated) });
}

// ---- 浏览器动作执行器（dsh 的 browser_* 工具调用） ----

function errMsg(e) {
  return String(e && e.message ? e.message : e);
}

/** 当前活动标签页（没有则 null）。“哪个标签页是活动的”只在这里定义一次。 */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab && tab.id != null ? tab : null;
}

async function needActiveTab() {
  const tab = await activeTab();
  if (!tab) throw new Error("没有活动标签页");
  return tab;
}

// ---- 远程 CDP 回退（读取 chrome-extension:// 等无法注入脚本的页面） ----
// chrome.scripting 与 chrome.debugger 都无法跨扩展访问页面（都会抛
// “Cannot access a chrome-extension:// URL of different extension”），
// 唯一通道是浏览器的远程调试协议，因此要求 Helium/Chrome 以
// `--remote-debugging-port=<CDP_PORT>` 启动。
const CDP_PORT = 9222;
const CDP_HINT = `——浏览器是否以 --remote-debugging-port=${CDP_PORT} 启动？`;

const isTimeoutErr = (e) => Boolean(e && (e.name === "TimeoutError" || e.name === "AbortError"));

async function cdpRemoteTargets() {
  // 限时 5 秒：signal 交给 fetch 后同时约束响应头与响应体的读取，
  // 调试端点卡死（含只发头不发体）都不能拖垮工具调用。
  const signal = AbortSignal.timeout(5000);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal });
  } catch (e) {
    throw new Error(`CDP 端点不可达（${isTimeoutErr(e) ? "超时" : "连接失败"}）${CDP_HINT}`);
  }
  if (!res.ok) {
    throw new Error(`CDP 端点不可用（HTTP ${res.status}）${CDP_HINT}`);
  }
  let list;
  try {
    list = await res.json();
  } catch (e) {
    throw new Error(isTimeoutErr(e) ? "CDP 端点读取超时（/json/list 响应体 5 秒未读完）" : `CDP 端点返回的不是有效 JSON（/json/list）${CDP_HINT}`);
  }
  // 端口上可能蹲着别的服务，回了 JSON 但不是目标列表：早点报清楚，
  // 别等到下面 .find/.filter 抛 "not a function"。
  if (!Array.isArray(list)) {
    throw new Error(`CDP 端点返回的 /json/list 不是目标数组${CDP_HINT}`);
  }
  return list;
}

// 失败时抛出的 Error 带 `mayHaveRun` 标记：true 表示求值请求已经发出去、
// 结果却没回来（超时／连接中断），此时表达式可能已经在页面里执行过。
// 点击路径靠它区分“肯定没点到”和“可能已经点了”。
function cdpWsEvaluate(wsUrl, expression, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let ws;
    let sent = false;
    // mayHaveRun：请求发出去了、却没等到应答，表达式可能已经在页面里跑过。
    // 拿到应答（哪怕是错误应答）就说明它没跑成，那是确定的失败。
    const fail = (message, mayHaveRun) => {
      const err = new Error(message);
      err.mayHaveRun = Boolean(mayHaveRun);
      reject(err);
    };
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      return reject(e); // 连都没连上 → 必然没执行
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      fail("CDP WebSocket 超时", sent);
    }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
      sent = true;
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (m.error) fail(m.error.message || "CDP 协议错误", false);
      else if (m.result && m.result.exceptionDetails) fail(m.result.exceptionDetails.text || "CDP 求值异常", false);
      else resolve(m.result && m.result.result ? m.result.result.value : null);
    };
    ws.onerror = () => { clearTimeout(timer); fail("CDP WebSocket 连接失败", sent); };
  });
}

/**
 * 找到 tabId 对应的远程 CDP 目标，并在其中求值。
 *
 * 按“目标身份”而非 URL 匹配：chrome.debugger.getTargets() 给出每个目标的
 * tabId 与 DevTools 目标 id，而 /json/list 的 webSocketDebuggerUrl 末段正是
 * 同一个 id，两者做一次 id 连接即可唯一确定标签页。URL 匹配做不到这一点
 * ——同 URL 的两个标签页、内嵌 iframe（本扩展侧栏里的 dsh 界面就是）、
 * 以及导航中 URL 漂移都会让它选错或选不到。
 */
async function cdpRemoteEvaluate(tabId, expression) {
  // 两个请求彼此无依赖，并发发起，省掉一次串行往返。
  const [targetId, targets] = await Promise.all([
    chrome.debugger
      .getTargets()
      .then((list) => list.find((t) => t.tabId === tabId)?.id ?? null)
      .catch(() => null), // getTargets 不可用 → 按 URL 兜底
    cdpRemoteTargets(),
  ]);

  // id 对不上不算致命：已被别的调试客户端附着的目标（本扩展刚 start_capture
  // 过、或用户开着 DevTools）在 /json/list 里不带 webSocketDebuggerUrl，而
  // TargetInfo.id 与 /json/list 的 id 相等本身也是未公开的约定——所以匹配不到
  // 就往下走 URL 兜底，不报错。
  const byId = targetId && targets.find((t) => t.webSocketDebuggerUrl && t.id === targetId);
  if (byId) return cdpWsEvaluate(byId.webSocketDebuggerUrl, expression);

  // 兜底：按 URL 精确匹配。不做前缀匹配（会匹配到另一个标签页的
  // /document、?id=2 等）；只认 type "page"，没有 page 时才考虑其它可调试
  // 类型（部分浏览器把扩展页标成别的 type），但 iframe 永远不是标签页的
  // 顶层文档，一律排除。多个候选宁可报错也不驱动错误的标签页。
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !tab.url) throw new Error("无法获取标签页 URL");
  const base = tab.url.split("#")[0];
  const matched = targets.filter((t) => t.webSocketDebuggerUrl && t.url?.split("#")[0] === base);
  const pages = matched.filter((t) => t.type === "page");
  const candidates = pages.length > 0 ? pages : matched.filter((t) => t.type !== "iframe");
  if (candidates.length === 0) {
    throw new Error(
      `未找到该标签页的 CDP 目标（${base}）——该页面可能未在远程调试中列出，` +
        `或它的调试通道已被占用（正在抓包／DevTools 已打开）${targetId ? `；按目标 id ${targetId} 也未匹配到` : ""}`
    );
  }
  if (candidates.length > 1) {
    throw new Error(`有多个标签页匹配同一 URL（${base}），无法确定目标；请只保留一个后重试`);
  }
  return cdpWsEvaluate(candidates[0].webSocketDebuggerUrl, expression);
}

// ---- 页内脚本（注入与 CDP 两条路径共用同一份实现） ----
// 这两个函数必须是顶层、无闭包的：chrome.scripting 用 toString 序列化它们，
// CDP 路径把同一份源码拼进 Runtime.evaluate 表达式。两边曾各自维护一份副本
// 并已发生实现漂移，故统一到这里。

function scrapePage(textLimit, maxLinks) {
  const bodyText = (document.body && document.body.innerText) || "";
  return {
    url: location.href,
    title: document.title,
    text: bodyText.slice(0, textLimit),
    truncated: bodyText.length > textLimit,
    links: maxLinks
      ? [...document.querySelectorAll("a[href]")].slice(0, maxLinks).map((a) => ({
          text: (a.innerText || "").trim().slice(0, 120),
          href: a.href,
        }))
      : undefined,
  };
}

function clickSelector(sel) {
  const el = document.querySelector(sel);
  if (!el) return { clicked: false, reason: "没有元素匹配 " + sel };
  el.click();
  return { clicked: true, text: (el.innerText || "").trim().slice(0, 120) };
}

/** 把一个顶层函数按参数拼成 CDP Runtime.evaluate 表达式。 */
function callExpr(fn, ...args) {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
}

// 「这个页面根本不允许注入脚本」的结构性判据：只有 http(s) 页面能注入，
// 且 Chrome 应用商店对所有扩展关闭。判据看 URL 而不是 Chrome 的英文错误
// 文案——文案会随版本和语言变，而这条判断要决定走注入还是走 CDP，
// 押在会变的字符串上太脆。
const WEBSTORE_HOST = /^(?:chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;
function injectable(url) {
  if (typeof url !== "string" || !/^https?:/i.test(url)) return false;
  return !WEBSTORE_HOST.test(url.replace(/^https?:\/\//i, ""));
}

// 可注入页面上注入仍被拒的少数理由，说明它根本没开始跑（标签页已经没了、
// 站点权限被用户设成“点击时”），副作用必然没发生。
//
// 这里确实在匹配 Chrome 的英文文案，但方向和上面那条判据相反：它只把
// indeterminate *收窄* 成 failed，匹配不上就维持 indeterminate（安全的那
// 一侧），所以 Chrome 改文案最多让点击多报一次“不确定”，不会误判成
// “没点到”而被重试。凡是 injectable() 已经挡掉的情形（chrome:// / 扩展页 /
// 应用商店）都不列在这里——那些根本走不到这个 catch。
const INJECTION_NEVER_RAN = /no tab with id|no frame with id|cannot access|cannot be scripted/i;
const injectionNeverRan = (err) => INJECTION_NEVER_RAN.test(errMsg(err));

/**
 * 在标签页里跑一段页内函数，先注入、必要时回退远程 CDP。
 *
 * 返回三态，让调用方各自决定怎么处理——这正是抓取与点击唯一的差别：
 *   { status: "ok", value }            拿到了返回值
 *   { status: "failed", error }        确定没跑成（副作用必然没发生）
 *   { status: "indeterminate", error } 跑没跑完不知道（副作用可能已发生）
 *
 * 点击不是幂等操作，"indeterminate" 与 "failed" 的区别对它性命攸关；
 * 抓取则可以把两者一视同仁地当失败报。两条路径以前各写一遍这套状态机，
 * 并且已经跑偏过，所以统一到这里。
 */
async function runInPage(tab, fn, args) {
  if (injectable(tab.url)) {
    try {
      const [injection = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fn,
        args,
      });
      if (injection.result) return { status: "ok", value: injection.result };
      // 注入执行了但页内抛错：Chrome 正常 resolve，异常放在 error 字段里，
      // 此时函数没跑完，副作用必然没发生。
      if (injection.error) return { status: "failed", error: new Error(errMsg(injection.error)) };
      // 执行了却没有帧结果——多半是页面在结果回传前被导航拆掉了。
      return { status: "indeterminate", error: new Error("脚本注入已执行但帧结果丢失（页面可能已导航）") };
    } catch (e) {
      // 可注入的页面上被拒。默认按 indeterminate 处理（不回退 CDP，也不断言
      // 副作用没发生）；只有能认出「压根没跑起来」的少数情形才降级成
      // failed，好让点击如实报告失败而不是让智能体白跑一趟复核。
      // 注意方向：这里的文案匹配只用于把 indeterminate *收窄* 成 failed，
      // Chrome 改文案最多让我们退回 indeterminate——安全的那一侧。
      return { status: injectionNeverRan(e) ? "failed" : "indeterminate", error: e };
    }
  }

  // 不可注入（扩展页 / chrome:// / file: / 应用商店）→ CDP 是唯一通道，
  // 且注入压根没运行过，副作用必然没发生。
  try {
    const value = await cdpRemoteEvaluate(tab.id, callExpr(fn, ...args));
    if (!value || typeof value !== "object") {
      return { status: "failed", error: new Error("CDP 求值未返回结果") };
    }
    return { status: "ok", value };
  } catch (e) {
    // 求值请求已发出但结果丢失 → 表达式可能已经在页面里跑过了。
    return { status: e?.mayHaveRun ? "indeterminate" : "failed", error: e };
  }
}

// 注入式抓取器：get_page 与页面推送共用。抓取可以重试，因此
// indeterminate 与 failed 一样当失败报（带上真正的原因）。
async function scrapeTab(tab, textLimit, maxLinks) {
  const r = await runInPage(tab, scrapePage, [textLimit, maxLinks]);
  if (r.status === "ok") return r.value;
  throw new Error(`读取页面失败：${errMsg(r.error)}`);
}

/**
 * 点击活动标签页里匹配选择器的元素。成功返回结果对象，失败抛错
 * （与其它动作一致，由 handleAction 统一转成 ok:false）。
 *
 * 点击不是幂等操作：一旦无法确定它是否已经发生，就绝不重试、也不回退 CDP
 * （那会在导航后的新页面上二次点击同一选择器），而是如实上报
 * clicked:"unknown"，让智能体去复核而不是重来。
 */
async function clickTab(tab, selector) {
  const r = await runInPage(tab, clickSelector, [selector]);
  if (r.status === "indeterminate") {
    return {
      clicked: "unknown",
      reason: "result_lost",
      detail: errMsg(r.error),
    };
  }
  if (r.status === "failed") throw new Error(errMsg(r.error));
  if (!r.value.clicked) throw new Error(r.value.reason || "点击失败");
  return r.value;
}

// 导航加载跟踪：确认导航真正完成，避免抓到旧页面。
function loadTracker(tabId, requireFreshLoad, timeoutMs = 15000) {
  let armed = !requireFreshLoad;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const settle = (ok) => {
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(listener);
    resolveDone(ok);
  };
  const stillPending = (t) => t && (t.pendingUrl || t.url === "about:blank");
  const listener = (id, info, t) => {
    if (id !== tabId) return;
    if (info.status === "loading") armed = true;
    else if (info.url) {
      settle(true);
      return;
    }
    if (info.status === "complete" && armed && !stillPending(t)) settle(true);
  };
  chrome.tabs.onUpdated.addListener(listener);
  const timer = setTimeout(() => settle(false), timeoutMs);
  if (!requireFreshLoad) {
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete" && !stillPending(t)) settle(true);
    }).catch(() => settle(false));
  }
  return () => done;
}

async function handleAction(msg) {
  const p = (msg.params && typeof msg.params === "object") ? msg.params : {};
  switch (msg.action) {
    case "get_page": {
      const tab = await needActiveTab();
      return sendResult(msg.id, true, await scrapeTab(tab, GET_PAGE_TEXT_LIMIT, GET_PAGE_MAX_LINKS), null);
    }
    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return sendResult(msg.id, true, tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })), null);
    }
    case "navigate": {
      const { id } = await needActiveTab();
      const awaitLoad = loadTracker(id, true);
      await chrome.tabs.update(id, { url: p.url });
      const loaded = await awaitLoad();
      return sendResult(msg.id, true, `已导航到 ${p.url}` + (loaded ? "" : "（15 秒内未确认加载完成）"), null);
    }
    case "click": {
      const tab = await needActiveTab();
      return sendResult(msg.id, true, await clickTab(tab, p.selector), null);
    }
    case "open_tab": {
      const tab = await chrome.tabs.create({ url: p.url });
      const loaded = await loadTracker(tab.id, false)();
      return sendResult(msg.id, true, `已打开标签页 ${tab.id}: ${p.url}` + (loaded ? "" : "（15 秒内未确认加载完成）"), null);
    }
    case "start_capture": {
      const { id } = await needActiveTab();
      await startCapture(id);
      return sendResult(msg.id, true, `已开始抓取标签页 ${id} 的 HTTP 请求/响应（浏览器顶部会出现调试横幅）`, null);
    }
    case "stop_capture": {
      const { id } = await needActiveTab();
      const stopped = await stopCapture(id);
      return sendResult(msg.id, true, stopped ? "抓包已停止" : "抓包本就没有在运行", null);
    }
    case "capture_requests": {
      const { id } = await needActiveTab();
      const c = captures.get(id);
      const entries = c ? c.entries.map(({ body, postData, ...rest }) => ({ ...rest, body: body || undefined, postData: postData || undefined })) : [];
      return sendResult(msg.id, true, { tabId: id, capturing: Boolean(c && c.attached), count: entries.length, entries }, null);
    }
    default:
      return sendResult(msg.id, false, null, `未知动作: ${msg.action}`);
  }
}

// ---- HTTP 请求/响应抓包（Chrome DevTools 协议） ----

async function attachDebugger(tabId) {
  if (!captures.get(tabId)?.attached) {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxPostDataSize: 512 * 1024,
    });
  }
}

async function detachDebugger(tabId) {
  const c = captures.get(tabId);
  if (!c || !c.attached) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
}

async function startCapture(tabId) {
  let c = captures.get(tabId);
  if (!c) {
    c = { attached: false, entries: [], seq: 0 };
    captures.set(tabId, c);
  }
  if (c.attached) return;
  await attachDebugger(tabId);
  c.attached = true;
  broadcastStatus();
}

async function stopCapture(tabId) {
  const c = captures.get(tabId);
  if (!c || !c.attached) return false;
  await detachDebugger(tabId);
  c.attached = false;
  broadcastStatus();
  return true;
}

async function stopActiveCapture() {
  const tab = await activeTab();
  if (tab) await stopCapture(tab.id);
  broadcastStatus();
}

// 标签页关闭时清理，绝不泄漏 debugger 附着。
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const c = captures.get(tabId);
  if (c && c.attached) await detachDebugger(tabId);
  captures.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  const c = captures.get(source.tabId);
  if (c) c.attached = false;
  broadcastStatus();
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const c = captures.get(source.tabId);
  if (!c || !c.attached) return;
  if (method === "Network.requestWillBeSent") {
    const { requestId, request, type, timestamp } = params;
    c.entries.push({
      id: requestId,
      seq: ++c.seq,
      method: request.method,
      url: request.url,
      type,
      postData: request.postData ? capBody(request.postData) : undefined,
      status: null,
      mimeType: null,
      body: null,
      time: timestamp,
    });
    if (c.entries.length > MAX_ENTRIES) c.entries.splice(0, c.entries.length - MAX_ENTRIES);
  } else if (method === "Network.responseReceived") {
    const entry = c.entries.find((e) => e.id === params.requestId);
    if (!entry) return;
    entry.status = params.response.status;
    entry.mimeType = params.response.mimeType;
    entry.redirect = Boolean(params.response.status >= 300 && params.response.status < 400);
  } else if (method === "Network.loadingFinished") {
    const entry = c.entries.find((e) => e.id === params.requestId);
    if (!entry || entry.body || entry.redirect) return;
    try {
      const { body, base64Encoded } = await chrome.debugger.sendCommand(
        { tabId: source.tabId },
        "Network.getResponseBody",
        { requestId: params.requestId }
      );
      // 先按上限截 base64 再解码：整段解一个几十 MB 的图片/字体响应，然后
      // 扔掉除 1 MB 以外的全部，纯属浪费（4 个 base64 字符 → 3 字节）。
      entry.body = capBody(
        base64Encoded ? "[base64] " + atob(body.slice(0, Math.ceil(MAX_BODY / 3) * 4)) : body
      );
    } catch {
      entry.body = "(响应体不可用)";
    }
  }
});

// ---- 启动 ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// 设置里改了 dsh 地址或推送开关 → 重新载入配置。
// （地址在下次桥接重连时生效；开关立刻生效。）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.dsh_url === undefined && changes.insight_autopush === undefined) return;
  loadSettings().catch(() => {});
});

(async () => {
  await loadSettings();
  connectBridge();
})();
