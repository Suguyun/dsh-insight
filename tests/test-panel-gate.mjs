// 侧栏开合闸门的回归测试。
//
// 行为约定：「结果只进侧栏」的两种模式（click-sidebar / auto-sidebar）在侧栏**未展开**
// 时，不发请求、也不弹浮标 —— 结果没有任何地方能显示，白跑一次模型没有意义。
// 两种「页面浮窗」模式（click / auto）不受影响：它们的结果画在页面上，本就不需要侧栏。
//
// 内容脚本看不到侧栏，状态由 background 告知：启动时问一次（panel-state-query），
// 之后靠推送（panel-state）。这里把两条链路都模拟出来。

// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/selection.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

class El {
  constructor(t) { this.tag = t; this.style = {}; this.children = []; this.handlers = {}; this.textContent = ""; this.parentNode = null; }
  setAttribute() {}
  appendChild(c) { this.children.push(c); c.parentNode = this; }
  addEventListener(t, h) { (this.handlers[t] ||= []).push(h); }
  fire(t, ev = {}) { for (const h of this.handlers[t] || []) h(ev); }
}
globalThis.Element = class {};

const store = {};
const env = { appended: [], sent: [], listeners: {}, selection: null, onChanged: [], panelListeners: [] };

// 侧栏状态：导入 selection.js 之前先设为「未展开」，模拟「侧栏关着时打开网页」。
let panelOpen = false;

globalThis.document = {
  title: "T",
  documentElement: { appendChild: (el) => { env.appended.push(el); el.parentNode = { removeChild: () => { const i = env.appended.indexOf(el); if (i >= 0) env.appended.splice(i, 1); } }; } },
  createElement: (t) => new El(t),
  addEventListener: (t, h) => { (env.listeners[t] ||= []).push(h); },
};
const win = {
  innerWidth: 1200, innerHeight: 800,
  setTimeout: (f, m) => setTimeout(f, m), clearTimeout: (i) => clearTimeout(i),
  matchMedia: () => ({ matches: false }), getSelection: () => env.selection,
};
win.top = win;
globalThis.window = win;
globalThis.location = { href: "https://example.com/p" };

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => { const l = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of l) if (k in store) o[k] = store[k]; return o; },
      set: async (o) => Object.assign(store, o),
    },
    onChanged: { addListener: (fn) => env.onChanged.push(fn) },
  },
  runtime: {
    id: "test-ext",
    onMessage: { addListener: (fn) => env.panelListeners.push(fn) },
    sendMessage: async (m) => {
      // 启动时的侧栏状态查询：只回状态，不进 env.sent（它不是解读请求）。
      if (m?.type === "panel-state-query") return { open: panelOpen };
      env.sent.push(m);
      return { ok: true, text: "ANSWER" };
    },
  },
};
env.fire = (t, ev) => { for (const h of env.listeners[t] || []) h(ev); };

await import(URL_);
await tick(40); // 让启动时那次 panel-state-query 落地

let pass = 0;
const fails = [];
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n} ${extra}`); } };
const allText = (el) => (el.textContent || "") + el.children.map(allText).join("");
const select = (text) => {
  env.selection = {
    isCollapsed: false, toString: () => text,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20 }) }),
  };
};

async function setMode(patch) {
  Object.assign(store, patch);
  const changes = {}; for (const k of Object.keys(patch)) changes[k] = { newValue: patch[k] };
  for (const fn of env.onChanged) fn(changes, "local");
  await tick(40);
}
/** 模拟 background 推送侧栏开合变化。 */
async function pushPanel(open) {
  panelOpen = open;
  for (const fn of env.panelListeners) fn({ type: "panel-state", open });
  await tick(20);
}
async function reset() {
  env.selection = { isCollapsed: true, toString: () => "", getRangeAt: () => { throw new Error("collapsed"); } };
  env.fire("mousedown", { target: {} });
  await tick(30);
  env.appended.length = 0; env.sent.length = 0;
}
const interprets = () => env.sent.filter((m) => m?.type === "interpret");

// 0) 启动时的状态查询确实被问过（否则 panelOpen 会一直是默认的 true，闸门形同虚设）
check("启动时订阅了侧栏状态推送", env.panelListeners.length === 1, String(env.panelListeners.length));

// 1) auto-sidebar + 侧栏未展开 → 不发请求、页面无元素
await reset(); await setMode({ insight_mode: "auto-sidebar" });
select("closed sidebar"); env.fire("mouseup", {});
await tick(700);
check("auto-sidebar + 侧栏关：不发请求", interprets().length === 0, String(interprets().length));
check("auto-sidebar + 侧栏关：页面无元素", env.appended.length === 0, String(env.appended.length));
await tick(60);
const traced = Array.isArray(store.content_last) ? store.content_last.filter((e) => e.event === "skip-sidebar-closed") : [];
check("auto-sidebar + 侧栏关：记下了一次跳过（便于排查「划词没反应」）", traced.length === 1, JSON.stringify(traced));

// 2) 同一模式下再划一次：仍然不请求，且跳过不会反复写存储
select("closed again"); env.fire("mouseup", {});
await tick(700);
const traced2 = Array.isArray(store.content_last) ? store.content_last.filter((e) => e.event === "skip-sidebar-closed") : [];
check("反复划词仍不发请求", interprets().length === 0, String(interprets().length));
check("跳过只记一次，不刷存储", traced2.length === 1, String(traced2.length));

// 3) 侧栏打开后 → 恢复正常解读
await pushPanel(true);
select("now open"); env.fire("mouseup", {});
await tick(700);
check("侧栏打开后：正常发请求", interprets().length === 1, String(interprets().length));
check("侧栏打开后：请求带 target=sidebar", interprets()[0]?.target === "sidebar", String(interprets()[0]?.target));

// 4) 侧栏再次关掉 → auto-sidebar 立刻回到「不解读」
await reset(); await pushPanel(false);
select("closed again 2"); env.fire("mouseup", {});
await tick(700);
check("侧栏又关掉：立即回到不解读", interprets().length === 0, String(interprets().length));

// 5) click-sidebar + 侧栏未展开 → 连浮标都不弹（弹了也只会点了没反应）
await reset(); await setMode({ insight_mode: "click-sidebar" });
select("badge should not appear"); env.fire("mouseup", {});
await tick(400);
check("click-sidebar + 侧栏关：不弹浮标", env.appended.length === 0, String(env.appended.length));
check("click-sidebar + 侧栏关：不发请求", interprets().length === 0, String(interprets().length));

// 6) 页面浮窗模式不受影响 —— 它们的结果画在页面上，本就不需要侧栏
await reset(); await setMode({ insight_mode: "click" });
select("page card mode"); env.fire("mouseup", {});
await tick(400);
check("click（页面浮窗）+ 侧栏关：浮标照常出现", env.appended.length === 1, String(env.appended.length));
env.appended[0].fire("click", { preventDefault() {}, stopPropagation() {} });
await tick(80);
check("click（页面浮窗）+ 侧栏关：点了照常解读", interprets().length === 1, String(interprets().length));
check("click（页面浮窗）+ 侧栏关：请求带 target=page", interprets()[0]?.target === "page", String(interprets()[0]?.target));

await reset(); await setMode({ insight_mode: "auto" });
select("auto page card"); env.fire("mouseup", {});
await tick(700);
check("auto（页面浮窗）+ 侧栏关：照常自动解读", interprets().length === 1, String(interprets().length));

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) process.exit(1);
