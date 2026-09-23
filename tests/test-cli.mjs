// 安装器（bin/cli.js）的回归测试。
//
// 锁住一个具体的历史陷阱：扩展安装目录**多嵌套一层** `extension/`，导致
// 「加载已解压的扩展程序」对话框里很自然会选中名字更像产品名的上一层，然后报
// 「清单文件丢失或不可读取」。上游 dsh-chrome 就是 `<base>/dsh-chrome/extension`。
//
// 这里只做**无副作用**的断言：不真的往用户目录里装东西，只检查
//   1) `dsh-insight path` 给出的目录本身就该是「含 manifest.json 的那一层」；
//   2) 被复制的源 `extension/` 的根部确实有 manifest.json。
//
// 之所以 1) 足以推出结论：cli.js 是把 `extension/` 的内容复制到该目录里
// （cpSync(src, dst) 且 dst 先被删除），源目录根部有清单，则目标根部必然有清单。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? "" : `  ${detail}`}`);
  }
}

const cli = join(REPO_ROOT, "bin", "cli.js");

// 1) path 命令输出的目录形态
const out = execFileSync(process.execPath, [cli, "path"], { encoding: "utf8" }).trim();
check("path 输出非空", out.length > 0, out);
check("path 目录以 dsh-insight 结尾（不再嵌套 extension/）", basename(out) === "dsh-insight", out);
check("path 不含多余的 extension 层级", !/[/\\]extension$/.test(out), out);
check("path 是绝对路径", out.startsWith("/") || /^[A-Za-z]:/.test(out), out);

// 2) 被复制的源目录根部必须有清单 —— 否则复制过去目标根部也不会有
const srcManifest = join(REPO_ROOT, "extension", "manifest.json");
check("源 extension/manifest.json 存在", existsSync(srcManifest), srcManifest);

const manifest = JSON.parse(readFileSync(srcManifest, "utf8"));
check("清单 name 为 dsh-insight", manifest.name === "dsh-insight", String(manifest.name));
check("清单 version 存在", typeof manifest.version === "string" && manifest.version.length > 0);

// 3) help 与未知命令的退出码
const help = execFileSync(process.execPath, [cli, "help"], { encoding: "utf8" });
check("help 提到 install", help.includes("install"));
check("help 提到宿主侧安装方式", help.includes("dsh plugin --profile web add dsh-insight"));

let badExit = 0;
try {
  execFileSync(process.execPath, [cli, "definitely-not-a-command"], { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  badExit = e.status;
}
check("未知命令以非 0 退出", badExit !== 0, String(badExit));

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length > 0) process.exit(1);
