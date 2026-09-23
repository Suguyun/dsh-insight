#!/usr/bin/env node
// dsh-insight CLI — cross-platform installer for the Chrome extension half of
// this package. The dsh host plugins are wired separately and natively with
//   dsh plugin --profile web add dsh-insight
// so this CLI only manages the unpacked extension files that Chrome needs to
// load in developer mode.
//
// Commands (no argument = install):
//   dsh-insight install     copy the bundled extension/ to a stable per-user
//                          directory and print the chrome://extensions steps.
//                          This COPIES: after editing extension/ you must
//                          re-run install and reload the extension in Chrome.
//   dsh-insight path        print that directory (nothing else)
//   dsh-insight uninstall   remove that directory (alias: remove)
//   dsh-insight help        this text

import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { homedir, platform } from "node:os";
import fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const extensionSrc = join(pkgRoot, "extension");

/** Use an env-provided dir only if it's an absolute path (per XDG spec); else fall back. */
function absEnv(name, fallback) {
  const v = process.env[name];
  return v && isAbsolute(v) ? v : fallback;
}

/** Stable per-user directory Chrome will load the unpacked extension from. */
function targetDir() {
  if (platform() === "win32") {
    const base = absEnv("LOCALAPPDATA", join(homedir(), "AppData", "Local"));
    return join(base, "dsh-insight", "extension");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "dsh-insight", "extension");
  }
  const base = absEnv("XDG_DATA_HOME", join(homedir(), ".local", "share"));
  return join(base, "dsh-insight", "extension");
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
}

function install() {
  if (!fs.existsSync(join(extensionSrc, "manifest.json"))) {
    console.error(`error: bundled extension not found at ${extensionSrc}`);
    console.error("This command must run from an installed dsh-insight package.");
    process.exit(1);
  }
  const dst = targetDir();
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dirname(dst), { recursive: true });
  fs.cpSync(extensionSrc, dst, { recursive: true });

  console.log(`dsh-insight ${readVersion()} — extension installed.\n`);
  console.log(`  Unpacked extension copied to:\n    ${dst}\n`);
  console.log("Next steps:");
  console.log("  1. Make sure `dsh web` is running (default http://127.0.0.1:3080).");
  console.log("     If you have not added the host plugins yet, run once:");
  console.log("       dsh plugin --profile web add dsh-insight");
  console.log("     then refresh the browser (dsh hot-applies new plugin rows).");
  console.log("  2. Open chrome://extensions, turn on Developer mode,");
  console.log('     click "Load unpacked", and select the directory above.');
  console.log("  3. Click the dsh-insight toolbar icon to open the side panel.\n");
  console.log("Re-run `dsh-insight install` after upgrading the package to refresh these files.");
}

function uninstall() {
  const dst = targetDir();
  if (fs.existsSync(dst)) {
    fs.rmSync(dst, { recursive: true, force: true });
    console.log(`Removed ${dst}`);
  } else {
    console.log(`Nothing to remove at ${dst}`);
  }
  console.log("Also remove the extension in chrome://extensions, and run");
  console.log("  dsh plugin --profile web remove dsh-insight");
  console.log("to unwire the host plugins.");
}

function help() {
  console.log(`dsh-insight ${readVersion()}

Usage:
  dsh-insight install     copy the extension to a per-user dir and print setup steps
  dsh-insight path        print that directory
  dsh-insight uninstall   remove that directory
  dsh-insight help        show this help

The dsh host plugins are managed separately:
  dsh plugin --profile web add dsh-insight`);
}

const cmd = (process.argv[2] || "install").toLowerCase();
switch (cmd) {
  case "install":
    install();
    break;
  case "path":
    console.log(targetDir());
    break;
  case "uninstall":
  case "remove":
    uninstall();
    break;
  case "help":
  case "-h":
  case "--help":
    help();
    break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    help();
    process.exit(1);
}
