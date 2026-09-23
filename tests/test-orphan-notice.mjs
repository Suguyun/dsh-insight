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

const store = { insight_mode: "auto" };
const env = { appended: [], sent: [], listeners: {}, selection: null, visibility: "hidden" };
globalThis.document = {
  title: "T", visibilityState: "hidden",
  documentElement: { appendChild: (el) => { env.appended.push(el); el.parentNode = { removeChild: () => { const i = env.appended.indexOf(el); if (i>=0) env.appended.splice(i,1); } }; } },
  createElement: (t) => new El(t),
  addEventListener: (t, h) => { (env.listeners[t] ||= []).push(h); },
};
const win = { innerWidth: 1200, innerHeight: 800, setTimeout:(f,m)=>setTimeout(f,m), clearTimeout:(i)=>clearTimeout(i),
  matchMedia: () => ({ matches: false }), getSelection: () => env.selection };
win.top = win;
globalThis.window = win;
globalThis.location = { href: "https://example.com/p" };
globalThis.chrome = {
  runtime: { id: "abcdef", sendMessage: async (m) => { env.sent.push(m); return { ok: true, text: "ANSWER" }; } },
  storage: { local: { get: async (k)=>{const l=Array.isArray(k)?k:[k];const o={};for(const x of l)if(x in store)o[x]=store[x];return o;}, set: async(o)=>Object.assign(store,o) }, onChanged: { addListener(){} } },
};
const fire = (t) => { for (const h of env.listeners[t] || []) h({}); };
const select = (text) => { env.selection = { isCollapsed:false, toString:()=>text, getRangeAt:()=>({ getBoundingClientRect:()=>({left:100,right:300,top:200,bottom:220,width:200,height:20}) }) }; };
const noticeCount = () => env.appended.filter((el) => (el.textContent || "").includes("刷新本页")).length;

await import(URL_);
await tick(60);

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };

console.log("1) 健康：划词正常发请求，不出现提示");
select("healthy text"); fire("mouseup");
await tick(700);
check("发出了请求", env.sent.length === 1, String(env.sent.length));
check("没有刷新提示", noticeCount() === 0, String(noticeCount()));

console.log("2) 变成孤儿：不再发请求，改为页面提示");
chrome.runtime.id = undefined;              // 模拟扩展重载后的失效上下文
env.sent.length = 0; env.appended.length = 0;
select("another text"); fire("selectionchange");
await tick(700);
check("没有发出任何请求", env.sent.length === 0, String(env.sent.length));
check("页面上出现了刷新提示", noticeCount() === 1, String(noticeCount()));
const box = env.appended.find((el) => (el.textContent || "").includes("刷新本页"));
check("提示文案说清了原因", (box?.textContent || "").includes("dsh-insight 已更新"), box?.textContent);
check("提示带 data-dsh-insight（点击不会误触其它逻辑）", box?.attrs?.["data-dsh-insight"] === "");

console.log("3) 孤儿状态下重复划词：提示不重复堆叠");
env.appended.length = 0;
select("third text"); fire("mouseup");
await tick(700);
check("仍无请求", env.sent.length === 0, String(env.sent.length));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
