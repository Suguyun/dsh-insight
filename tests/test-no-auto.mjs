// 「划词不自动解读」的回归测试。
//
// 代价模型：一次解读 = 一次模型调用。自动解读意味着每选一段文字就烧一次 token，
// 而选词是读网页时最频繁的动作。所以只有**点浮标**才会发请求；旧版的
// insight_mode = "auto" / "auto-sidebar" 会残留在存储里，读到必须归一成对应的
// 手动模式 —— 否则老用户升级后仍在自动烧 token。
//
// 覆盖三条链路：
//   1. 启动时读到旧值 "auto"：划词只弹浮标，不发请求
//   2. 热更新到 "auto" / "auto-sidebar"：同样不自动发，点浮标才发
//   3. 诊断记录里不再出现 auto 事件，点击记成 click

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

// 起始状态就是旧值：验证「启动时读到 auto」这条路径。
const store = { insight_mode: "auto" };
const env = { appended: [], sent: [], listeners: {}, selection: null, onChanged: [] };
globalThis.document = {
  title: "T",
  visibilityState: "visible",
  documentElement: {
    appendChild: (el) => {
      env.appended.push(el);
      el.parentNode = { removeChild: () => { const i = env.appended.indexOf(el); if (i >= 0) env.appended.splice(i, 1); } };
    },
  },
  createElement: (t) => new El(t),
  addEventListener: (t, h) => { (env.listeners[t] ||= []).push(h); },
};
const win = {
  innerWidth: 1200,
  innerHeight: 800,
  setTimeout: (f, m) => setTimeout(f, m),
  clearTimeout: (i) => clearTimeout(i),
  matchMedia: () => ({ matches: false }),
  getSelection: () => env.selection,
};
win.top = win;
globalThis.window = win;
globalThis.location = { href: "https://example.com/p" };

globalThis.chrome = {
  runtime: {
    id: "abc",
    onMessage: { addListener() {} },
    sendMessage: async (m) => {
      if (m?.type === "panel-state-query") return { open: true };
      env.sent.push(m);
      return { ok: true, text: `解读:${String(m.text)}` };
    },
  },
  storage: {
    local: {
      get: async (k) => { const l = Array.isArray(k) ? k : [k]; const o = {}; for (const x of l) if (x in store) o[x] = store[x]; return o; },
      set: async (o) => Object.assign(store, o),
    },
    onChanged: { addListener: (fn) => env.onChanged.push(fn) },
  },
};

const fire = (t, ev = {}) => { for (const h of env.listeners[t] || []) h(ev); };
const select = (text) => {
  env.selection = {
    isCollapsed: false,
    toString: () => text,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20 }) }),
  };
};
const clickBadge = (badge) => badge.fire("click", { preventDefault() {}, stopPropagation() {} });
const allText = (el) => `${el.textContent || ""}${el.children.map(allText).join("")}`;
const traces = (event) => (Array.isArray(store.content_last) ? store.content_last : []).filter((e) => e.event === event);
async function setMode(value) {
  store.insight_mode = value;
  for (const fn of env.onChanged) fn({ insight_mode: { newValue: value } }, "local");
  await tick(40);
}
/** 清场：折叠选区、点空白关掉浮标与卡片，并清空本场景的计数器。 */
async function reset() {
  env.selection = { isCollapsed: true, toString: () => "", getRangeAt: () => { throw new Error("collapsed"); } };
  fire("mousedown", { target: {} });
  await tick(40);
  env.appended.length = 0;
  env.sent.length = 0;
}

await import(URL_);
await tick(60);

let pass = 0;
let fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };

console.log("1) 存储里是旧值 auto：启动读取必须归一成手动，划词不发请求");
await reset();
select("text-A");
fire("mouseup");
await tick(600);
check("划词没有发请求", env.sent.length === 0, JSON.stringify(env.sent));
check("只弹了浮标（一个元素）", env.appended.length === 1, String(env.appended.length));
check("浮标文字是默认的「解读」", allText(env.appended[0]) === "解读", allText(env.appended[0]));

console.log("2) 反复变动选区（selectionchange）仍然一次都不发");
env.selection = { isCollapsed: false, toString: () => "text-A2", getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 120, right: 320, top: 210, bottom: 230, width: 200, height: 20 }) }) };
fire("selectionchange");
await tick(500);
env.selection = { isCollapsed: false, toString: () => "text-A3", getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 120, right: 320, top: 210, bottom: 230, width: 200, height: 20 }) }) };
fire("keyup", { key: "ArrowRight" });
await tick(500);
check("仍然没有请求", env.sent.length === 0, JSON.stringify(env.sent));
check("浮标还只有一个（没有堆叠）", env.appended.length === 1, String(env.appended.length));

console.log("3) 点浮标：恰好一次请求，结果来自点击那一刻的选区");
clickBadge(env.appended[0]);
await tick(120);
check("点一次只发一次", env.sent.length === 1, JSON.stringify(env.sent.map((m) => m.text)));
check("请求带的是最新选区", env.sent[0]?.text === "text-A3", env.sent[0]?.text);
check("请求目标是 page", env.sent[0]?.target === "page", env.sent[0]?.target);
check("卡片显示了解读结果", allText(env.appended[0]).includes("解读:text-A3"), allText(env.appended[0]));

console.log("4) 热更新回旧值 auto-sidebar：只进侧栏 + 手动");
await reset();
await setMode("auto-sidebar");
select("sidebar text");
fire("mouseup");
await tick(600);
check("划词没有自动发请求", env.sent.length === 0, JSON.stringify(env.sent));
check("弹了浮标（它仍然是触发器）", env.appended.length === 1, String(env.appended.length));
clickBadge(env.appended[0]);
await tick(120);
check("点浮标后发了一次", env.sent.length === 1, JSON.stringify(env.sent));
check("目标是 sidebar", env.sent[0]?.target === "sidebar", env.sent[0]?.target);
check("只进侧栏：页面不弹结果卡片", env.appended.length === 0, String(env.appended.length));

console.log("5) 再切回旧值 auto：仍然手动（页面浮窗）");
await reset();
await setMode("auto");
select("page text");
fire("mouseup");
await tick(600);
check("不自动发请求", env.sent.length === 0, JSON.stringify(env.sent));
clickBadge(env.appended[0]);
await tick(120);
check("点击后才发，且目标为 page", env.sent.length === 1 && env.sent[0]?.target === "page", JSON.stringify(env.sent.map((m) => m.target)));

console.log("6) 诊断：不再有 auto 事件，点击记成 click");
check("没有 auto 轨迹", traces("auto").length === 0, JSON.stringify(traces("auto")));
check("有 click 轨迹", traces("click").length === 3, JSON.stringify(traces("click").map((e) => e.event)));
check("click 轨迹带耗时", typeof traces("click")[0]?.ms === "number", JSON.stringify(traces("click")[0]?.ms));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
