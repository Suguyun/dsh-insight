// 「侧栏没开时不要弹『已更新，请刷新本页』」的回归测试。
//
// 背景：扩展重载后，已打开页面里的内容脚本会变成孤儿，划词不再工作。原先一律弹一条
// 横幅告诉用户「刷新本页」。但在**结果只进侧栏**的模式下、侧栏又是关闭的，本来就
// 不会有任何反应（见 panel-gate），再弹一条横幅纯属噪声 —— 而且违背了
// 「只进侧栏」模式下页面保持干净的约定。
//
// 页面浮窗模式（click / auto）不受这条限制：那种模式本来就会在页面上出东西，
// 缺了它需要解释。那条路径由 test-orphan-notice.mjs 覆盖。

// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/selection.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", () => {});

class El {
  constructor(t) { this.tag = t; this.style = {}; this.children = []; this.handlers = {}; this.attrs = {}; this.textContent = ""; this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(c) { this.children.push(c); c.parentNode = this; }
  addEventListener(t, h) { (this.handlers[t] ||= []).push(h); }
  fire(t, ev = {}) { for (const h of this.handlers[t] || []) h(ev); }
}
globalThis.Element = class {};

// 起始状态：只进侧栏 + 侧栏关闭 —— 正是用户报的那一组
const store = { insight_mode: "auto-sidebar" };
// appended 会随横幅自动消失被移除；everAppended 只增不减，用来断言「曾经出现过」。
const env = { appended: [], everAppended: [], sent: [], listeners: {}, selection: null, panelListeners: [], changeListeners: [] };
globalThis.document = {
  title: "T", visibilityState: "visible",
  documentElement: { appendChild: (el) => { env.appended.push(el); env.everAppended.push(el); el.parentNode = { removeChild: () => { const i = env.appended.indexOf(el); if (i >= 0) env.appended.splice(i, 1); } }; } },
  createElement: (t) => new El(t),
  addEventListener: (t, h) => { (env.listeners[t] ||= []).push(h); },
};
// 横幅是「8 秒后自动消失」的模块内部状态，一个进程里只能验一次「弹出」。
// 这里只把**长延时**（>=8s 的那条自动消失计时器）压短，防抖用的 220/450ms 原样不动。
const setT = (f, m) => setTimeout(f, m >= 8000 ? 40 : m);
const win = {
  innerWidth: 1200, innerHeight: 800,
  setTimeout: setT, clearTimeout: (i) => clearTimeout(i),
  matchMedia: () => ({ matches: false }), getSelection: () => env.selection,
};
win.top = win;
globalThis.window = win;
globalThis.location = { href: "https://example.com/p" };

let panelOpen = false; // 侧栏关闭
globalThis.chrome = {
  runtime: {
    id: "abcdef",
    onMessage: { addListener: (fn) => env.panelListeners.push(fn) },
    sendMessage: async (m) => {
      if (m?.type === "panel-state-query") return { open: panelOpen };
      env.sent.push(m);
      return { ok: true, text: "ANSWER" };
    },
  },
  storage: {
    local: {
      get: async (k) => { const l = Array.isArray(k) ? k : [k]; const o = {}; for (const x of l) if (x in store) o[x] = store[x]; return o; },
      set: async (o) => Object.assign(store, o),
    },
    onChanged: { addListener: (fn) => env.changeListeners.push(fn) },
  },
};

const fire = (t, ev = {}) => { for (const h of env.listeners[t] || []) h(ev); };
const select = (text) => {
  env.selection = {
    isCollapsed: false, toString: () => text,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20 }) }),
  };
};
// 用 everAppended：横幅 8 秒（测试里被压短）后会自动移除，只看到场会漏判。
const notice = () => env.everAppended.find((el) => (el.textContent || "").includes("刷新本页"));
async function pushPanel(open) {
  panelOpen = open;
  for (const fn of env.panelListeners) fn({ type: "panel-state", open });
  await tick(20);
}
async function setMode(mode) {
  store.insight_mode = mode;
  for (const fn of env.changeListeners) fn({ insight_mode: { newValue: mode } }, "local");
  await tick(30);
}
async function clear() {
  env.selection = { isCollapsed: true, toString: () => "", getRangeAt: () => { throw new Error("collapsed"); } };
  fire("mousedown", { target: {} });
  await tick(30);
  env.appended.length = 0;
  env.everAppended.length = 0;
  env.sent.length = 0;
}

await import(URL_);
await tick(60);

let pass = 0;
const fails = [];
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n} ${extra}`); } };

// 从这里开始模拟「扩展重载后本页脚本失效」
chrome.runtime.id = undefined;

console.log("1) 只进侧栏 + 侧栏关闭：划词不该弹任何提示");
await clear();
select("orphan but quiet"); fire("mouseup");
await tick(700);
check("页面上没有任何提示", notice() === undefined, notice()?.textContent);
check("也没有发请求", env.sent.length === 0, String(env.sent.length));

console.log("2) 重复划词仍然安静");
await clear();
select("again"); fire("selectionchange");
await tick(700);
check("依旧没有提示", notice() === undefined, notice()?.textContent);

console.log("3) 切回该标签页（visibilitychange）也不该主动弹提示");
await clear();
fire("visibilitychange", {});
await tick(120);
check("主动提示同样不出现", notice() === undefined, notice()?.textContent);

console.log("4) 侧栏打开后：要提示（用户在等结果，得说清为什么没有）");
await pushPanel(true);
await clear();
select("now panel open"); fire("mouseup");
await tick(700);
check("出现了刷新提示", notice() !== undefined, "应当提示");
check("提示文案说清了原因", (notice()?.textContent || "").includes("dsh-insight 已更新"), notice()?.textContent);
check("提示带 data-dsh-insight", notice()?.attrs?.["data-dsh-insight"] === "", String(notice()?.attrs?.["data-dsh-insight"]));

// 横幅 40ms 后自动消失（见上面的 setT），等它走完再验下一个「应当提示」的场景
await tick(80);

console.log("5) 页面浮窗模式 + 侧栏关闭：仍然要提示（那种模式本该在页面上出东西）");
await pushPanel(false);
await setMode("auto");
await clear();
select("page card mode"); fire("mouseup");
await tick(700);
check("页面浮窗模式仍会提示", notice() !== undefined, "应当提示");
await tick(80);

console.log("6) 只进侧栏的手动模式 + 侧栏打开：同样要提示");
await setMode("click-sidebar");
await pushPanel(true);
await clear();
select("click-sidebar open"); fire("mouseup");
await tick(500);
check("仍然提示", notice() !== undefined, "应当提示");

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) process.exit(1);
