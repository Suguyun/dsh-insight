// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/sidepanel.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", (e) => console.log("UNHANDLED:", String(e)));

// ---- 够用的小 DOM（要支持 md.js 的 createElement/append/replaceChildren）----
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
globalThis.window = { location: { search: "" }, setTimeout: (f, m) => setTimeout(f, m), setInterval: (f, m) => setInterval(f, m), clearInterval: (i) => clearInterval(i) };
globalThis.chrome = {
  runtime: {
    connect: () => {
      const p = { onMessage: { addListener: (fn) => { portHandlers.msg = fn; } }, onDisconnect: { addListener() {} }, postMessage() {} };
      return p;
    },
    sendMessage: async (m) => { sent.push(m); return { ok: true, text: "**追问的回答**" }; },
  },
  storage: {
    local: {
      get: async (keys) => { const l = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of l) if (k in store) o[k] = store[k]; return o; },
      set: async (o) => Object.assign(store, o),
    },
    onChanged: { addListener() {} },
  },
};

await import(URL_);
await tick(60);

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };
const text = (node) => (node instanceof TextNode ? node.text : (node._text || "") + (node.children || []).map(text).join(""));

const record = { at: "2026-09-23T08:00:00.000Z", url: "https://e.com/p", title: "T", text: "被选中的原文", ok: true, answer: "**首次解读**", error: "", ms: 100 };
console.log("0) 正在解读指示");
portHandlers.msg({ type: "insight-pending", url: "https://e.com/p", title: "T" });
check("指示条出现", el("pending").hidden === false);
check("面板标记为忙（旧记录会被压暗）", el("insight").dataset.busy === "1");
check("初始文案", el("pendingText").textContent === "正在解读…", el("pendingText").textContent);
await tick(1150);
check("等待秒数会走动", /已 \d+ 秒/.test(el("pendingText").textContent), el("pendingText").textContent);

portHandlers.msg({ type: "insight", record });
await tick(60);

console.log("1) 记录到达后的状态");

check("结果到达后指示条收起", el("pending").hidden === true);
check("忙标记清除", el("insight").dataset.busy === "");
check("结果到达后指示条收起", el("pending").hidden === true);
check("忙标记清除", el("insight").dataset.busy === "");
check("追问表单可见", el("askForm").hidden === false);
check("线程区为空且隐藏", el("thread").hidden === true);
// 这三条是回归补丁：之前只验线程/表单，漏了记录区显隐，导致「解读不显示」溜过去。
check("记录区已展开", el("record").hidden === false, `record.hidden=${el("record").hidden}`);
check("占位提示已收起", el("empty").hidden === true, `empty.hidden=${el("empty").hidden}`);

console.log("2) 追问一次");
el("ask").value = "为什么这么说？";
el("askForm").fire("submit");
await tick(80);

check("发出了 discuss 消息", sent.length === 1 && sent[0].type === "discuss", JSON.stringify(sent[0]?.type));
check("history 形状 = [assistant(首次解读), user(本次追问)]",
  JSON.stringify(sent[0].history) === JSON.stringify([
    { role: "assistant", text: "**首次解读**" },
    { role: "user", text: "为什么这么说？" },
  ]), JSON.stringify(sent[0].history));
check("带上了选区与页面信息", sent[0].text === "被选中的原文" && sent[0].url === "https://e.com/p");
const threadText = text(el("thread"));
check("线程里能看到我的问题", threadText.includes("为什么这么说？"), threadText.slice(0, 120));
check("线程里能看到回答", threadText.includes("追问的回答"), threadText.slice(0, 120));
check("追问后重新可用", el("ask").disabled === false && el("askSend").disabled === false);
check("输入框已清空", el("ask").value === "");

console.log("3) 持久化");
check("写了 insight_thread", store.insight_thread !== undefined, JSON.stringify(store.insight_thread));
check("键绑定到当前记录", (store.insight_thread?.key ?? "").startsWith(record.at), store.insight_thread?.key);
check("存了 2 轮往返", store.insight_thread?.turns?.length === 2, JSON.stringify(store.insight_thread?.turns?.length));

console.log("4) 再追问一次，history 应累积");
el("ask").value = "举个例子";
el("askForm").fire("submit");
await tick(80);
check("第二次 history 有 4 条", sent[1].history.length === 4, JSON.stringify(sent[1].history.map((t) => t.role)));
check("顺序正确", sent[1].history.map((t) => t.role).join(",") === "assistant,user,assistant,user", sent[1].history.map((t) => t.role).join(","));

console.log("4.5) 指示条可重复使用");
portHandlers.msg({ type: "insight-pending", url: "https://e.com/x", title: "T" });
check("再次出现", el("pending").hidden === false && el("insight").dataset.busy === "1");

console.log("5) 失败记录不开放讨论");
portHandlers.msg({ type: "insight", record: { at: "2026-09-23T08:05:00.000Z", url: "https://e.com/x", title: "T", text: "x", ok: false, answer: "", error: "服务不可用", ms: 5 } });
await tick(60);
check("失败结果也会收起指示条", el("pending").hidden === true && el("insight").dataset.busy === "");
check("表单隐藏", el("askForm").hidden === true);
check("线程清空", text(el("thread")) === "");
check("失败时记录区仍展开（要显示错误）", el("record").hidden === false);
check("失败时占位提示仍收起", el("empty").hidden === true);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
