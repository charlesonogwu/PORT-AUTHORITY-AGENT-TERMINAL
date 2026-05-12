#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * npm postinstall hook — wires up the desktop icon, the Start Menu entry,
 * the Windows-login autostart, AND the MCP integrations (Claude Desktop,
 * Codex Desktop, Claude Code CLI) for portpilot. Runs automatically after
 * `npm install -g port-authority-agent-terminal-mcp` (or local install).
 *
 * Goal: a single `npm install -g` is all the user has to do. They don't
 * need to also remember `paat install-mcp` afterwards.
 *
 * Why CommonJS (.cjs): npm runs `postinstall` via `node`, not via tsx, and
 * the package's own `dist/` may not be on disk at this point during the
 * very first install. We use plain Node CommonJS so this works with no
 * compilation step required.
 *
 * Skip rules:
 *   - Non-Windows: silently skip (paat is Windows-first; nothing to wire).
 *   - PAAT_SKIP_POSTINSTALL=1 in env: skip everything (CI / sandboxed users).
 *   - PAAT_INSTALL_MCP=1 in env: opt in to MCP wire-up during install.
 *     By default npm install does not modify AI client MCP configs.
 *   - PAAT_SKIP_INSTALL_MCP=1 in env: skip ONLY the MCP wire-up step.
 *     Useful for explicit defense-in-depth even when PAAT_INSTALL_MCP=1.
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

  // Optionally wire MCP integrations. This writes:
  //   - %APPDATA%\Claude\claude_desktop_config.json    (Claude Desktop)
  //   - ~/.codex/config.toml                            (Codex Desktop)
  //   - ~/.claude.json                                  (Claude Code, via `claude mcp add`)
  // Skipped clients (e.g. Claude Code when `claude` is not on PATH) print
  // as "skipped" and don't count as failures.
  //
  // This is opt-in because npm postinstall runs during package installation;
  // installing a CLI should not silently grant it MCP access in unrelated AI
  // clients. Users can run `paat install-mcp` later, or set PAAT_INSTALL_MCP=1.
  let mcpOk = true;
  if (process.env.PAAT_SKIP_INSTALL_MCP === "1") {
    log("Skipping MCP wire-up (PAAT_SKIP_INSTALL_MCP=1).");
  } else if (process.env.PAAT_INSTALL_MCP === "1") {
    log("Wiring PAAT into Claude Desktop / Codex Desktop / Claude Code…");
    mcpOk = run(cliJs, ["install-mcp"]);
    if (!mcpOk) warn("install-mcp returned a non-zero status — re-run `paat install-mcp` manually.");
  } else {
    log("Skipping MCP wire-up by default. Run `paat install-mcp` or set PAAT_INSTALL_MCP=1 to opt in.");
  }

  if (shortcutOk && autoOk && mcpOk) {
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
