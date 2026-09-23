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
const ctx = {
  effect: (fn) => { fn(); },
  webServer: { register: (r) => { route = r; return () => {}; } },
  get: (n) => (n === "llm" || n === "agentDefaultModel" ? {} : undefined),
};
mod.apply(ctx);
console.log("注册的路由:", route?.path, "| kind:", route?.kind);

let body = "";
const res = { headersSent: false, writeHead() {}, end(b) { body = b; } };
route.handler({ method: "GET" }, res);
await new Promise((r) => setTimeout(r, 30));

const payload = JSON.parse(body);
let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };

check("GET 返回 ok", payload.ok === true);
check("6 套口径齐全", payload.presets.length === 6, String(payload.presets?.length));
check("maxSystem = 4000", payload.maxSystem === 4000, String(payload.maxSystem));

console.log("\n逐套检查：");
for (const p of payload.presets) {
  const md = p.system.includes("Markdown");
  // tldr 用的是自己的克制版措辞，其余都走共用的 MD_RULES
  const noTable = /不要表格|不要用表格/.test(p.system);
  const len = p.system.length;
  const under = len < payload.maxSystem;
  const line = `  ${(md && noTable && under) ? "ok  " : "FAIL"} ${p.id.padEnd(10)} len=${String(len).padStart(4)} 提到Markdown=${md} 禁表格=${noTable} 不超限=${under}`;
  console.log(line);
  if (md && noTable && under) pass++; else fail++;
}

console.log("\n--- 你当前在用的 tldr 新版全文 ---");
console.log(payload.presets.find((p) => p.id === "tldr").system);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
