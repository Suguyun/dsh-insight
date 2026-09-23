// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const URL_ = pathToFileURL(`${SRC_DIR}/sidepanel.js`).href;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("unhandledRejection", () => {});

class El {
  constructor(id) { this.id = id; this.hidden = false; this.textContent = ""; this.dataset = {}; this.title = ""; this.src = ""; this.handlers = {}; }
  addEventListener(t, h) { (this.handlers[t] ||= []).push(h); }
  fire(t) { for (const h of this.handlers[t] || []) h({ preventDefault() {}, stopPropagation() {} }); }
}
const els = new Map();
const openOptionsCalls = [];
const posted = [];
globalThis.document = {
  getElementById: (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
  documentElement: { style: { setProperty() {} } },
};
globalThis.window = { location: { search: "" } };
globalThis.chrome = {
  runtime: {
    connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage: (m) => posted.push(m) }),
    openOptionsPage: () => openOptionsCalls.push(1),
  },
  storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
};

await import(URL_);
await tick(60);

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${extra}`); } };
const el = (id) => els.get(id);

console.log("1) 初始：划词解读");
check("insight 可见", el("insight").hidden === false);
check("设置页隐藏且未预加载", el("optionsFrame").hidden === true && el("optionsFrame").src === "");
check("「设置」按钮文案", el("settings").textContent === "设置");
check("不存在 dsh 界面按钮 / dshFrame", els.get("toggleGui") === undefined && els.get("dshFrame") === undefined);

console.log("2) 点「设置」→ 内嵌设置页");
el("settings").fire("click");
await tick(20);
check("设置可见、解读隐藏", el("optionsFrame").hidden === false && el("insight").hidden === true);
check("按需载入 embed=1", el("optionsFrame").src === "options.html?embed=1", el("optionsFrame").src);
check("按钮变「返回解读」", el("settings").textContent === "返回解读");
check("没有跳独立选项页", openOptionsCalls.length === 0);

console.log("3) 再点一次 → 回到划词解读");
el("settings").fire("click");
await tick(20);
check("回 insight", el("insight").hidden === false && el("optionsFrame").hidden === true);
check("按钮复原", el("settings").textContent === "设置");

console.log("4) 停止抓包按钮仍然工作");
el("stopCapture").fire("click");
check("向 service worker 发了 capture-stop", posted.some((m) => m.type === "capture-stop"), JSON.stringify(posted));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
