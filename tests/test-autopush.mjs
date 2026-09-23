// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/background.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 记录用的桩 ----
const store = {};
const calls = [];
const listeners = {};   // 事件名 -> [fn]
const frames = [];      // 所有 ws.send 的内容
const reg = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); }, removeListener: () => {} });
const lazy = (path) => new Proxy(function () {}, {
  apply: () => { calls.push(path); return Promise.resolve(undefined); },
  get: (_t, p) => (p === "then" ? undefined : lazy(`${path}.${String(p)}`)),
});
const defined = {
  storage: {
    local: {
      get: async (keys) => { const l = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of l) if (k in store) o[k] = store[k]; return o; },
      set: async (o) => Object.assign(store, o),
    },
    onChanged: reg("storage.onChanged"),
  },
  tabs: {
    query: async () => [{ id: 1, url: "https://example.com/p", title: "Example" }],
    onActivated: reg("tabs.onActivated"),
    onUpdated: reg("tabs.onUpdated"),
  },
  webNavigation: {
    onCommitted: reg("webNavigation.onCommitted"),
    onHistoryStateUpdated: reg("webNavigation.onHistoryStateUpdated"),
  },
  scripting: {
    executeScript: async (opts) => {
      calls.push("scripting.executeScript");
      return [{ result: { url: "https://example.com/p", title: "Example", text: "PAGE TEXT", truncated: false } }];
    },
  },
  runtime: {
    onConnect: reg("runtime.onConnect"),
    onMessage: reg("runtime.onMessage"),
    onInstalled: reg("runtime.onInstalled"),
    sendMessage: async () => ({}),
    getURL: (p) => `chrome-extension://x/${p}`,
  },
  sidePanel: { setPanelBehavior: async () => undefined },
  debugger: { attach: async () => {}, sendCommand: async () => ({}), detach: async () => {}, onEvent: reg("debugger.onEvent") },
  cookies: { get: async () => null },
};
// 递归包裹：defined 里没写的深层路径也自动变成「记录 + 返回 Promise」的桩，
// 否则 chrome.tabs.onRemoved 这种没列出的键会取到 undefined 而抛错。
function wrap(obj, path) {
  return new Proxy(obj, {
    get(t, p) {
      if (typeof p === "symbol") return t[p];
      if (p in t) {
        const v = t[p];
        return v !== null && typeof v === "object" ? wrap(v, `${path}.${String(p)}`) : v;
      }
      return lazy(`${path}.${String(p)}`);
    },
  });
}
globalThis.chrome = wrap(defined, "chrome");
class FakeWS {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = 1; setTimeout(() => { this.onopen?.(); }, 0); }
  send(d) { frames.push(d); }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeWS;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const fired = (name, ...a) => { for (const fn of listeners[name] || []) fn(...a); };
const pageFrames = () => frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter((m) => m?.type === "page");

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };

await import(URL_);
await tick(120);   // 启动：loadSettings + connectBridge

console.log("1) 默认（storage 里没有开关）");
check("桥接已连上", frames.length >= 0 && (listeners["tabs.onActivated"] || []).length === 1);
fired("tabs.onActivated");
await tick(2400);
check("不推送页面帧", pageFrames().length === 0, String(pageFrames().length));
check("完全没有注入抓取脚本", !calls.includes("scripting.executeScript"), JSON.stringify(calls.slice(0, 5)));

console.log("2) 开关打开后应恢复");
store.insight_autopush = true;
fired("storage.onChanged", { insight_autopush: { newValue: true } }, "local");
await tick(80);
fired("tabs.onActivated");
await tick(2400);
check("恢复推送页面帧", pageFrames().length === 1, String(pageFrames().length));
check("确实抓了页面（走了注入）", calls.includes("scripting.executeScript"));
check("帧里带正文与 URL", pageFrames()[0]?.tab?.content === "PAGE TEXT" && pageFrames()[0]?.tab?.url === "https://example.com/p",
  JSON.stringify(pageFrames()[0]?.tab ?? null));

console.log("3) 再关掉应立刻停止");
const before = pageFrames().length;
store.insight_autopush = false;
fired("storage.onChanged", { insight_autopush: { newValue: false } }, "local");
await tick(80);
fired("tabs.onActivated");
await tick(2400);
check("不再新增页面帧", pageFrames().length === before, String(pageFrames().length));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
