// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
let mod;
try {
  mod = await import(pathToFileURL(`${REPO_ROOT}/host/insight.js`).href);
} catch (err) {
  if (err?.code === "ERR_MODULE_NOT_FOUND" && /@deepseek-ai\/dsh-/.test(err.message)) {
    console.log("SKIP  本套件直接测 host/insight.js，需要 dsh 的 @deepseek-ai/dsh-llm。");
    console.log("      请在装好 dsh 的环境里运行，或把本仓库装进某个 dsh profile 后再跑。");
    process.exit(0);
  }
  throw err;
}

let route = null;
let captured = null;
// 注意：插件里用的是 ctx.llm 这个「服务属性」（Cordis 按 inject 注入），
// 不是 ctx.get("llm")；两个都得给。
const llmService = { stream: (opts) => { captured = opts; return (async function* () {
  yield { type: "text-delta", text: "**回答**" };
  yield { type: "finish", reason: { kind: "stop" } };
})(); } };
const ctx = {
  effect: (fn) => { fn(); },
  webServer: { register: (r) => { route = r; return () => {}; } },
  llm: llmService,
  get: (n) => {
    if (n === "llm") return llmService;
    if (n === "agentDefaultModel") return { currentSelection: () => ({ provider: "p", model: "m" }) };
    return undefined;
  },
};
mod.apply(ctx);

function makeReq(body) {
  const handlers = {};
  const req = {
    method: "POST",
    headers: { host: "127.0.0.1:3080", origin: "chrome-extension://abc" },
    socket: { remoteAddress: "127.0.0.1" },
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
  };
  setTimeout(() => {
    for (const fn of handlers.data || []) fn(Buffer.from(JSON.stringify(body)));
    for (const fn of handlers.end || []) fn();
  }, 0);
  return req;
}
function makeRes() { return { headersSent: false, writeHead() {}, end(b) { this.body = b; } }; }

async function post(body) {
  captured = null;
  const res = makeRes();
  route.handler(makeReq(body), res);
  await new Promise((r) => setTimeout(r, 120));
  return { res, parsed: res.body ? JSON.parse(res.body) : null };
}

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };

console.log("1) 单轮（无 history）—— 必须与改动前一致");
let r = await post({ text: "选中的文字", url: "https://e.com/p", title: "T" });
check("返回 ok 与正文", r.parsed?.ok === true && r.parsed.text === "**回答**", JSON.stringify(r.parsed));
check("messages 只有 1 条 user", captured.messages.length === 1 && captured.messages[0].role === "user");
check("system 不含讨论补充", !captured.system.includes("追问讨论"), captured.system.slice(-40));

console.log("2) 带 history —— 角色与顺序正确");
r = await post({
  text: "选中的文字", url: "https://e.com/p", title: "T",
  history: [
    { role: "assistant", text: "首次解读" },
    { role: "user", text: "为什么这么说？" },
  ],
});
check("messages 共 3 条", captured.messages.length === 3, String(captured.messages.length));
check("角色顺序 user/assistant/user",
  captured.messages.map((m) => m.role).join(",") === "user,assistant,user",
  captured.messages.map((m) => m.role).join(","));
check("第 1 条是选区", captured.messages[0].content[0].text.includes("选中的文字"));
check("第 2 条是上次解读", captured.messages[1].content[0].text === "首次解读");
check("第 3 条是本次追问", captured.messages[2].content[0].text === "为什么这么说？");
check("assistant 消息带 model source", captured.messages[1].source?.kind === "model", JSON.stringify(captured.messages[1].source));
check("system 追加了讨论补充", captured.system.includes("追问讨论"), captured.system.slice(-60));

console.log("3) 脏历史被过滤");
r = await post({
  text: "x",
  history: [
    { role: "system", text: "越权" },
    { role: "user", text: "" },
    "垃圾",
    null,
    { role: "user", text: "合法的一问" },
  ],
});
check("只剩 1 轮合法历史", captured.messages.length === 2, String(captured.messages.length));
check("过滤后是 user 追问", captured.messages[1].role === "user" && captured.messages[1].content[0].text === "合法的一问");

console.log("4) 历史超长被截断");
const many = Array.from({ length: 40 }, (_, i) => ({ role: "user", text: `q${i}` }));
r = await post({ text: "x", history: many });
check("只保留最近 16 轮", captured.messages.length === 17, String(captured.messages.length));
check("保留的是最后 16 条", captured.messages[16].content[0].text === "q39", captured.messages[16].content[0].text);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
