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
 *   - PAAT_SKIP_INSTALL_MCP=1 in env: skip ONLY the MCP wire-up step.
 *     Useful if the user wants the binary but not auto-MCP registration.
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

/**
 * Locate the bundled bin/paat-launcher.exe inside the installed package, then
 * copy it to a stable location at %LOCALAPPDATA%\PAAT\paat-launcher.exe so the
 * Desktop / Start Menu shortcuts can point at it. We avoid pointing the
 * shortcuts at the npm-install location directly because that path changes
 * per global vs local install and per Node version.
 *
 * Returns the destination path on success, or null if either the source .exe
 * isn't bundled (shouldn't happen for a published package) or the copy failed.
 */
function installLauncherExe() {
  const here = __dirname;
  const sourceCandidates = [
    path.join(here, "..", "bin", "paat-launcher.exe"),
    path.join(here, "..", "..", "port-authority-agent-terminal-mcp", "bin", "paat-launcher.exe"),
  ];
  let source = null;
  for (const c of sourceCandidates) {
    if (fs.existsSync(c)) {
      source = c;
      break;
    }
  }
  if (!source) {
    warn("could not find bundled bin/paat-launcher.exe — shortcuts will fall back to the PowerShell launcher.");
    return null;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    warn("LOCALAPPDATA env var not set — cannot install launcher .exe.");
    return null;
  }
  const destDir = path.join(localAppData, "PAAT");
  const destPath = path.join(destDir, "paat-launcher.exe");

  try {
    fs.mkdirSync(destDir, { recursive: true });
    // Try to delete an existing copy first — Windows refuses to overwrite a
    // .exe that's currently running. On failure (because the launcher IS
    // running), the copyFileSync will throw EBUSY, which we catch below.
    if (fs.existsSync(destPath)) {
      try { fs.rmSync(destPath, { force: true }); } catch { /* ignore — handled below */ }
    }
    fs.copyFileSync(source, destPath);
    return destPath;
  } catch (err) {
    if (err && err.code === "EBUSY") {
      warn("paat-launcher.exe is currently running — close it before upgrading. Using the previously-installed copy.");
      // The old .exe is still in place and still works; this isn't fatal.
      return destPath;
    }
    warn("failed to install launcher .exe: " + (err && err.message ? err.message : String(err)));
    return null;
  }
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

  // Stage the native launcher .exe into %LOCALAPPDATA%\PAAT\ FIRST, so that
  // `paat shortcut install` can find it and point the .lnk at it directly
  // (no PowerShell middleman).
  const launcherExe = installLauncherExe();
  if (launcherExe) {
    log(`Installed native launcher: ${launcherExe}`);
  }

  log("Setting up Windows shortcuts…");
  const shortcutOk = run(cliJs, ["shortcut", "install"]);
  if (!shortcutOk) warn("shortcut install failed — try `paat shortcut install` manually.");

  log("Enabling Windows-login autostart…");
  const autoOk = run(cliJs, ["autostart", "install"]);
  if (!autoOk) warn("autostart install failed — try `paat autostart install` manually.");

  // Auto-wire the MCP integrations so the user doesn't have to remember to
  // run `paat install-mcp` separately. This writes:
  //   - %APPDATA%\Claude\claude_desktop_config.json    (Claude Desktop)
  //   - ~/.codex/config.toml                            (Codex Desktop)
  //   - ~/.claude.json                                  (Claude Code, via `claude mcp add`)
  // Skipped clients (e.g. Claude Code when `claude` is not on PATH) print
  // as "skipped" and don't count as failures.
  let mcpOk = true;
  if (process.env.PAAT_SKIP_INSTALL_MCP === "1") {
    log("Skipping MCP wire-up (PAAT_SKIP_INSTALL_MCP=1).");
  } else {
    log("Wiring PAAT into Claude Desktop / Codex Desktop / Claude Code…");
    mcpOk = run(cliJs, ["install-mcp"]);
    if (!mcpOk) warn("install-mcp returned a non-zero status — re-run `paat install-mcp` manually.");
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
