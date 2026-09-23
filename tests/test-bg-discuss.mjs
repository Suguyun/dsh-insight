// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/background.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

const store = { insight_system: "MY_SYSTEM" };
const listeners = {};
const panelMsgs = [];
const fetches = [];
const reg = (n) => ({ addListener: (fn) => { (listeners[n] ||= []).push(fn); }, removeListener: () => {} });
const lazy = (p) => new Proxy(function () {}, { apply: () => Promise.resolve(undefined), get: (_t, k) => (k === "then" ? undefined : lazy(`${p}.${String(k)}`)) });
const defined = {
  storage: { local: {
    get: async (keys) => { const l = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of l) if (k in store) o[k] = store[k]; return o; },
    set: async (o) => { Object.assign(store, o); store.__writes = (store.__writes || []).concat([Object.keys(o).join(",")]); } },
    onChanged: reg("storage.onChanged") },
  tabs: { query: async () => [], onActivated: reg("t") },
  webNavigation: { onCommitted: reg("w"), onHistoryStateUpdated: reg("h") },
  scripting: { executeScript: async () => [] },
  runtime: { onConnect: reg("runtime.onConnect"), onMessage: reg("runtime.onMessage"), onInstalled: reg("runtime.onInstalled"), sendMessage: async () => ({}), getURL: (p) => `chrome-extension://x/${p}` },
  sidePanel: { setPanelBehavior: async () => undefined },
  debugger: { attach: async () => {}, sendCommand: async () => ({}), detach: async () => {}, onEvent: reg("d") },
};
function wrap(o, p) { return new Proxy(o, { get(t, k) { if (typeof k === "symbol") return t[k];
  if (k in t) { const v = t[k]; return v !== null && typeof v === "object" ? wrap(v, `${p}.${String(k)}`) : v; }
  return lazy(`${p}.${String(k)}`); } }); }
globalThis.chrome = wrap(defined, "chrome");
class FakeWS { static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  constructor(u) { this.url = u; this.readyState = 1; setTimeout(() => this.onopen?.(), 0); } send() {} close() { this.readyState = 3; } }
globalThis.WebSocket = FakeWS;
globalThis.fetch = async (url, init) => {
  fetches.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => ({ ok: true, text: "REPLY" }) };
};

await import(URL_);
await tick(120);

// 挂一个假的侧栏端口，用来判断有没有广播；同时捕获 onDisconnect，
// 以便后面模拟「侧栏被关掉」来验证兜底闸门。
const panelDisconnects = [];
for (const fn of listeners["runtime.onConnect"] || []) {
  fn({
    name: "panel",
    onDisconnect: { addListener: (h) => panelDisconnects.push(h) },
    onMessage: { addListener() {} },
    postMessage: (m) => panelMsgs.push(m),
  });
}

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };
const send = (msg) => new Promise((resolve) => { for (const fn of listeners["runtime.onMessage"] || []) fn(msg, {}, resolve); });

console.log("1) 首次划词 interpret");
store.__writes = []; panelMsgs.length = 0; fetches.length = 0;
let reply = await send({ type: "interpret", text: "选区", url: "https://e.com", title: "T" });
await tick(30);
check("返回 ok", reply?.ok === true && reply.text === "REPLY");
check("写入了 last_insight", (store.__writes || []).some((w) => w.includes("last_insight")), JSON.stringify(store.__writes));
check("广播了 insight 给侧栏", panelMsgs.some((m) => m.type === "insight"));
check("先广播了 insight-pending", panelMsgs.some((m) => m.type === "insight-pending"), JSON.stringify(panelMsgs.map((m) => m.type)));
check("pending 在 insight 之前", panelMsgs.findIndex((m) => m.type === "insight-pending") < panelMsgs.findIndex((m) => m.type === "insight"));
check("请求体带 system、无 history", fetches[0].body.system === "MY_SYSTEM" && fetches[0].body.history === undefined, JSON.stringify(fetches[0].body));

console.log("2) 追问 discuss —— 不应覆盖记录、不应广播");
store.__writes = []; panelMsgs.length = 0; fetches.length = 0;
reply = await send({
  type: "discuss", text: "选区", url: "https://e.com", title: "T",
  history: [{ role: "assistant", text: "首次解读" }, { role: "user", text: "追问" }],
});
await tick(30);
check("返回 ok", reply?.ok === true && reply.text === "REPLY", JSON.stringify(reply));
check("请求体带上了 history", Array.isArray(fetches[0].body.history) && fetches[0].body.history.length === 2, JSON.stringify(fetches[0].body));
check("没有写 last_insight", !(store.__writes || []).some((w) => w.includes("last_insight")), JSON.stringify(store.__writes));
check("没有广播 insight", !panelMsgs.some((m) => m.type === "insight"), JSON.stringify(panelMsgs));
check("讨论也不该广播 pending（面板自己有思考中占位）", !panelMsgs.some((m) => m.type === "insight-pending"), JSON.stringify(panelMsgs.map((m) => m.type)));

console.log("4) 侧栏未展开时的兜底闸门");
// 端口断开 = 侧栏被关掉（内容脚本已在源头拦过；这里防的是浮标弹出后侧栏才关掉的竞态）
for (const h of panelDisconnects) h();
await tick(30);

let q = await send({ type: "panel-state-query" });
check("panel-state-query 报告侧栏已关", q?.open === false, JSON.stringify(q));

store.__writes = []; fetches.length = 0; panelMsgs.length = 0;
reply = await send({ type: "interpret", text: "选区", url: "https://e.com", title: "T", target: "sidebar" });
await tick(30);
check("target=sidebar 且侧栏关：不调用模型", fetches.length === 0, String(fetches.length));
check("target=sidebar 且侧栏关：回复 skipped", reply?.skipped === true && reply?.ok === false, JSON.stringify(reply));
check("target=sidebar 且侧栏关：不写 last_insight", !(store.__writes || []).some((w) => w.includes("last_insight")), JSON.stringify(store.__writes));
check("target=sidebar 且侧栏关：不广播 pending", !panelMsgs.some((m) => m.type === "insight-pending"), JSON.stringify(panelMsgs.map((m) => m.type)));

// 页面浮窗模式不受影响 —— 结果画在页面上，侧栏关着也照常解读
fetches.length = 0;
reply = await send({ type: "interpret", text: "选区", url: "https://e.com", title: "T", target: "page" });
await tick(30);
check("target=page 且侧栏关：照常调用模型", fetches.length === 1 && reply?.ok === true, JSON.stringify(reply));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
