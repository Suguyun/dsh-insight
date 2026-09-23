#!/usr/bin/env node
// 跑 tests/ 下所有 test-*.mjs 并汇总。
//
//   node tests/run.mjs
//
// 每个套件都是自包含的：自带 DOM / chrome API 打桩，直接 import 仓库里的源码，
// 用断言计数决定退出码。有失败时本 runner 以非 0 退出。
//
// 少数套件直接测 host/ 侧的插件（host/insight.js），需要 dsh 的
// @deepseek-ai/dsh-llm 能被解析到 —— 在没装 dsh 的裸克隆里它们会打印 SKIP 并
// 计为跳过，而不是算失败。

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .sort();

let passed = 0;
let skipped = 0;
const failed = [];

for (const file of files) {
  const run = spawnSync(process.execPath, [join(here, file)], { encoding: "utf8" });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const lines = output.split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "";
  const isSkip = /^SKIP/m.test(output);
  const name = file.padEnd(28);

  if (isSkip) {
    skipped += 1;
    console.log(`⏭  ${name} ${last}`);
  } else if (run.status === 0) {
    passed += 1;
    console.log(`✔  ${name} ${last}`);
  } else {
    failed.push(file);
    console.log(`✘  ${name} ${last}`);
    for (const line of lines.filter((l) => /FAIL|Error|error:/.test(l)).slice(0, 8)) {
      console.log(`     ${line.trim()}`);
    }
  }
}

console.log(
  `\n${passed} 通过 / ${failed.length} 失败 / ${skipped} 跳过（共 ${files.length} 个套件）`,
);
if (failed.length > 0) {
  console.log(`失败的套件：${failed.join(", ")}`);
}
process.exit(failed.length > 0 ? 1 : 0);
