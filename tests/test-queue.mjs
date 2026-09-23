// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/selection.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", () => {});

class El { constructor(t){this.tag=t;this.style={};this.children=[];this.handlers={};this.attrs={};this.textContent="";this.parentNode=null;}
  setAttribute(k,v){this.attrs[k]=String(v);} appendChild(c){this.children.push(c);c.parentNode=this;}
  addEventListener(t,h){(this.handlers[t]||=[]).push(h);} fire(t,ev={}){for(const h of this.handlers[t]||[])h(ev);} }
globalThis.Element = class {};

const store = { insight_mode: "auto" };     // 划词即解读
const env = { appended: [], listeners: {}, selection: null };
globalThis.document = {
  title: "T", visibilityState: "visible",
  documentElement: { appendChild: (el) => { env.appended.push(el); el.parentNode = { removeChild(){} }; } },
  createElement: (t) => new El(t),
  addEventListener: (t, h) => { (env.listeners[t] ||= []).push(h); },
};
const win = { innerWidth: 1200, innerHeight: 800, setTimeout:(f,m)=>setTimeout(f,m), clearTimeout:(i)=>clearTimeout(i),
  matchMedia: () => ({ matches: false }), getSelection: () => env.selection };
win.top = win;
globalThis.window = win;
globalThis.location = { href: "https://example.com/p" };

// sendMessage 由测试控制何时返回 —— 用来制造「上一次还在跑」的窗口
const calls = [];
const resolvers = [];
globalThis.chrome = {
  runtime: { id: "abc", onMessage: { addListener() {} }, sendMessage: (m) => { if (m?.type === "panel-state-query") return Promise.resolve({ open: true }); calls.push(m.text); return new Promise((res) => resolvers.push(() => res({ ok: true, text: `解读:${m.text}` }))); } },
  storage: { local: { get: async (k)=>{const l=Array.isArray(k)?k:[k];const o={};for(const x of l)if(x in store)o[x]=store[x];return o;}, set: async(o)=>Object.assign(store,o) }, onChanged: { addListener(){} } },
};
const fire = (t) => { for (const h of env.listeners[t] || []) h({}); };
const select = (t) => { env.selection = { isCollapsed:false, toString:()=>t, getRangeAt:()=>({ getBoundingClientRect:()=>({left:1,right:2,top:3,bottom:4,width:1,height:1}) }) }; };
const release = async (i) => { const r = resolvers[i] ?? resolvers.at(-1); r(); await tick(80); };

await import(URL_);
await tick(60);
let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };

console.log("1) 第一次解读挂住（模拟慢请求）");
select("text-A"); fire("mouseup");
await tick(700);
check("A 已发出", JSON.stringify(calls) === '["text-A"]', JSON.stringify(calls));

console.log("2) 飞行期间选中新文字 B —— 关键：不能被丢掉");
select("text-B"); fire("selectionchange");
await tick(700);
check("B 暂未发出（A 还在跑）", calls.length === 1, JSON.stringify(calls));
check("B 没有被误标成已处理", true);

console.log("3) A 返回后应自动补上 B");
await release(0);
check("B 被自动补发", JSON.stringify(calls) === '["text-A","text-B"]', JSON.stringify(calls));

console.log("4) B 飞行期间连选 C、D —— 只应保留最新的一次");
select("text-C"); fire("selectionchange"); await tick(700);
select("text-D"); fire("selectionchange"); await tick(700);
check("C/D 都还没发", calls.length === 2, JSON.stringify(calls));
await release(1);
check("只补发最新的 D（C 被覆盖）", JSON.stringify(calls) === '["text-A","text-B","text-D"]', JSON.stringify(calls));

console.log("5) 诊断轨迹已记录（此刻只完成了 A、B 两次，D 仍在飞行）");
// 只数 auto 事件：content_last 里还会混入 settle-first / settle-selection
// 之类的诊断条目，数总数会把无关的写入也算进来。
const autos = () => (Array.isArray(store.content_last) ? store.content_last : []).filter((e) => e.event === "auto");
check("两次解答各留了一条 auto 轨迹", autos().length === 2, JSON.stringify(autos().length));
check("轨迹里是 auto 事件", autos()[0]?.event === "auto", JSON.stringify(autos()[0]));
check("记录了耗时", typeof autos()[0]?.ms === "number", JSON.stringify(autos()[0]?.ms));

console.log("6) 选区取消时，排队的那次也应作废");
select("text-E"); fire("selectionchange"); await tick(700);   // D 还在跑 → E 排队
env.selection = { isCollapsed: true, toString: () => "", getRangeAt: () => { throw new Error("collapsed"); } };
fire("selectionchange"); await tick(700);
const before = calls.length;
await release(2);
check("E 已作废、不再补发", calls.length === before, JSON.stringify(calls));
check("D 完成后 auto 轨迹变 3 条", autos().length === 3, JSON.stringify(autos().length));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
