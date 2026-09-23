// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/background.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {};                 // 关键：没有 insight_autopush → 推送是关的
const frames = [], sockets = [], listeners = {};
const reg = (n) => ({ addListener: (fn) => { (listeners[n] ||= []).push(fn); }, removeListener: () => {} });
const lazy = (p) => new Proxy(function () {}, { apply: () => Promise.resolve(undefined), get: (_t, k) => (k === "then" ? undefined : lazy(`${p}.${String(k)}`)) });
const defined = {
  storage: { local: {
    get: async (keys) => { const l = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of l) if (k in store) o[k] = store[k]; return o; },
    set: async (o) => Object.assign(store, o) }, onChanged: reg("storage.onChanged") },
  tabs: { query: async () => [{ id: 1, url: "https://example.com/p", title: "Example" }], onActivated: reg("tabs.onActivated"), onUpdated: reg("tabs.onUpdated") },
  webNavigation: { onCommitted: reg("w"), onHistoryStateUpdated: reg("h") },
  scripting: { executeScript: async () => [{ result: { url: "https://example.com/p", title: "Example", text: "PAGE TEXT", truncated: false } }] },
  runtime: { onConnect: reg("runtime.onConnect"), onMessage: reg("runtime.onMessage"), onInstalled: reg("runtime.onInstalled"), sendMessage: async () => ({}), getURL: (p) => `chrome-extension://x/${p}` },
  sidePanel: { setPanelBehavior: async () => undefined },
  debugger: { attach: async () => {}, sendCommand: async () => ({}), detach: async () => {}, onEvent: reg("debugger.onEvent") },
  cookies: { get: async () => null },
};
function wrap(o, p) { return new Proxy(o, { get(t, k) { if (typeof k === "symbol") return t[k];
  if (k in t) { const v = t[k]; return v !== null && typeof v === "object" ? wrap(v, `${p}.${String(k)}`) : v; }
  return lazy(`${p}.${String(k)}`); } }); }
globalThis.chrome = wrap(defined, "chrome");
class FakeWS { static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(d) { frames.push(d); } close() { this.readyState = 3; } }
globalThis.WebSocket = FakeWS;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

await import(URL_);
await tick(120);
const sock = sockets[0];
const parsed = () => frames.map((f) => { try { return JSON.parse(f); } catch { return null; } });

console.log("开关状态：storage 里没有 insight_autopush（= 推送已关）");
// 模拟宿主发来的 tool action
sock.onmessage({ data: JSON.stringify({ type: "action", id: 7, action: "get_page", params: {} }) });
await tick(200);
const res = parsed().find((m) => m?.type === "result" && m.id === 7);
let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };

check("browser_get_page 仍返回结果", res !== undefined && res.ok === true, JSON.stringify(res));
check("返回的正是页面正文", res?.result?.text === "PAGE TEXT", JSON.stringify(res?.result));
check("期间没有任何自动页面帧", parsed().filter((m) => m?.type === "page").length === 0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
