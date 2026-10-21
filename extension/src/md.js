// 极简 Markdown 渲染器：零依赖、零 innerHTML。
//
// 划词解读的回答本来就是 Markdown（代码围栏、**加粗**、列表、行内代码……）。
// 以前侧栏用 `textContent` 直接塞进去，于是标记原样显示成 ```python、**xxx**。
// 这里把它渲染成真正的 DOM。
//
// 为什么自己写而不用 marked / markdown-it：MV3 的 CSP 不允许远程脚本，为一个
// 渲染器往扩展里塞几十 KB 也不划算；输出规模只有一段解读，支持常用子集足够。
// 当前支持：围栏代码块（``` / ~~~，带语言标签）、行内代码、加粗、斜体、删除线、
// 标题、无序/有序列表（含嵌套）、引用、分隔线、链接（仅放行 http/https）、段落。
// 暂不支持表格与 HTML 区块。
//
// 安全性：全程用 createElement / createTextNode 构造节点，从不拼 innerHTML，
// 所以回答里出现 <script>、<img onerror=...> 也只会被当成普通文字显示。

/** 该行是否是“块”的起始（用于判断段落在哪里结束）。 */
function startsBlock(line) {
  return (
    /^\s{0,3}#{1,6}\s/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s{0,3}([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
    /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)
  );
}

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) node.setAttribute(key, value);
  }
  appendAll(node, children);
  return node;
}

function appendAll(node, children) {
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** 去掉至多 n 个前导空白，用于把嵌套内容的缩进还原到第 0 层。 */
function dedent(line, n) {
  let k = 0;
  while (k < n && (line[k] === " " || line[k] === "\t")) k += 1;
  return line.slice(k);
}

// ---- 行内 ----

// 顺序有讲究：先代码，再 **bold** / __bold__ / ~~del~~，最后单星/单下划线斜体，
// 链接放最后（它内部的文字还会再递归解析一次）。
//
// 注意这里存的是「正则源码」而不是正则对象：inline() 会递归（加粗/斜体/链接
// 内部要再解析一遍），若共用同一个带 lastIndex 的全局正则，递归会把它重置，
// 外层循环就会退回开头反复匹配同一段文字，直接把进程跑到 OOM。所以每次调用
// 都新建一个 RegExp 实例。
const INLINE_SOURCE =
  "(`+)([^`]+?)\\1" +
  "|\\*\\*([\\s\\S]+?)\\*\\*" +
  "|__([\\s\\S]+?)__" +
  "|~~([\\s\\S]+?)~~" +
  "|\\*([^*\\n]+?)\\*" +
  "|_([^_\\n]+?)_" +
  "|\\[([^\\]]*)\\]\\(([^)\\s]+)\\)";

function inline(text) {
  const out = [];
  const re = new RegExp(INLINE_SOURCE, "g");
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) out.push(el("code", null, m[2]));
    else if (m[3] !== undefined) out.push(el("strong", null, ...inline(m[3])));
    else if (m[4] !== undefined) out.push(el("strong", null, ...inline(m[4])));
    else if (m[5] !== undefined) out.push(el("del", null, ...inline(m[5])));
    else if (m[6] !== undefined) out.push(el("em", null, ...inline(m[6])));
    else if (m[7] !== undefined) out.push(el("em", null, ...inline(m[7])));
    else if (m[8] !== undefined) out.push(link(m[8], m[9]));
    last = re.lastIndex;
    // 防御：万一某个分支出现零长度匹配，也保证游标一定前进。
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function link(label, href) {
  // 只放行 http/https：javascript: / data: 一律退化成原文（连方括号一起还原，
  // 这样和没匹配上时看起来一致）。
  if (!/^https?:\/\//i.test(href)) return document.createTextNode(`[${label}](${href})`);
  return el("a", { href, target: "_blank", rel: "noreferrer noopener" }, ...inline(label));
}

// ---- 块 ----

function codeBlock(code, lang) {
  const pre = el("pre", lang ? { "data-lang": lang } : null);
  pre.append(el("code", null, code));
  return pre;
}

function listBlock(lines, start) {
  const first = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2][0]);
  const list = el(ordered ? "ol" : "ul");
  if (ordered) {
    const startNo = Number.parseInt(first[2], 10);
    if (Number.isFinite(startNo) && startNo !== 1) list.setAttribute("start", String(startNo));
  }

  let i = start;
  while (i < lines.length) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
    if (m === null) break;
    if (m[1].length !== baseIndent) break; // 更深的缩进是条目的内容，交给下面递归
    if (/\d/.test(m[2][0]) !== ordered) break; // 有序/无序切换 → 另起一个列表
    const itemLines = [m[3]];
    i += 1;
    // 续行：缩进更深的都属于这一条（嵌套列表、引用、围栏代码都靠它带进来）。
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) {
        // 空行只有后面还跟着缩进行才算本条内容，否则列表到此为止。
        if (/^\s{2,}\S/.test(lines[i + 1] ?? "")) {
          itemLines.push("");
          i += 1;
          continue;
        }
        break;
      }
      if (/^\s*/.exec(line)[0].length <= baseIndent) break;
      itemLines.push(dedent(line, baseIndent + 2));
      i += 1;
    }
    const body = itemLines.join("\n");
    const li = el("li");
    // 条目里还有块（嵌套列表等）就按块解析，否则就是一行行内文字。
    appendAll(li, body.split("\n").some(startsBlock) ? blocks(body) : inline(body.replace(/\n+/g, " ")));
    list.append(li);
  }
  return { node: list, next: i };
}

function blocks(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块：``` 或 ~~~，收尾围栏可省略（到文档末尾）
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
    if (fence !== null) {
      const close = new RegExp("^\\s{0,3}" + (fence[1][0] === "`" ? "`{3,}" : "~{3,}") + "\\s*$");
      const buf = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 吃掉收尾围栏
      nodes.push(codeBlock(buf.join("\n"), fence[2]));
      continue;
    }

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      nodes.push(el("h" + heading[1].length, null, ...inline(heading[2])));
      i += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      nodes.push(el("hr"));
      i += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      nodes.push(el("blockquote", null, ...blocks(buf.join("\n"))));
      continue;
    }

    if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(line)) {
      const parsed = listBlock(lines, i);
      nodes.push(parsed.node);
      i = parsed.next;
      continue;
    }

    // 段落：至少吃掉一行，避免块起始判定把本行原地卡住。
    const buf = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      (buf.length === 0 || !startsBlock(lines[i]))
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    nodes.push(el("p", null, ...inline(buf.join("\n"))));
  }
  return nodes;
}

/**
 * 把 Markdown 渲染进 container（会先清空）。
 * 渲染过程意外抛错时退回纯文本，宁可不好看也不能把内容吞掉。
 */
function renderMarkdown(container, source) {
  const text = typeof source === "string" ? source : "";
  try {
    container.replaceChildren(...blocks(text));
  } catch {
    container.textContent = text;
  }
}

// ---- 页面浮窗版：渲染 + 内联样式 ----
//
// 侧栏有样式表，这里没有 —— 内容脚本是 classic script，注入 <style> 又可能撞上页面
// 的 CSP，所以浮窗里的每个元素只能靠 CSSOM 逐条写行内样式。

function cardColors(dark) {
  return dark
    ? { muted: "#8b949e", border: "#3d444d", inset: "#0d1117", accent: "#8b85f0" }
    : { muted: "#6a737d", border: "#d1d9e0", inset: "#f6f8fa", accent: "#5048e4" };
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** 给一个已渲染的节点树套上浮窗样式。 */
function styleCardTree(root, dark) {
  const c = cardColors(dark);
  const all = root.querySelectorAll("*");
  for (let i = 0; i < all.length; i += 1) {
    const node = all[i];
    const s = node.style;
    const tag = node.tagName.toLowerCase();
    const isLast = node === root.lastElementChild;
    if (tag === "p") {
      s.margin = isLast ? "0" : "0 0 8px";
    } else if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
      s.margin = isLast ? "0" : "10px 0 6px";
      s.fontWeight = "650";
      s.lineHeight = "1.3";
      s.fontSize = tag === "h1" ? "1.25em" : tag === "h2" ? "1.15em" : "1.05em";
    } else if (tag === "strong") {
      s.fontWeight = "650";
    } else if (tag === "em") {
      s.fontStyle = "italic";
    } else if (tag === "del") {
      s.textDecoration = "line-through";
      s.opacity = "0.7";
    } else if (tag === "code") {
      s.fontFamily = MONO;
      s.fontSize = "0.92em";
      // 代码块里的 code 不再加底色（外层 pre 已经有一层）
      const inPre = node.parentElement !== null && node.parentElement.tagName.toLowerCase() === "pre";
      if (inPre) {
        s.background = "transparent";
        s.padding = "0";
      } else {
        s.background = c.inset;
        s.padding = "1px 4px";
        s.borderRadius = "4px";
      }
    } else if (tag === "pre") {
      s.margin = isLast ? "0" : "0 0 8px";
      s.padding = "8px 10px";
      s.background = c.inset;
      s.border = `1px solid ${c.border}`;
      s.borderRadius = "8px";
      s.overflowX = "auto";
      s.whiteSpace = "pre";
      // 卡片外壳带 word-break: break-word，会继承进来把长代码行折行；
      // 代码块要的是横向滚动，不是折行。
      s.wordBreak = "normal";
      s.overflowWrap = "normal";
      s.fontFamily = MONO;
      s.fontSize = "0.92em";
      s.lineHeight = "1.45";
    } else if (tag === "ul" || tag === "ol") {
      s.margin = isLast ? "0" : "0 0 8px";
      s.paddingLeft = "20px";
    } else if (tag === "li") {
      s.margin = "2px 0";
    } else if (tag === "blockquote") {
      s.margin = isLast ? "0" : "0 0 8px";
      s.paddingLeft = "9px";
      s.borderLeft = `3px solid ${c.border}`;
      s.color = c.muted;
    } else if (tag === "hr") {
      s.border = "0";
      s.borderTop = `1px solid ${c.border}`;
      s.margin = "10px 0";
    } else if (tag === "a") {
      s.color = c.accent;
      s.textDecoration = "underline";
    }
  }
}

/**
 * 浮窗用的渲染：渲染 + 套样式。
 * @param container 目标元素
 * @param source Markdown 文本
 * @param dark 是否深色主题
 */
function renderMarkdownForCard(container, source, dark) {
  renderMarkdown(container, source);
  try {
    styleCardTree(container, dark === true);
  } catch {}
}

// 内容脚本是 classic script（MV3 不支持模块化内容脚本），不能 import 本文件；
// 所以这里既不用 export，也不只服务模块 —— 挂到 globalThis 让两条路径都能用：
//   - 侧栏 sidepanel.js：`import "./md.js"` 副作用导入后从 globalThis 取
//   - 内容脚本 selection.js：manifest 里排在前面直接注入，同样从 globalThis 取
globalThis.dshInsightMd = { renderMarkdown, renderMarkdownForCard };
