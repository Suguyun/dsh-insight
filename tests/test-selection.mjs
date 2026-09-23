// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/selection.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

class El { constructor(t){this.tag=t;this.style={};this.children=[];this.handlers={};this.textContent="";this.parentNode=null;}
  setAttribute(){} appendChild(c){this.children.push(c);c.parentNode=this;}
  addEventListener(t,h){(this.handlers[t]||=[]).push(h);}
  fire(t,ev={}){for(const h of this.handlers[t]||[])h(ev);} }
globalThis.Element = class {};

const store = {};
const env = { appended: [], sent: [], listeners: {}, selection: null, onChanged: [] };
globalThis.document = {
  title: "T",
  documentElement: { appendChild: (el) => { env.appended.push(el); el.parentNode = { removeChild: () => { const i = env.appended.indexOf(el); if (i >= 0) env.appended.splice(i,1); } }; } },
  createElement: (t) => new El(t),
  addEventListener: (t, h) => { (env.listeners[t] ||= []).push(h); },
};
const win = { innerWidth:1200, innerHeight:800,
  setTimeout:(f,m)=>setTimeout(f,m), clearTimeout:(i)=>clearTimeout(i),
  matchMedia:()=>({matches:false}), getSelection:()=>env.selection };
win.top = win;
globalThis.window = win;
globalThis.location = { href: "https://example.com/p" };
globalThis.chrome = {
  storage: { local: {
    get: async (keys) => { const l=Array.isArray(keys)?keys:[keys]; const o={}; for(const k of l) if(k in store)o[k]=store[k]; return o; },
    set: async (o) => Object.assign(store, o) },
    onChanged: { addListener: (fn) => env.onChanged.push(fn) } },
  runtime: { id: "test-ext", onMessage: { addListener() {} }, sendMessage: async (m) => { if (m?.type === "panel-state-query") return { open: true }; env.sent.push(m); return { ok: true, text: "ANSWER" }; } },
};
env.fire = (t, ev) => { for (const h of env.listeners[t] || []) h(ev); };

await import(URL_);          // 只导入一次：query 不同不会产生新实例，不能靠它切场景
await tick(40);

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };
const allText = (el) => (el.textContent || "") + el.children.map(allText).join("");
const select = (text) => { env.selection = { isCollapsed:false, toString:()=>text,
  getRangeAt:()=>({ getBoundingClientRect:()=>({left:100,right:300,top:200,bottom:220,width:200,height:20}) }) }; };

/** 改设置并让内容脚本重读（走真实的 storage.onChanged 链路）。 */
async function setMode(patch) {
  Object.assign(store, patch);
  const changes = {}; for (const k of Object.keys(patch)) changes[k] = { newValue: patch[k] };
  for (const fn of env.onChanged) fn(changes, "local");
  await tick(40);
}
/** 每个场景之间清场：折叠选区（重置自动模式去重）+ 关掉已有浮窗。 */
async function reset() {
  env.selection = { isCollapsed:true, toString:()=>"", getRangeAt:()=>{ throw new Error("collapsed"); } };
  env.fire("mousedown", { target: {} });
  await tick(30);
  env.appended.length = 0; env.sent.length = 0;
}

// 1) 默认：点浮标
env.selection = null; await reset();
select("hello world"); env.fire("mouseup", {});
await tick(400);
check("默认模式：出现浮标", env.appended.length === 1, String(env.appended.length));
check("默认模式：不自动请求", env.sent.length === 0);
env.appended[0].fire("click", { preventDefault(){}, stopPropagation(){} });
await tick(60);
check("点浮标后请求 + 卡片有结果", env.sent.length === 1 && allText(env.appended[0]).includes("ANSWER"));

// 2) auto：划词即解读，不弹浮标，同一段文字只一次
await reset(); await setMode({ insight_mode: "auto" });
select("auto text"); env.fire("selectionchange", {});
await tick(700);
check("auto：自动发请求", env.sent.length === 1, String(env.sent.length));
check("auto：页面出现结果卡片", env.appended.length === 1 && allText(env.appended[0]).includes("ANSWER"));
const n2 = env.sent.length; env.fire("selectionchange", {}); await tick(700);
check("auto：同一段文字不重复解读", env.sent.length === n2, String(env.sent.length));

// 3) auto-sidebar：发请求但页面干干净净
await reset(); await setMode({ insight_mode: "auto-sidebar" });
select("sidebar only"); env.fire("mouseup", {});
await tick(700);
check("auto-sidebar：发出请求（侧栏会实时收到）", env.sent.length === 1, String(env.sent.length));
check("auto-sidebar：页面不出现任何元素", env.appended.length === 0, String(env.appended.length));

// 4) click-sidebar：浮标在（它是触发器），结果卡片不在
await reset(); await setMode({ insight_mode: "click-sidebar" });
select("no card here"); env.fire("mouseup", {});
await tick(400);
check("click-sidebar：浮标仍在", env.appended.length === 1, String(env.appended.length));
env.appended[0].fire("click", { preventDefault(){}, stopPropagation(){} });
await tick(60);
check("click-sidebar：发出请求", env.sent.length === 1);
check("click-sidebar：不弹结果卡片", env.appended.length === 0, String(env.appended.length));

// 5) fixed：浮标钉在右下角
await reset(); await setMode({ insight_mode: "click", insight_position: "fixed" });
select("pin me"); env.fire("mouseup", {});
await tick(400);
const b = env.appended[0];
check("fixed：用 right/bottom", b.style.right === "16px" && b.style.bottom === "16px", JSON.stringify(b.style));
check("fixed：不再用 left/top", b.style.left === undefined && b.style.top === undefined);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
