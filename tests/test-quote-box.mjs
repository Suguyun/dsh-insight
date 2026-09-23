// 选区原文的「折叠 / 就地编辑 / 改完重新解读」回归测试。
//
// 两个诉求来自实际使用：
//   1. 划词常常选得不精确 —— 希望能改一下文字，再用改过的内容重新解读；
//   2. 选区可能很长 —— 一条记录不该占满整屏，默认折叠、可展开。
//
// 这里锁住：折叠阈值、展开/收起、编辑态切换、只有真改过才允许重新解读、
// 以及重新解读发出去的请求带的是**改过的文字**。

// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/sidepanel.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", (e) => console.log("UNHANDLED:", String(e)));

class Node {}
class TextNode extends Node { constructor(t) { super(); this.text = String(t); } }
class El extends Node {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.children = []; this.handlers = {};
    this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ""; this._text = ""; this.className = ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...cs) { for (const c of cs) if (c != null) this.children.push(c); }
  replaceChildren(...cs) { this.children = []; this.append(...cs); }
  appendChild(c) { this.append(c); }
  remove() {}
  focus() {}
  scrollIntoView() {}
  addEventListener(t, h) { (this.handlers[t] ||= []).push(h); }
  fire(t, ev = {}) { for (const h of this.handlers[t] || []) h({ preventDefault() {}, stopPropagation() {}, ...ev }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text; }
}
globalThis.Node = Node;
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
globalThis.document = {
  getElementById: (id) => el(id),
  createElement: (t) => new El(t),
  createTextNode: (t) => new TextNode(t),
  documentElement: { style: { setProperty() {} } },
};

const store = {};
const sent = [];
const portHandlers = {};
globalThis.window = {
  location: { search: "" },
  setTimeout: (f, m) => setTimeout(f, m),
  setInterval: (f, m) => setInterval(f, m),
  clearInterval: (i) => clearInterval(i),
  clearTimeout: (i) => clearTimeout(i),
};
globalThis.chrome = {
  runtime: {
    connect: () => {
      const p = {
        onMessage: { addListener: (fn) => { portHandlers.message = fn; } },
        onDisconnect: { addListener: (fn) => { portHandlers.disconnect = fn; } },
        postMessage() {},
      };
      return p;
    },
    sendMessage: async (m) => { sent.push(m); return { ok: true, text: "REPLY" }; },
  },
  storage: {
    local: {
      get: async (keys) => { const l = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of l) if (k in store) o[k] = store[k]; return o; },
      set: async (o) => { Object.assign(store, o); },
    },
    onChanged: { addListener() {} },
  },
};

await import(URL_);
await tick(30);

let pass = 0;
const fails = [];
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n} ${extra}`); } };

const quote = el("quote");
const toggle = el("quoteToggle");
const editBtn = el("quoteEdit");
const input = el("quoteInput");
const actions = el("quoteActions");
const reBtn = el("quoteReinterpret");
const cancelBtn = el("quoteCancel");
const countEl = el("quoteCount");

/** 渲染一条记录（走 sidepanel.js 里真正的 renderRecord 路径）。 */
async function showRecord(text, extra = {}) {
  portHandlers.message({
    type: "insight",
    record: {
      at: new Date().toISOString(),
      url: "https://example.com/p",
      title: "T",
      text,
      ok: true,
      answer: "**答**",
      error: "",
      ms: 12,
      ...extra,
    },
  });
  await tick(40);
}

const LONG = "字".repeat(400);
const SHORT = "短文本";
const MEDIUM = "字".repeat(161); // 刚过阈值

// ---------------------------------------------------------------- 场景
console.log("1) 长选区：默认折叠，并给出「展开」");
await showRecord(LONG);
check("长文本被折叠", quote.dataset.clamped === "1", JSON.stringify(quote.dataset));
check("出现「展开」按钮", toggle.hidden === false && toggle.textContent === "展开", `${toggle.hidden}/${toggle.textContent}`);
check("显示字数", countEl.textContent === "400 字", countEl.textContent);

console.log("2) 展开 / 收起可来回切换");
toggle.fire("click");
check("展开后取消折叠", quote.dataset.clamped === "0", JSON.stringify(quote.dataset));
check("按钮文案变「收起」", toggle.textContent === "收起", toggle.textContent);
toggle.fire("click");
check("再点回到折叠", quote.dataset.clamped === "1", JSON.stringify(quote.dataset));

console.log("3) 短选区：不折叠、也不显示展开按钮");
await showRecord(SHORT);
check("短文本不折叠", quote.dataset.clamped === "0", JSON.stringify(quote.dataset));
check("不显示「展开」", toggle.hidden === true, String(toggle.hidden));
check("字数照常显示", countEl.textContent === "3 字", countEl.textContent);  // 「短文本」= 3 字

console.log("4) 刚好超过阈值就该折叠（边界）");
await showRecord(MEDIUM);
check("161 字折叠", quote.dataset.clamped === "1", JSON.stringify(quote.dataset));
await showRecord("字".repeat(160));
check("160 字不折叠", quote.dataset.clamped === "0", JSON.stringify(quote.dataset));

console.log("5) 编辑态：换成输入框，原文与展开按钮让位");
await showRecord(LONG);
editBtn.fire("click");
check("输入框显示", input.hidden === false, String(input.hidden));
check("原文隐藏", quote.hidden === true, String(quote.hidden));
check("操作区显示", actions.hidden === false, String(actions.hidden));
check("编辑时隐藏「编辑」按钮", editBtn.hidden === true, String(editBtn.hidden));
check("编辑时隐藏「展开」按钮", toggle.hidden === true, String(toggle.hidden));
check("输入框预填原文", input.value === LONG, String(input.value?.length));

console.log("6) 没改过就不允许重新解读（避免重复问同一个问题）");
check("按钮初始禁用", reBtn.disabled === true, String(reBtn.disabled));
input.value = LONG;
input.fire("input");
check("原样不动仍禁用", reBtn.disabled === true, String(reBtn.disabled));

console.log("7) 改过之后可以重新解读，请求带的是改过的文字");
const EDITED = "只解读这一句";
input.value = EDITED;
input.fire("input");
check("改动后按钮可用", reBtn.disabled === false, String(reBtn.disabled));
sent.length = 0;
reBtn.fire("click");
await tick(60);
const req = sent.find((m) => m?.type === "interpret");
check("发出了 interpret 请求", req !== undefined, JSON.stringify(sent));
check("带的是改过的文字，不是原文", req?.text === EDITED, String(req?.text));
check("带上了原记录的 url / title", req?.url === "https://example.com/p" && req?.title === "T", JSON.stringify(req));
check("target=sidebar（结果回本面板）", req?.target === "sidebar", String(req?.target));
check("提交后退出编辑态", input.hidden === true && actions.hidden === true, `${input.hidden}/${actions.hidden}`);

console.log("8) 取消编辑：不保留改动，也不发请求");
await showRecord(LONG);
editBtn.fire("click");
input.value = "改了但不提交";
input.fire("input");
sent.length = 0;
cancelBtn.fire("click");
await tick(30);
check("退出编辑态", input.hidden === true, String(input.hidden));
check("没有发出请求", sent.filter((m) => m?.type === "interpret").length === 0, JSON.stringify(sent));
check("原文照旧显示", quote.hidden === false && quote.textContent === LONG, String(quote.textContent?.length));

console.log("9) 换新记录时，折叠与编辑状态归零");
toggle.fire("click"); // 先展开上一条
check("上一条已展开", quote.dataset.clamped === "0", JSON.stringify(quote.dataset));
editBtn.fire("click");
await showRecord(LONG);
check("新记录回到折叠态", quote.dataset.clamped === "1", JSON.stringify(quote.dataset));
check("新记录不在编辑态", input.hidden === true && quote.hidden === false, `${input.hidden}/${quote.hidden}`);

console.log("10) 编辑时字数实时更新；清空则禁用按钮");
await showRecord(LONG);
editBtn.fire("click");
check("进入编辑时字数=原文长度", countEl.textContent === "400 字", countEl.textContent);
input.value = "短";
input.fire("input");
check("改短后字数跟着变", countEl.textContent === "1 字", countEl.textContent);
input.value = "   ";
input.fire("input");
check("清空（纯空白）后按钮禁用", reBtn.disabled === true, String(reBtn.disabled));

console.log("11) 空白提交不触发请求");
await showRecord(LONG);
editBtn.fire("click");
input.value = "   ";
input.fire("input");
sent.length = 0;
reBtn.fire("click");
await tick(30);
check("纯空白不发请求", sent.filter((m) => m?.type === "interpret").length === 0, JSON.stringify(sent));

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) process.exit(1);
