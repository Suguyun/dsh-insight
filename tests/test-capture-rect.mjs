// 锚点矩形退化链的回归测试。
//
// 背景（实测自 Monaco 编辑器）：`range.getBoundingClientRect()` 会返回退化的矩形，
// 而且取值不稳定 —— 同一页面实测到过两种：
//
//   {width: 0, height: 0}    → 命中旧的 `width===0 && height===0` 判断，选区被**直接丢弃**，
//                              连浮标都不建。表现：选中了、扩展毫无反应。
//   {width: 0, height: NaN}  → NaN 躲过 `=== 0` 判断，但会顺着 `Math.max(8, …)` 传下去，
//                              把 left/top 写成 "NaNpx" —— 无效值被浏览器忽略，
//                              position:fixed 的浮标落在文档流末尾，用户看不见。
//
// 结论：几何信息坏掉**不算「没有选区」**，它只影响浮标摆在哪。任何写进 style 的值
// 都必须是有限的 px，绝不能出现 NaN。

// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
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
      if (m?.type === "panel-state-query") return { open: true };
      env.sent.push(m);
      return { ok: true, text: "ANSWER" };
    },
  },
};
env.fire = (t, ev) => { for (const h of env.listeners[t] || []) h(ev); };

await import(pathToFileURL(`${SRC_DIR}/selection.js`).href);
await tick(40);

let pass = 0;
const fails = [];
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n} ${extra}`); } };

// 几何来源，每个场景前改这三样
const GOOD = { left: 100, top: 200, right: 300, bottom: 220, width: 200, height: 20 };
const ZERO = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };        // 实测之一
const NAN1 = { left: NaN, top: NaN, right: NaN, bottom: NaN, width: 0, height: NaN }; // 实测之二
let rangeRect = GOOD;
let clientRects = [];
let elementRect = null;

function select(text) {
  env.selection = {
    isCollapsed: false, rangeCount: 1, toString: () => text,
    getRangeAt: () => ({
      getBoundingClientRect: () => rangeRect,
      getClientRects: () => clientRects,
      startContainer: elementRect === null ? undefined : { nodeType: 1, getBoundingClientRect: () => elementRect },
    }),
  };
}
async function reset() {
  env.selection = { isCollapsed: true, toString: () => "", getRangeAt: () => { throw new Error("collapsed"); } };
  env.fire("mousedown", { target: {} });
  await tick(30);
  env.appended.length = 0; env.sent.length = 0;
  rangeRect = GOOD; clientRects = []; elementRect = null;
}
/** 走一次「选中 + 松开鼠标」，返回浮标元素。 */
async function dragSelect(text, pointer) {
  select(text);
  env.fire("mouseup", pointer === undefined ? {} : { clientX: pointer.x, clientY: pointer.y });
  await tick(400);
  return env.appended[0];
}
/** 写进 style 的必须是 "NNNpx"，不得含 NaN。 */
const px = (v) => typeof v === "string" && /^-?\d+(\.\d+)?px$/.test(v);
const placed = (el) => px(el?.style?.left) && px(el?.style?.top);
const noNaN = (el) => !Object.values(el?.style ?? {}).some((v) => String(v).includes("NaN"));

// ---------------------------------------------------------------- 场景
console.log("1) 几何正常：直接用选区包围盒");
await reset();
let b = await dragSelect("normal");
check("浮标出现", b !== undefined);
check("left/top 是有限 px", placed(b), JSON.stringify(b?.style));
// estimated = 26 + 2*13 = 52；left = max(8, min(1200-52, 300-26)) = 274
check("按选区右边居中（274px）", String(b?.style?.left) === "274px", String(b?.style?.left));

console.log("2) 实测取值 {width:0,height:0}：绝不丢弃这次划词");
await reset();
rangeRect = ZERO; clientRects = []; elementRect = null;
b = await dragSelect("zero rect", { x: 500, y: 300 });
check("浮标仍然出现（旧代码在这里直接 return undefined）", b !== undefined, "选区被丢弃了");
check("left/top 是有限 px", placed(b), JSON.stringify(b?.style));
check("整份 style 不含 NaN", noNaN(b), JSON.stringify(b?.style));

console.log("3) 实测取值 {width:0,height:NaN}：不能生成 NaNpx");
await reset();
rangeRect = NAN1; clientRects = []; elementRect = null;
b = await dragSelect("nan rect", { x: 500, y: 300 });
check("浮标出现", b !== undefined);
check("left/top 是有限 px（不是 NaNpx）", placed(b), JSON.stringify(b?.style));
check("整份 style 不含 NaN", noNaN(b), JSON.stringify(b?.style));

console.log("4) 包围盒坏但分段矩形好：用分段矩形");
await reset();
rangeRect = ZERO; clientRects = [GOOD]; elementRect = null;
b = await dragSelect("clientRects fallback");
check("浮标出现", b !== undefined);
check("用的是分段矩形（274px）", String(b?.style?.left) === "274px", String(b?.style?.left));

console.log("5) 包围盒与分段矩形都坏：退回选区所在元素");
await reset();
rangeRect = ZERO; clientRects = [ZERO]; elementRect = GOOD;
b = await dragSelect("element fallback");
check("浮标出现", b !== undefined);
check("用的是元素矩形（274px）", String(b?.style?.left) === "274px", String(b?.style?.left));

console.log("6) 几何全坏但有鼠标位置：退回指针位置");
await reset();
rangeRect = ZERO; clientRects = [ZERO]; elementRect = null;
b = await dragSelect("pointer fallback", { x: 640, y: 360 });
check("浮标出现", b !== undefined);
// left = max(8, min(1148, 640 - 26)) = 614
check("落在指针附近（614px）而不是文档末尾", String(b?.style?.left) === "614px", String(b?.style?.left));

console.log("7) 几何全坏、也没有鼠标位置：退回视口定点");
await reset();
rangeRect = ZERO; clientRects = [ZERO]; elementRect = null;
b = await dragSelect("center fallback");
check("浮标出现（宁可位置不准也不丢划词）", b !== undefined);
check("left/top 是有限 px", placed(b), JSON.stringify(b?.style));

console.log("8) 坏几何不影响解读本身：点浮标照样发请求");
await reset();
rangeRect = ZERO; clientRects = [ZERO]; elementRect = null;
b = await dragSelect("click me", { x: 400, y: 250 });
b?.fire("click", { preventDefault() {}, stopPropagation() {} });
await tick(80);
const reqs = env.sent.filter((m) => m?.type === "interpret");
check("发出了 interpret 请求", reqs.length === 1, String(reqs.length));
check("请求带上了选区文字", reqs[0]?.text === "click me", String(reqs[0]?.text));

console.log("9) 真的没有选区时，不写 capture-miss 噪声");
await reset();
store.content_last = [];
env.fire("mouseup", {});
await tick(400);
const misses = (store.content_last || []).filter((e) => e.event === "capture-miss");
check("普通点击不记 capture-miss", misses.length === 0, JSON.stringify(misses));

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) process.exit(1);
