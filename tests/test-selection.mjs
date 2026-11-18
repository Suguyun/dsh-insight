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
  get textContent(){ return this.children.map((c) => (c.textContent ?? "")).join(""); }
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
const env = { appended: [], sent: [], listeners: {}, selection: null, onChanged: [], panelListeners: [], panelOpen: false, gate: null };
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
  runtime: { id: "test-ext", onMessage: { addListener: (fn) => env.panelListeners.push(fn) }, sendMessage: async (m) => { if (m?.type === "panel-state-query") return { open: env.panelOpen }; env.sent.push(m); env.replyCount = (env.replyCount || 0) + 1; if (env.gate !== null) await env.gate; return { ok: true, text: `**ANSWER** ${env.replyCount} 和 \`code\`` }; } },
};
env.fire = (t, ev) => { for (const h of env.listeners[t] || []) h(ev); };

await import(pathToFileURL(`${SRC_DIR}/md.js`).href); // 卡片渲染依赖它挂的 globalThis
await import(URL_);          // 只导入一次：query 不同不会产生新实例，不能靠它切场景
await tick(40);

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };
// 桩里的 textContent 是「拼接全部子节点」的真实语义，所以直接读它就够了（别重复累加子节点）。
const allText = (el) => (el.textContent !== undefined ? el.textContent : (el.children || []).map(allText).join(""));
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
/** 模拟 background 推送侧栏开合变化（和真实链路一样走 runtime 消息）。 */
async function setPanel(open) {
  env.panelOpen = open;
  for (const fn of env.panelListeners) fn({ type: "panel-state", open });
  await tick(20);
}
/** 每个场景之间清场：折叠选区（重置自动模式去重）+ 关掉已有浮窗。 */
async function reset() {
  if (env.panelOpen) await setPanel(false);
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

// 2) 旧值 auto：必须归一成手动 —— 划词只弹浮标，点浮标才解读
await reset(); await setMode({ insight_mode: "auto" });
select("legacy auto text"); env.fire("selectionchange", {});
await tick(600);
check("旧值 auto：划词不发请求", env.sent.length === 0, String(env.sent.length));
check("旧值 auto：只弹浮标", env.appended.length === 1 && allText(env.appended[0]) === "解读", String(env.appended.length));
env.appended[0].fire("click", { preventDefault(){}, stopPropagation(){} });
await tick(80);
check("旧值 auto：点浮标才发请求", env.sent.length === 1, String(env.sent.length));
check("旧值 auto：结果落在页面卡片", allText(env.appended[0]).includes("ANSWER"), allText(env.appended[0]));

// 3) 旧值 auto-sidebar：归一成「只进侧栏」—— 侧栏关着安静跳过，开着就直接解读
await reset(); await setMode({ insight_mode: "auto-sidebar" });
select("sidebar only closed"); env.fire("mouseup", {});
await tick(600);
check("旧值 auto-sidebar + 侧栏关：不发请求", env.sent.length === 0, String(env.sent.length));
check("旧值 auto-sidebar + 侧栏关：不弹浮标", env.appended.length === 0, String(env.appended.length));
await setPanel(true);
select("sidebar only open"); env.fire("mouseup", {});
await tick(500);
check("侧栏打开：划词直接解读", env.sent.length === 1, String(env.sent.length));
check("侧栏打开：请求带 target=sidebar", env.sent[0]?.target === "sidebar", String(env.sent[0]?.target));
check("侧栏打开：页面不出现结果卡片", env.appended.length === 0, String(env.appended.length));

// 4) click-sidebar：同样跟着侧栏开合走
await reset(); await setMode({ insight_mode: "click-sidebar" });
select("no card here"); env.fire("mouseup", {});
await tick(400);
check("click-sidebar + 侧栏关：页面无元素也不发请求", env.appended.length === 0 && env.sent.length === 0, `${String(env.appended.length)}/${String(env.sent.length)}`);
await setPanel(true);
select("auto into panel"); env.fire("mouseup", {});
await tick(500);
check("click-sidebar + 侧栏开：自动发请求", env.sent.length === 1, String(env.sent.length));
check("click-sidebar + 侧栏开：目标 sidebar", env.sent[0]?.target === "sidebar", String(env.sent[0]?.target));

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
check("卡片上有三个按钮（复制 + 图钉 + 关闭）", cardBtns.length === 3, String(cardBtns.length));
const copyBtn = cardBtns.find((n) => n.title === "复制结果");
check("卡片上有复制按钮", copyBtn !== undefined, JSON.stringify(cardBtns.map((n) => n.title)));
const pinBtn = cardBtns.find((n) => n.attrs?.["aria-pressed"] !== undefined);
check("图钉默认是未钉住", pinBtn.attrs?.["aria-pressed"] === "false", JSON.stringify(pinBtn.attrs));
check("图钉有说明文字", typeof pinBtn.title === "string" && pinBtn.title.includes("钉住"), pinBtn.title);

// 复制：把正文交给剪贴板，按钮就地给个回执，过一会儿自己复原
const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let copiedText = null;
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async (t) => { copiedText = t; } } },
  configurable: true,
});
copyBtn.fire("click", {});
await tick(40);
check("复制：正文被送进剪贴板", typeof copiedText === "string" && copiedText.includes("ANSWER"), String(copiedText));
check("复制：按钮就地变成已复制", allText(copyBtn) === "✓", allText(copyBtn));
check("复制：说明跟着改成已复制", copyBtn.title === "已复制", copyBtn.title);
await tick(1300);
check("复制：回执会自己复原", allText(copyBtn) === "⧉", allText(copyBtn));
if (navDescriptor === undefined) delete globalThis.navigator;
else Object.defineProperty(globalThis, "navigator", navDescriptor);

pinBtn.fire("click", {});
check("点图钉后变为已钉住", pinBtn.attrs?.["aria-pressed"] === "true", JSON.stringify(pinBtn.attrs));
check("已钉住时说明会讲自动解读", pinBtn.title.includes("自动解读"), pinBtn.title);

// 开始划新词：页面上的 mousedown 会先发生 —— 钉住的卡片必须挺住。
// 钉住 = 用户说了「我还在看这段」，所以这次不用再点浮标：直接就地更新。
const seqBefore = env.replyCount || 0;
const sentBefore = env.sent.length;
select("second text"); env.fire("mousedown", { target: {} });
await tick(40);
check("钉住：点页面别处不会关掉卡片", env.appended.length === 1, String(env.appended.length));
env.fire("mouseup", {});
await tick(500);
check("钉住：划新词自动解读", env.sent.length === sentBefore + 1, String(env.sent.length));
check("钉住：不弹浮标（不用再点一下）", env.appended.length === 1, String(env.appended.length));
check("钉住：不新建卡片，还是同一张", env.appended[0] === cardEl, String(env.appended.length));
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

// 肯花力气挪位置 = 想留着它：一拖就顺带钉住
pinBtn.fire("click", {});
check("再点一次取消钉住", pinBtn.attrs?.["aria-pressed"] === "false");
cbar.fire("pointerdown", { button: 0, pointerId: 9, clientX: 150, clientY: 210, target: cbar, preventDefault(){}, stopPropagation(){} });
cbar.fire("pointerup", { pointerId: 9 });
check("拖动一下就算钉住", pinBtn.attrs?.["aria-pressed"] === "true", JSON.stringify(pinBtn.attrs));
pinBtn.fire("click", {});
check("拖动后仍能手动取消钉住", pinBtn.attrs?.["aria-pressed"] === "false");
env.fire("mousedown", { target: {} });
check("未钉住时点别处会收掉卡片", env.appended.length === 0, String(env.appended.length));

// 9) 手感细节：多击不误发、滚动收起浮标、长卡片不探出视口
await reset(); await setMode({ insight_mode: "click", insight_position: "auto" });
select("double click word"); env.fire("mouseup", {});
await tick(400);
check("多击：浮标已出现", env.appended.length === 1, String(env.appended.length));
env.appended[0].fire("click", { detail: 2, preventDefault(){}, stopPropagation(){} });
await tick(60);
check("多击：detail>1 不发起解读", env.sent.length === 0, String(env.sent.length));
check("多击：浮标留着等用户再点一次", env.appended.length === 1, String(env.appended.length));
env.appended[0].fire("click", { detail: 1, preventDefault(){}, stopPropagation(){} });
await tick(80);
check("多击：正常单击照常解读", env.sent.length === 1, String(env.sent.length));

// 页面一滚，固定定位的浮标就悬在无关文字上方了 —— 收起来，卡片不动
await reset();
select("scroll me"); env.fire("mouseup", {});
await tick(400);
check("滚动前：浮标在", env.appended.length === 1, String(env.appended.length));
env.fire("scroll", { target: {} });
await tick(20);
check("页面滚动后：浮标收起", env.appended.length === 0, String(env.appended.length));

// 浮标没人理就自己走开，别一直压着下层内容；鼠标停在上面时不算
await reset();
select("idle me"); env.fire("mouseup", {});
await tick(400);
check("闲置：浮标先出现", env.appended.length === 1, String(env.appended.length));
env.appended[0].fire("mouseenter", {});
await tick(3100);
check("闲置：鼠标停在上面就不收", env.appended.length === 1, String(env.appended.length));
env.appended[0].fire("mouseleave", {});
await tick(3100);
check("闲置：没人理会自动收起", env.appended.length === 0, String(env.appended.length));

// 长解读：按 120px 估的位置会探出视口底，得翻到选区上方
await reset();
const savedInnerHeight = win.innerHeight;
win.innerHeight = 300;
select("tall card"); env.fire("mouseup", {});
await tick(400);
env.appended[0].fire("click", { preventDefault(){}, stopPropagation(){} });
await tick(80);
check("长卡片：翻到选区上方，不探出视口底", env.appended[0].style.top === "70px", String(env.appended[0].style.top));
win.innerHeight = savedInnerHeight;

// 8) 拉伸：右下角把手拖宽拖高，尺寸记住，下次新卡片直接沿用
await reset(); await setMode({ insight_mode: "click", insight_position: "auto" });
select("resize me"); env.fire("mouseup", {});
await tick(400);
env.appended[0].fire("click", { preventDefault(){}, stopPropagation(){} });
await tick(80);
const rcard = env.appended[0];
const rhandle = rcard.children[2];
check("卡片右下角有拉伸把手", rhandle instanceof El && rhandle.style.cursor === "nwse-resize", String(rhandle?.style?.cursor));
check("正文自己滚（不是整卡滚）", rcard.children[1].style.overflow === "auto", String(rcard.children[1].style.overflow));
check("外壳不开滚动（给把手留位置）", rcard.style.overflow === "hidden", String(rcard.style.overflow));
rhandle.fire("pointerdown", { button: 0, pointerId: 11, clientX: 400, clientY: 320, preventDefault(){}, stopPropagation(){} });
check("拉伸：按下即换成 left/top 定位", rcard.style.left === "100px" && rcard.style.top === "200px", `${rcard.style.left}/${rcard.style.top}`);
check("拉伸：放开 60vh 上限，否则拉到一半就不动了", rcard.style.maxHeight === "none", rcard.style.maxHeight);
rhandle.fire("pointermove", { pointerId: 11, clientX: 600, clientY: 400, preventDefault(){}, stopPropagation(){} });
check("拉伸：宽度跟着指针走", rcard.style.width === "500px", rcard.style.width);
check("拉伸：高度跟着指针走", rcard.style.height === "200px", rcard.style.height);
// 桩不会因为改样式就变 rect：松手前手动同步，模拟浏览器量到的真实尺寸
rcard.rect = { left: 100, top: 200, width: 500, height: 200 };
rhandle.fire("pointerup", { pointerId: 11 });
await tick(20);
check("拉伸：尺寸记进 storage", store.insight_card_size?.width === 500 && store.insight_card_size?.height === 200, JSON.stringify(store.insight_card_size));
rhandle.fire("pointermove", { pointerId: 11, clientX: 900, clientY: 700, preventDefault(){}, stopPropagation(){} });
check("拉伸：松手后不再跟随", rcard.style.width === "500px", rcard.style.width);
delete rcard.rect;

// 9) 记住的尺寸：新卡片直接沿用，不用每划一次词重拉一遍
await reset();
check("关掉卡片后尺寸还记着", store.insight_card_size?.width === 500, JSON.stringify(store.insight_card_size));
select("reuse size"); env.fire("mouseup", {});
await tick(400);
env.appended[0].fire("click", { preventDefault(){}, stopPropagation(){} });
await tick(80);
const reused = env.appended[0];
check("新卡片沿用上次的宽度", reused.style.width === "500px", reused.style.width);
check("新卡片沿用上次的高度", reused.style.height === "200px", reused.style.height);
check("有记忆高度时不再套 60vh 上限", reused.style.maxHeight === "none", reused.style.maxHeight);

// 10) 钉住时划得比模型快：最新一次选区要补发，不能默默丢掉
const pinned2 = env.appended[0].querySelectorAll("*").find((n) => n.attrs?.["aria-pressed"] !== undefined);
pinned2.fire("click", {});
check("准备：已钉住", pinned2.attrs?.["aria-pressed"] === "true");
let release = () => {};
env.gate = new Promise((r) => { release = r; });
const sentBeforeQueue = env.sent.length;
select("queued first"); env.fire("mouseup", {});
await tick(400);
select("latest wins"); env.fire("mouseup", {});
await tick(400);
check("同时在跑时不重复发请求", env.sent.length === sentBeforeQueue + 1, JSON.stringify(env.sent.map((m) => m.text)));
env.gate = null;
release();
await tick(400);
check("上一轮结束后补发最新选区", env.sent.length === sentBeforeQueue + 2, JSON.stringify(env.sent.map((m) => m.text)));
check("补发的是最后划的那段", env.sent.at(-1)?.text === "latest wins", String(env.sent.at(-1)?.text));
// 钉住的卡片不会被 mousedown 收掉（这是它的意义），所以下一个场景要手动取消钉住
pinned2.fire("click", {});
check("准备：已取消钉住", pinned2.attrs?.["aria-pressed"] === "false");

// 11) 侧栏开着：页面浮窗模式也直接出结果，不用先点浮标
await reset(); await setMode({ insight_mode: "click" });
await setPanel(true);
select("panel open card"); env.fire("mouseup", {});
await tick(500);
check("侧栏开着：卡片直接出现（不必点浮标）", env.appended.length === 1, String(env.appended.length));
check("侧栏开着：结果已经填进卡片", allText(env.appended[0]).includes("ANSWER"), allText(env.appended[0]));
check("侧栏开着：请求目标仍是 page", env.sent[0]?.target === "page", String(env.sent[0]?.target));

// 12) 文本框里划词不算「想让人解读这段话」—— 那多半只是在改字
await reset(); await setMode({ insight_mode: "click" });
await setPanel(true);
const sentBeforeEdit = env.sent.length;
env.selection = { isCollapsed: false, toString: () => "typed text", anchorNode: { nodeType: 1, closest: (sel) => (String(sel).includes("textarea") ? {} : null) },
  getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20 }) }) };
env.fire("selectionchange", {});
await tick(700);
check("文本框里划词：不自动解读", env.sent.length === sentBeforeEdit, String(env.sent.length));
check("文本框里划词：也不弹浮标", env.appended.length === 0, String(env.appended.length));
await setPanel(false);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
