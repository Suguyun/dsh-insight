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

const store = {};                       // 默认模式 = click（手动点浮标）
const env = { appended: [], sent: [], listeners: {}, selection: null };
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
globalThis.chrome = {
  // onMessage：selection.js 会订阅侧栏开合状态。
  // sendMessage 要先挡掉 panel-state-query，否则它会混进 env.sent 干扰断言。
  runtime: { id: undefined, onMessage: { addListener() {} }, sendMessage: async (m) => { if (m?.type === "panel-state-query") return { open: true }; env.sent.push(m); return { ok: true, text: "X" }; } },  // 一开始就是孤儿
  storage: { local: { get: async ()=>({}), set: async()=>{} }, onChanged: { addListener(){} } },
};
const fire = (t) => { for (const h of env.listeners[t] || []) h({}); };
const select = (t) => { env.selection = { isCollapsed:false, toString:()=>t, getRangeAt:()=>({ getBoundingClientRect:()=>({left:1,right:2,top:3,bottom:4,width:1,height:1}) }) }; };
const notice = () => env.appended.find((el) => (el.textContent || "").includes("刷新本页"));
const bubble = () => env.appended.find((el) => el.tag === "button");

await import(URL_);
await tick(60);

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };

// 注意顺序：showOrphanNotice 是幂等的（已显示就不再插），所以「提前提示」必须
// 放在最前面测 —— 否则会被前一步已经显示的提示挡掉。
console.log("1) 切回该标签页时提前提示（还没划任何词）");
fire("visibilitychange");
await tick(30);
check("可见性变化即提示", notice() !== undefined, JSON.stringify(env.appended.map((e) => e.tag)));
check("此时没有浮标", bubble() === undefined);

console.log("2) 手动模式 + 孤儿：不弹浮标、不发请求");
select("hello"); fire("mouseup");
await tick(500);
check("没有弹出浮标", bubble() === undefined, JSON.stringify(env.appended.map((e) => e.tag)));
check("仍未发请求", env.sent.length === 0);
check("提示仍在（未重复堆叠）", env.appended.filter((e) => (e.textContent||"").includes("刷新本页")).length === 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
