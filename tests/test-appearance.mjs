// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";
const m = await import(pathToFileURL(`${SRC_DIR}/appearance.js`).href);

function varsFor(bg, fontSize) {
  const out = {};
  const root = { style: { setProperty: (k, v) => { out[k] = v; } } };
  m.applyAppearance({ bg, fontSize }, root);
  return out;
}

for (const bg of ["#0d1117", "#ffffff", "#f5f0e1", "#1b2430", "bad-input"]) {
  const v = varsFor(bg, 13);
  console.log(`bg=${bg.padEnd(9)} bg->${v["--panel-bg"]} fg=${v["--panel-fg"]} surface=${v["--panel-surface"]} border=${v["--panel-border"]} muted=${v["--panel-muted"]} accent=${v["--panel-accent"]}`);
}
console.log("--- 字号钳制 ---");
for (const size of [13, 11, 20, 3, 99, "abc", undefined]) {
  console.log(`  in=${String(size).padEnd(9)} -> ${varsFor("#0d1117", size)["--panel-font-size"]}`);
}
