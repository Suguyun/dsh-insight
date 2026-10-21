// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/selection.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// md.js 用 document.createTextNode 造文本，并用 `instanceof Node` 区分元素与文本；
// 少了这两样，渲染会一路抛错再被 try/catch 兜成纯文本 —— 看着"能跑"，其实没渲染。
class Node {}
class Element extends Node {}
class TextNode extends Node { constructor(t){ super(); this.textContent = String(t); } }
class El extends Element {
  constructor(t){ super(); this.tag=t; this.nodeType=1; this.style={}; this.children=[]; this.handlers={}; this.parentNode=null; this.parentElement=null; }
  get tagName(){ return this.tag.toUpperCase(); }
  setAttribute(k, v){ (this.attrs ||= {})[k] = String(v); }
  getBoundingClientRect(){ return this.rect ?? { left: 100, top: 200, width: 300, height: 120 }; }
  append(c){ if (c == null) return; c.parentNode = this; c.parentElement = this; this.children.push(c); }
  appendChild(c){ this.append(c); }
  replaceChildren(...cs){ this.children = []; for (const c of cs) this.append(c); }
  set textContent(v){ this.children = []; if (v !== "") this.children.push(new TextNode(v)); }
  get lastElementChild(){ for (let i=this.children.length-1;i>=0;i-=1) if (this.children[i] instanceof El) return this.children[i]; return null; }
  querySelectorAll(sel){ if (sel !== "*") throw new Error("只支持 *"); const out=[];
    const walk=(n)=>{ for (const c of n.children) if (c instanceof El) { out.push(c); walk(c); } }; walk(this); return out; }
  closest(sel){
    for (let n = this; n instanceof El; n = n.parentElement) {
      if (sel === "button" && n.tag === "button") return n;
      if (sel === "[data-dsh-insight]" && n.attrs && "data-dsh-insight" in n.attrs) return n;
    }
    return null;
  }
  addEventListener(t,h){(this.handlers[t]||=[]).push(h);}
  fire(t,ev={}){for(const h of this.handlers[t]||[])h(ev);} }
globalThis.Element = Element;

const store = {};
const env = { appended: [], sent: [], listeners: {}, selection: null, onChanged: [] };
globalThis.Node = Node;
globalThis.document = {
  title: "T",
  createTextNode: (t) => new TextNode(t),
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
  runtime: { id: "test-ext", onMessage: { addListener() {} }, sendMessage: async (m) => { if (m?.type === "panel-state-query") return { open: true }; env.sent.push(m); env.replyCount = (env.replyCount || 0) + 1; return { ok: true, text: `**ANSWER** ${env.replyCount} 和 \`code\`` }; } },
};
env.fire = (t, ev) => { for (const h of env.listeners[t] || []) h(ev); };

await import(pathToFileURL(`${SRC_DIR}/md.js`).href); // 卡片渲染依赖它挂的 globalThis
await import(URL_);          // 只导入一次：query 不同不会产生新实例，不能靠它切场景
await tick(40);

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };
const allText = (el) => (el.textContent || "") + (el.children || []).map(allText).join("");
const deepTags = (el, acc = []) => { for (const c of el.children || []) if (c instanceof El) { acc.push(c.tag); deepTags(c, acc); } return acc; };
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
// 回归：卡片正文必须真的渲染成元素，不能把 ** 和 ` 当字面量显示出来
const cardTags = deepTags(env.appended[0]);
check("卡片渲染 Markdown：有 strong", cardTags.includes("strong"), JSON.stringify(cardTags));
check("卡片渲染 Markdown：有 code", cardTags.includes("code"), JSON.stringify(cardTags));
check("卡片不泄漏 ** 字面量", !allText(env.appended[0]).includes("**"), allText(env.appended[0]));
check("卡片不泄漏 ` 字面量", !allText(env.appended[0]).includes("`"), allText(env.appended[0]));
// 浮窗里没有样式表：样式必须写成行内样式，否则等于没渲染
const strongEl = env.appended[0].querySelectorAll("*").find((n) => n.tag === "strong");
check("卡片给 strong 套了行内样式", strongEl !== undefined && strongEl.style.fontWeight === "650", JSON.stringify(strongEl?.style));

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

// 6) md.js 取不到时（比如扩展刚更新、manifest 注入还没生效）不能把内容弄丢
await reset(); await setMode({ insight_mode: "click", insight_position: "auto" });
const savedMd = globalThis.dshInsightMd;
delete globalThis.dshInsightMd;
try {
  select("fallback text"); env.fire("mouseup", {});
  await tick(400);
  env.appended[0].fire("click", { preventDefault(){}, stopPropagation(){} });
  await tick(60);
  const text = allText(env.appended[0]);
  check("没有 md.js 时退回纯文本，内容还在", text.includes("**ANSWER**"), text);
} finally {
  globalThis.dshInsightMd = savedMd;
}

// 7) 图钉：钉住后不消失，划新词就地更新
await reset(); await setMode({ insight_mode: "click", insight_position: "auto" });
select("pin card"); env.fire("mouseup", {});
await tick(400);
env.appended[0].fire("click", { preventDefault(){}, stopPropagation(){} });
await tick(80);

const cardEl = env.appended[0];
const cbar = cardEl.children[0];
const cardBtns = cardEl.querySelectorAll("*").filter((n) => n.tag === "button");
check("卡片上有两个按钮（图钉 + 关闭）", cardBtns.length === 2, String(cardBtns.length));
const pinBtn = cardBtns[0];
check("图钉默认是未钉住", pinBtn.attrs?.["aria-pressed"] === "false", JSON.stringify(pinBtn.attrs));
check("图钉有说明文字", typeof pinBtn.title === "string" && pinBtn.title.includes("钉住"), pinBtn.title);

pinBtn.fire("click", {});
check("点图钉后变为已钉住", pinBtn.attrs?.["aria-pressed"] === "true", JSON.stringify(pinBtn.attrs));
check("已钉住时说明会就地更新", pinBtn.title.includes("就地更新"), pinBtn.title);

// 开始划新词：页面上的 mousedown 会先发生 —— 钉住的卡片必须挺住
await setMode({ insight_mode: "auto" });
const seqBefore = env.replyCount || 0;
select("second text"); env.fire("mousedown", { target: {} });
await tick(40);
check("钉住：点页面别处不会关掉卡片", env.appended.length === 1, String(env.appended.length));
env.fire("mouseup", {});
await tick(700);
check("钉住：不新建卡片，还是同一张", env.appended.length === 1 && env.appended[0] === cardEl, String(env.appended.length));
check("钉住：正文就地更新成新一次结果", allText(cardEl).includes(`ANSWER ${seqBefore + 1}`), allText(cardEl));
check("钉住：结束后收起「更新中…」", cbar.children[2].style.display === "none", String(cbar.children[2].style.display));

// 拖动：按住标题栏
cbar.fire("pointerdown", { button: 0, pointerId: 7, clientX: 150, clientY: 210, target: cbar, preventDefault(){}, stopPropagation(){} });
check("拖动：按下即切到 left/top 定位", cardEl.style.left === "100px" && cardEl.style.top === "200px", `${cardEl.style.left}/${cardEl.style.top}`);
check("拖动：清掉 right/bottom 免得跳位", cardEl.style.right === "auto" && cardEl.style.bottom === "auto");
cbar.fire("pointermove", { pointerId: 7, clientX: 400, clientY: 300, preventDefault(){} });
check("拖动：位置跟着指针走", cardEl.style.left === "350px" && cardEl.style.top === "290px", `${cardEl.style.left}/${cardEl.style.top}`);
cbar.fire("pointerup", { pointerId: 7 });
cbar.fire("pointermove", { pointerId: 7, clientX: 700, clientY: 600, preventDefault(){} });
check("拖动：松手后不再跟随", cardEl.style.left === "350px", cardEl.style.left);

// 在卡片里选字（想复制）不该被当成划词再解读一次
const sentBeforePick = env.sent.length;
const textBeforePick = allText(cardEl);
env.selection = { isCollapsed: false, toString: () => "ANSWER 2", rangeCount: 1,
  getRangeAt: () => ({ commonAncestorContainer: cardEl.children[1] }) };
env.fire("selectionchange", {});
await tick(700);
check("卡片里选字不触发新解读", env.sent.length === sentBeforePick, `${env.sent.length} vs ${sentBeforePick}`);
check("卡片里选字不会顶掉正文", allText(cardEl) === textBeforePick, allText(cardEl));
check("卡片里选字不弹浮标", env.appended.length === 1, String(env.appended.length));
await tick(60);
// 卡片内选字走的是「忽略」而不是「抓不到选区」—— 否则诊断里会多一条假的 capture-miss
const missAfter = (store.content_last || []).filter((e) => e.event === "capture-miss").length;
check("卡片里选字不记 capture-miss 诊断", missAfter === 0, JSON.stringify((store.content_last || []).slice(0, 2)));

// 按在图钉上不能触发拖动
const before = cardEl.style.left;
cbar.fire("pointerdown", { button: 0, pointerId: 8, clientX: 150, clientY: 210, target: pinBtn, preventDefault(){}, stopPropagation(){} });
check("按在图钉上不启动拖动", cardEl.style.left === before, cardEl.style.left);

// 取消钉住后，行为回到「点别处就收掉」
pinBtn.fire("click", {});
check("再点一次取消钉住", pinBtn.attrs?.["aria-pressed"] === "false");
env.fire("mousedown", { target: {} });
check("未钉住时点别处会收掉卡片", env.appended.length === 0, String(env.appended.length));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
