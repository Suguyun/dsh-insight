#!/usr/bin/env node
// dsh-insight CLI — cross-platform installer for the browser-extension half of
// this package. The dsh host plugins are wired separately and natively with
//   dsh plugin --profile web add dsh-insight
// so this CLI only manages the unpacked extension files that Chrome/Edge needs
// to load in developer mode.
//
// Commands (no argument = install):
//   dsh-insight install     copy the bundled extension to a stable per-user
//                          directory and print the load steps. manifest.json
//                          sits at the ROOT of that directory, so it is exactly
//                          what you hand to "Load unpacked".
//                          This COPIES: after editing extension/ you must
//                          re-run install and reload the extension in Chrome.
//   dsh-insight path        print that directory (nothing else)
//   dsh-insight uninstall   remove that directory (alias: remove)
//   dsh-insight help        this text
//
// Layout note: the target IS the package-named directory — there is deliberately
// no extra `extension/` level. Upstream dsh-chrome nested it under `extension/`,
// which makes it easy to pick the parent in the "Load unpacked" dialog and get a
// confusing "manifest file is missing or unreadable" error.

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

/**
 * Stable per-user directory the browser loads the unpacked extension from.
 * manifest.json sits at its ROOT: this exact directory is the one to select in
 * the "Load unpacked" dialog.
 */
function targetDir() {
  const name = "dsh-insight";
  if (platform() === "win32") {
    return join(absEnv("LOCALAPPDATA", join(homedir(), "AppData", "Local")), name);
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", name);
  }
  return join(absEnv("XDG_DATA_HOME", join(homedir(), ".local", "share")), name);
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

  // Self-check: if the destination already existed as a directory, cpSync would
  // have nested the payload one level down — which is exactly the trap this
  // layout is meant to avoid. Fail loudly instead of printing a bogus path.
  if (!fs.existsSync(join(dst, "manifest.json"))) {
    console.error(`error: install finished but ${join(dst, "manifest.json")} does not exist.`);
    console.error("Remove the destination directory and re-run `dsh-insight install`.");
    process.exit(1);
  }

  console.log(`dsh-insight ${readVersion()} — extension installed.\n`);
  console.log('Load this directory in chrome://extensions → "Load unpacked":\n');
  console.log(`    ${dst}\n`);
  console.log("  manifest.json is at the root of that directory — select it, not its parent.\n");
  console.log("Next steps:");
  console.log("  1. Make sure `dsh web` is running (default http://127.0.0.1:3080).");
  console.log("     If you have not added the host plugins yet, run once:");
  console.log("       dsh plugin --profile web add dsh-insight");
  console.log("     then restart dsh so the new plugin rows load.");
  console.log("  2. Open chrome://extensions (Edge: edge://extensions), turn on Developer");
  console.log('     mode, click "Load unpacked", and select the directory printed above.');
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
