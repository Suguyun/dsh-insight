// Markdown 渲染器：侧栏用 renderMarkdown，页面浮窗用 renderMarkdownForCard。
//
// md.js 不导出符号（内容脚本是 classic script，被 manifest 直接注入），
// 只挂 globalThis.dshInsightMd —— 所以这里用副作用导入再从全局取。

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) pass += 1;
  else fails.push(label);
}

// ── 极简 DOM 打桩 ──────────────────────────────────────────────
// 除了渲染，还要能检查 renderMarkdownForCard 写的行内样式，
// 所以每个元素都带 style / parentElement / querySelectorAll。
// md.js 内部用 `child instanceof Node` 区分元素与文本，少了这个全局会整个退化成纯文本。
class Node {}
class TextNode extends Node {
  constructor(t) {
    super();
    this.text = String(t);
  }
}
class Elem extends Node {
  constructor(tag) {
    super();
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.style = {};
    this.parentElement = null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  append(...cs) {
    for (const c of cs) {
      if (c == null) continue;
      c.parentElement = this;
      this.children.push(c);
    }
  }
  replaceChildren(...cs) {
    this.children = [];
    this.append(...cs);
  }
  set textContent(v) {
    this.children = [new TextNode(v)];
  }
  get tagName() {
    return this.tag.toUpperCase(); // 真实 DOM 的 tagName 是大写
  }
  get lastElementChild() {
    for (let i = this.children.length - 1; i >= 0; i -= 1) {
      if (this.children[i] instanceof Elem) return this.children[i];
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector !== "*") throw new Error(`只支持 "*"，收到 ${selector}`);
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c instanceof Elem) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

globalThis.Node = Node;
globalThis.document = {
  createElement: (t) => new Elem(t),
  createTextNode: (t) => new TextNode(t),
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function ser(n) {
  if (!(n instanceof Elem)) return esc(n.text ?? "");
  const inner = n.children.map(ser).join("");
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}

// ── 加载被测模块 ───────────────────────────────────────────────
await import(pathToFileURL(`${SRC_DIR}/md.js`).href);
const md = globalThis.dshInsightMd;

ok(md !== undefined, "md.js 要把渲染函数挂到 globalThis.dshInsightMd");
ok(typeof md?.renderMarkdown === "function", "renderMarkdown 可用");
ok(typeof md?.renderMarkdownForCard === "function", "renderMarkdownForCard 可用");

// 内容脚本是 classic script，模块里出现 export 会直接语法报错。
const mdSource = readFileSync(`${SRC_DIR}/md.js`, "utf8");
ok(!/^\s*export\s/m.test(mdSource), "md.js 不能含 export（要能被 classic script 注入）");

// 注入顺序错了，selection.js 会先跑、拿不到 globalThis.dshInsightMd。
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "extension", "manifest.json"), "utf8"));
const injected = manifest.content_scripts[0].js;
ok(
  injected.indexOf("src/md.js") !== -1 && injected.indexOf("src/md.js") < injected.indexOf("src/selection.js"),
  `manifest 里 md.js 必须排在 selection.js 之前（现在是 ${injected.join(", ")}）`,
);

const { renderMarkdown, renderMarkdownForCard } = md;

const sample = `这段代码是在组装一个**会自己决定要不要查天气**的聊天助手。它用的天气查询是假的，只为了演示流程。

逐行看：

\`\`\`python
from langgraph.prebuilt import create_react_agent

def get_weather(city: str) -> str:
    """Get weather for a given city."""
    return f"It's always sunny in {city}!"

agent = create_react_agent(
    model="anthropic.claude-3-7-sonnet-latest",
    tools=[get_weather],
    prompt="You are a helpful assistant",
)
\`\`\`

- \`create_react_agent\` 是一个**预制的模板**
  - 它按"先想、再行动、再回答"的套路工作
  - 这里可以嵌多行
- 参数只有三样：

1. \`model\`：指定模型
2. \`tools\`：给出工具
3. \`prompt\`：系统提示词

> 注意：这只是演示用的假工具。

---

行内代码 \`record.answer\`，链接 [文档](https://example.com/a)，斜体 *强调*。

安全性：<img src=x onerror=alert(1)> 和 [点我](javascript:alert(1)) 都应该变成纯文字。

\`\`\`
未闭合的围栏
\`\`\``;

// ── 侧栏版：结构正确、不泄漏标记字符、不执行注入 ───────────────
const root = new Elem("div");
renderMarkdown(root, sample);
const html = ser(root);

ok(!html.includes("**"), "** 必须被渲染成 <strong>，不能留字面量");
ok(html.includes("<strong>会自己决定要不要查天气</strong>"), "加粗渲染正确");
ok(!html.includes("<h1>"), "样本里没有标题，不该凭空造一个");
ok(html.includes("<pre"), "围栏代码块要变成 pre");
ok(html.includes("<code"), "行内代码和代码块都要有 code");
ok(html.includes("<ul>") && html.includes("<li>"), "无序列表渲染正确");
ok(html.includes("<ol>"), "有序列表渲染正确");
ok(html.includes("<blockquote>"), "引用渲染正确");
ok(html.includes("<hr>"), "分隔线渲染正确");
ok(!html.includes("<img"), "HTML 原样标签必须被转义成文字");
ok(!html.includes('href="javascript:'), "javascript: 链接不能被渲染成可点的 a");
ok(html.includes("<em>强调</em>"), "斜体渲染正确");
ok(html.includes('href="https://example.com/a"'), "正常链接保留");
ok(html.includes('target="_blank"'), "外链要新窗口打开");
ok(html.includes("未闭合的围栏"), "未闭合的围栏也要把内容吐出来");

// 空输入 / 非字符串不能炸。
const empty = new Elem("div");
renderMarkdown(empty, "");
ok(empty.children.length === 0, "空字符串渲染为空");
const weird = new Elem("div");
renderMarkdown(weird, null);
ok(weird.children.length === 0, "null 也当空处理");

// ── 浮窗版：渲染 + 行内样式 ────────────────────────────────────
const card = new Elem("div");
renderMarkdownForCard(card, sample, false);
const nodes = card.querySelectorAll("*");
const byTag = (tag) => nodes.filter((n) => n.tag === tag);

ok(byTag("strong")[0]?.style.fontWeight === "650", "浮窗：strong 要有字重");
const cardPre = byTag("pre")[0];
ok(cardPre !== undefined, "浮窗：代码块存在");
ok(cardPre?.style.whiteSpace === "pre", "浮窗：pre 要保留换行");
ok(cardPre?.style.overflowX === "auto", "浮窗：长代码行要能横向滚动");
ok(cardPre?.style.fontFamily?.includes("monospace") === true, "浮窗：代码用等宽字体");
const codeInPre = cardPre?.children?.[0];
ok(codeInPre?.style.background === "transparent", "浮窗：pre 里的 code 不再叠一层底色");
const inlineCode = byTag("code").find((n) => n !== codeInPre);
ok(
  inlineCode?.style.background !== undefined && inlineCode.style.background !== "transparent",
  "浮窗：行内代码有底色",
);
ok(byTag("p")[0]?.style.margin === "0 0 8px", "浮窗：段落有下边距");
ok(byTag("blockquote")[0]?.style.borderLeft?.includes("solid") === true, "浮窗：引用有左边框");
ok(byTag("a")[0]?.style.textDecoration === "underline", "浮窗：链接有下划线");
ok(byTag("hr")[0]?.style.borderTop?.includes("solid") === true, "浮窗：分隔线用上边框画");

// 深浅色要真的不同，否则等于没做主题适配。
const darkCard = new Elem("div");
renderMarkdownForCard(darkCard, sample, true);
const darkNodes = darkCard.querySelectorAll("*");
const darkPre = darkNodes.filter((n) => n.tag === "pre")[0];
ok(darkPre?.style.background !== cardPre?.style.background, "浮窗：深浅色代码块底色要不同");
const darkLink = darkNodes.filter((n) => n.tag === "a")[0];
ok(darkLink?.style.color !== byTag("a")[0].style.color, "浮窗：深浅色链接颜色要不同");

// 套样式失败不能把已经渲染好的内容弄丢（CSSOM 在极老环境下可能不给用）。
const hostile = new Elem("div");
hostile.querySelectorAll = () => {
  throw new Error("CSSOM 不可用");
};
renderMarkdownForCard(hostile, "**仍然要渲染**", false);
ok(ser(hostile).includes("<strong>仍然要渲染</strong>"), "套样式失败时正文仍然在");

console.log(ser(root).replace(/></g, ">\n<"));
console.log(`\n${pass} 断言通过${fails.length > 0 ? `，${fails.length} 失败` : ""}`);
for (const f of fails) console.log(`FAIL ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
