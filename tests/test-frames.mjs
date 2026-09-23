// iframe（子帧）划词的回归测试。
//
// 背景：内容脚本原先第一行就是 `if (window.top !== window) return;`，只在顶层帧运行。
// 于是**正文嵌在 iframe 里的页面**（微前端 / 后台系统大量如此）划词完全没反应 ——
// 选中高亮正常，但顶层 document 既收不到 mouseup/selectionchange，
// window.getSelection() 也是空的，所以看起来就是「扩展死了」。
//
// 这里锁住三件事：
//   1. manifest 声明了在所有帧注入（all_frames）；
//   2. 在子帧里脚本确实**初始化并工作**（能出浮标、能发请求）；
//   3. 孤儿横幅只在顶层帧弹一次，不会每个帧各弹一条。

// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n} ${extra}`); } };

// ---------- 1) manifest：必须在所有帧注入 ----------
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "extension", "manifest.json"), "utf8"));
const cs = manifest.content_scripts[0];
check("manifest 声明 all_frames（否则 iframe 里的正文永远划不动）", cs.all_frames === true, String(cs.all_frames));
check("manifest 声明 match_about_blank（覆盖 srcdoc / about:blank 帧）", cs.match_about_blank === true, String(cs.match_about_blank));
check("内容脚本仍然只匹配 http(s)", Array.isArray(cs.matches) && cs.matches.every((m) => m.startsWith("http")), JSON.stringify(cs.matches));

// ---------- 2) 在子帧里加载脚本，验证它真的干活 ----------
// 关键：window.top 必须是与 window 不同的对象，才算「非顶层帧」。
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
  title: "子帧标题",
  referrer: "https://shell.example.com/dashboard",
  documentElement: { appendChild: (el) => { env.appended.push(el); el.parentNode = { removeChild: () => { const i = env.appended.indexOf(el); if (i >= 0) env.appended.splice(i, 1); } }; } },
  createElement: (t) => new El(t),
  addEventListener: (t, h) => { (env.listeners[t] ||= []).push(h); },
};
const win = {
  innerWidth: 900, innerHeight: 600,
  setTimeout: (f, m) => setTimeout(f, m), clearTimeout: (i) => clearTimeout(i),
  matchMedia: () => ({ matches: false }), getSelection: () => env.selection,
};
// 非顶层帧：top 是另一个对象，且读它的 location 会抛（跨域）。
win.top = { crossOriginShell: true };
globalThis.window = win;
globalThis.location = { href: "https://panel.example.com/widget" };

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

const allText = (el) => (el.textContent || "") + el.children.map(allText).join("");
const select = (text) => {
  env.selection = {
    isCollapsed: false, toString: () => text,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20 }) }),
  };
};

check("子帧里脚本完成了初始化（没有在开头提前 return）", env.listeners["mouseup"] !== undefined && env.listeners["mouseup"].length > 0);

// 默认模式（click）：选中后应出现浮标 —— 这是原先在子帧里绝不会发生的事
select("子帧里选中的文字"); env.fire("mouseup", {});
await tick(400);
check("子帧里选中后出现浮标", env.appended.length === 1, String(env.appended.length));

if (env.appended[0]) {
  env.appended[0].fire("click", { preventDefault() {}, stopPropagation() {} });
  await tick(80);
  check("子帧里点浮标会发出解读请求", env.sent.length === 1, String(env.sent.length));
  const req = env.sent[0] || {};
  check("请求带上了选区文字", req.text === "子帧里选中的文字", String(req.text));
  check(
    "跨域子帧上报的是内嵌页地址（document.referrer），不是帧自己的 URL",
    req.url === "https://shell.example.com/dashboard",
    String(req.url),
  );
}

// ---------- 3) 孤儿横幅只能在顶层帧弹 ----------
// 模拟「扩展更新后本页脚本已成孤儿」：runtime.id 变 undefined。
chrome.runtime.id = undefined;
env.appended.length = 0; env.sent.length = 0;
select("孤儿帧里选中"); env.fire("mouseup", {});
await tick(400);
const noticeLike = env.appended.filter((el) => allText(el).includes("已更新"));
check("子帧里不弹孤儿横幅（否则 N 个帧会弹 N 条）", noticeLike.length === 0, String(noticeLike.length));

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) process.exit(1);
