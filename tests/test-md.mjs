// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";

class Node {}
class TextNode extends Node { constructor(t) { super(); this.text = String(t); } }
class Elem extends Node {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...cs) { for (const c of cs) if (c != null) this.children.push(c); }
  replaceChildren(...cs) { this.children = []; this.append(...cs); }
  set textContent(v) { this.children = [new TextNode(v)]; }
}
globalThis.Node = Node;
globalThis.document = {
  createElement: (t) => new Elem(t),
  createTextNode: (t) => new TextNode(t),
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function ser(n) {
  if (n instanceof TextNode) return esc(n.text);
  const inner = n.children.map(ser).join("");
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}

const { renderMarkdown } = await import(
  pathToFileURL(`${SRC_DIR}/md.js`).href
);

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

const root = new Elem("div");
renderMarkdown(root, sample);
console.log(ser(root).replace(/></g, ">\n<"));
