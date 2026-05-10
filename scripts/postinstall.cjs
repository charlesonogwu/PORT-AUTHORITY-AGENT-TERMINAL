#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * npm postinstall hook — wires up the desktop icon, the Start Menu entry,
 * and the Windows-login autostart for portpilot. Runs automatically after
 * `npm install -g port-authority-agent-terminal-mcp` (or local install).
 *
 * Why CommonJS (.cjs): npm runs `postinstall` via `node`, not via tsx, and
 * the package's own `dist/` may not be on disk at this point during the
 * very first install. We use plain Node CommonJS so this works with no
 * compilation step required.
 *
 * Skip rules:
 *   - Non-Windows: silently skip (paat is Windows-first; nothing to wire).
 *   - PAAT_SKIP_POSTINSTALL=1 in env: skip everything (CI / sandboxed users).
 *   - npm_config_global !== "true" AND not invoked from the package root:
 *     skip — running postinstall from a transitive dependency is a footgun.
 *   - Failures: log + exit 0 so a broken postinstall doesn't break npm.
 */

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

function log(msg) {
  process.stdout.write(`[paat postinstall] ${msg}\n`);
}

function warn(msg) {
  process.stdout.write(`[paat postinstall] ⚠ ${msg}\n`);
}

function shouldSkip() {
  if (process.platform !== "win32") return "non-Windows platform";
  if (process.env.PAAT_SKIP_POSTINSTALL === "1") return "PAAT_SKIP_POSTINSTALL=1";
  if (process.env.CI === "true") return "running in CI";
  // PAAT_PREPARE_RUNNING is set by scripts/prepare.cjs when it kicks off
  // a nested `npm install` to repair missing devDependencies. That nested
  // install fires postinstall too, but we only want to wire shortcuts at
  // the FINAL global install — not during the prepare-time devdeps repair.
  if (process.env.PAAT_PREPARE_RUNNING === "1") return "nested prepare-time install";
  // Skip when installed as a transitive dep of someone else's project.
  // npm sets npm_config_global=true for `npm i -g`. We also allow a direct
  // local install of THIS package (when developing — package root has our
  // package.json with this name).
  const isGlobal = process.env.npm_config_global === "true";
  const ourName = "port-authority-agent-terminal-mcp";
  let isLocalSelf = false;
  try {
    const cwdPkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    if (cwdPkg && cwdPkg.name === ourName) isLocalSelf = true;
  } catch { /* no package.json — likely npm i -g */ }
  if (!isGlobal && !isLocalSelf) return "transitive install";
  return null;
}

function findCli() {
  // dist/src/cli/index.js relative to this script
  const here = __dirname;
  const candidates = [
    path.join(here, "..", "dist", "src", "cli", "index.js"),
    // When installed globally, npm puts the package at:
    // %AppData%\npm\node_modules\port-authority-agent-terminal-mcp\dist\src\cli\index.js
    path.join(here, "..", "..", "port-authority-agent-terminal-mcp", "dist", "src", "cli", "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function run(cliJs, args) {
  const r = spawnSync(process.execPath, [cliJs, ...args], { stdio: "inherit", windowsHide: true });
  return r.status === 0;
}

function main() {
  const skip = shouldSkip();
  if (skip) {
    // Silent for non-Windows / transitive — too noisy otherwise.
    return;
  }

  const cliJs = findCli();
  if (!cliJs) {
    warn("could not locate dist/src/cli/index.js — skipping shortcut + autostart wiring.");
    warn("run `paat shortcut install` and `paat autostart install` manually after build.");
    return;
  }

  log("Setting up Windows shortcuts…");
  const shortcutOk = run(cliJs, ["shortcut", "install"]);
  if (!shortcutOk) warn("shortcut install failed — try `paat shortcut install` manually.");

  log("Enabling Windows-login autostart…");
  const autoOk = run(cliJs, ["autostart", "install"]);
  if (!autoOk) warn("autostart install failed — try `paat autostart install` manually.");

  if (shortcutOk && autoOk) {
    log("Done. portpilot will start when you log in. Open the dashboard with `portpilot` or `paat dashboard`.");
  }
}

try {
  main();
} catch (err) {
  warn("postinstall threw: " + (err && err.message ? err.message : String(err)));
  // Never fail the npm install over postinstall hiccups.
  process.exit(0);
}
