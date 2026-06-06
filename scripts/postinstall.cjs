#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * npm postinstall hook — stages the dashboard binary for portpilot.
 * Runs automatically after `npm install -g port-authority-agent-terminal-mcp`
 * (or local install), but does not modify MCP client configs or enable
 * login autostart unless the user explicitly opts in with environment flags.
 *
 * Per-platform behavior:
 *   Windows: stage bin/paat-dashboard.exe → %LOCALAPPDATA%\PAAT\.
 *            Desktop shortcut / Start Menu entries are created only when
 *            PAAT_INSTALL_SHORTCUTS=1 is set, and login autostart only when
 *            PAAT_INSTALL_AUTOSTART=1 is set.
 *   macOS:   if bin/paat-dashboard-darwin-<arch> is bundled, stage it to
 *            ~/.portpilot/bin/paat-dashboard. If missing AND cargo is on
 *            PATH, build from source via scripts/build-dashboard-tauri.cjs.
 *            Otherwise warn the user that they need Rust installed.
 *            Shortcut + autostart are skipped (not implemented on macOS yet).
 *   Linux:   same as macOS.
 *
 * Why CommonJS (.cjs): npm runs `postinstall` via `node`, not tsx, and
 * the package's own `dist/` may not be on disk at this point during the
 * very first install.
 *
 * Skip rules:
 *   - PAAT_SKIP_POSTINSTALL=1: skip everything (CI / sandboxed users).
 *   - PAAT_INSTALL_MCP=1: opt in to MCP wire-up during postinstall.
 *   - PAAT_INSTALL_SHORTCUTS=1: opt in to Windows shortcut creation.
 *   - PAAT_INSTALL_AUTOSTART=1: opt in to Windows login autostart.
 *   - PAAT_PREPARE_RUNNING=1: nested install during prepare — skip.
 *   - npm_config_global !== "true" AND not invoked from package root:
 *     skip — running postinstall from a transitive dep is a footgun.
 *   - Failures: log + exit 0 so a broken postinstall doesn't break npm.
 */

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

function log(msg) { process.stdout.write(`[paat postinstall] ${msg}\n`); }
function warn(msg) { process.stdout.write(`[paat postinstall] ⚠ ${msg}\n`); }

function shouldSkip() {
  if (process.env.PAAT_SKIP_POSTINSTALL === "1") return "PAAT_SKIP_POSTINSTALL=1";
  if (process.env.CI === "true") return "running in CI";
  if (process.env.PAAT_PREPARE_RUNNING === "1") return "nested prepare-time install";
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
  const here = __dirname;
  const candidates = [
    path.join(here, "..", "dist", "src", "cli", "index.js"),
    path.join(here, "..", "..", "port-authority-agent-terminal-mcp", "dist", "src", "cli", "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function packageRoot() {
  // Walk up from __dirname looking for our package.json. Handles both
  // dev-checkout and npm-global install locations.
  const here = __dirname;
  const candidates = [
    path.resolve(here, ".."),
    path.resolve(here, "..", ".."),
  ];
  for (const c of candidates) {
    const pj = path.join(c, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pj, "utf8"));
        if (parsed && parsed.name === "port-authority-agent-terminal-mcp") return c;
      } catch { /* ignore */ }
    }
  }
  return path.resolve(here, "..");
}

function bundledBinaryName() {
  if (process.platform === "win32") return "paat-dashboard.exe";
  if (process.platform === "darwin") return `paat-dashboard-darwin-${process.arch}`;
  return `paat-dashboard-linux-${process.arch}`;
}

function stagedBinaryName() {
  return process.platform === "win32" ? "paat-dashboard.exe" : "paat-dashboard";
}

function stagedBinaryDir() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return path.join(localAppData, "PAAT");
  }
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".portpilot", "bin");
}

function findBundledBinary(pkgRoot) {
  const name = bundledBinaryName();
  const candidate = path.join(pkgRoot, "bin", name);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Stage the dashboard binary into a stable per-user location. Returns the
 * staged path on success, or null if no source binary could be located AND
 * the macOS/Linux build-from-source fallback failed.
 */
function installDashboardBinary(pkgRoot) {
  let source = findBundledBinary(pkgRoot);

  // macOS/Linux: if no prebuilt binary is shipped, build from source if the
  // Rust toolchain is available. Windows ships a committed .exe so this
  // branch is Mac/Linux-only.
  if (!source && process.platform !== "win32") {
    const buildScript = path.join(pkgRoot, "scripts", "build-dashboard-tauri.cjs");
    if (fs.existsSync(buildScript)) {
      log(`no prebuilt ${bundledBinaryName()} bundled — attempting to build from source…`);
      log("(this requires Rust + the platform's webview2/wkwebview/webkitgtk runtime)");
      const build = spawnSync(process.execPath, [buildScript], {
        cwd: pkgRoot,
        stdio: "inherit",
      });
      if (build.status === 0) {
        source = findBundledBinary(pkgRoot);
      } else {
        warn(`build-dashboard-tauri failed (exit ${build.status}).`);
      }
    }
    if (!source) {
      warn(`could not produce a dashboard binary for ${process.platform}/${process.arch}.`);
      warn("Install Rust from https://rustup.rs then re-run `npm install -g port-authority-agent-terminal-mcp`,");
      warn("OR build manually: `cd gui && cargo tauri build --no-bundle`.");
      warn("You can still use the CLI/MCP without the dashboard.");
      return null;
    }
  }

  if (!source) {
    warn(`bundled ${bundledBinaryName()} not found in package — dashboard binary will not be staged.`);
    return null;
  }

  const destDir = stagedBinaryDir();
  const destPath = path.join(destDir, stagedBinaryName());
  try {
    fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(destPath)) {
      try { fs.rmSync(destPath, { force: true }); } catch { /* may be locked */ }
    }
    fs.copyFileSync(source, destPath);
    if (process.platform !== "win32") {
      try { fs.chmodSync(destPath, 0o755); } catch { /* ignore */ }
    }
    return destPath;
  } catch (err) {
    if (err && err.code === "EBUSY") {
      warn(`${stagedBinaryName()} is currently running — close it before upgrading. Using existing copy.`);
      return destPath;
    }
    warn(`failed to install dashboard binary: ${err && err.message ? err.message : String(err)}`);
    return null;
  }
}

function run(cliJs, args) {
  const r = spawnSync(process.execPath, [cliJs, ...args], { stdio: "inherit", windowsHide: true });
  return r.status === 0;
}

function main() {
  const skip = shouldSkip();
  if (skip) return; // silent skip

  const pkgRoot = packageRoot();
  const cliJs = findCli();
  if (!cliJs) {
    warn("could not locate dist/src/cli/index.js — skipping shortcut + autostart wiring.");
    warn("run `paat shortcut install` and `paat autostart install` manually after build.");
    return;
  }

  // Stage the dashboard binary into the per-user data dir. Required on
  // every platform (Windows for shortcuts to point at, macOS/Linux for
  // `paat dashboard` to find via the stable path).
  const dashboardBin = installDashboardBinary(pkgRoot);
  if (dashboardBin) {
    log(`Installed dashboard binary: ${dashboardBin}`);
  }

  // Windows-only: optional desktop shortcut + optional autostart. macOS/Linux users
  // get the CLI binary via npm's `bin` entries; GUI shortcuts on those
  // platforms require .app / .desktop machinery we haven't built yet.
  if (process.platform === "win32") {
    if (process.env.PAAT_INSTALL_SHORTCUTS === "1") {
      log("Setting up Windows shortcuts (PAAT_INSTALL_SHORTCUTS=1)…");
      const shortcutOk = run(cliJs, ["shortcut", "install"]);
      if (!shortcutOk) warn("shortcut install failed — try `paat shortcut install` manually.");
    } else {
      log("Skipping Windows shortcuts. Run `paat shortcut install` or set PAAT_INSTALL_SHORTCUTS=1 to opt in.");
    }

    if (process.env.PAAT_INSTALL_AUTOSTART === "1") {
      log("Enabling Windows-login autostart (PAAT_INSTALL_AUTOSTART=1)…");
      const autoOk = run(cliJs, ["autostart", "install"]);
      if (!autoOk) warn("autostart install failed — try `paat autostart install` manually.");
    } else {
      log("Skipping Windows-login autostart. Run `paat autostart install` or set PAAT_INSTALL_AUTOSTART=1 to opt in.");
    }
  } else {
    log(`Skipping desktop shortcut + autostart on ${process.platform} (not implemented).`);
    log(`Run \`paat dashboard\` from your terminal to open the GUI.`);
  }

  // MCP integrations modify unrelated application config files. Keep them
  // explicit by default; allow postinstall opt-in for managed deployments.
  let mcpOk = true;
  if (process.env.PAAT_INSTALL_MCP === "1") {
    log("Wiring PAAT into Claude Desktop / Codex Desktop / Claude Code (PAAT_INSTALL_MCP=1)…");
    mcpOk = run(cliJs, ["install-mcp"]);
    if (!mcpOk) warn("install-mcp returned a non-zero status — re-run `paat install-mcp` manually.");
  } else {
    log("Skipping MCP wire-up. Run `paat install-mcp` or set PAAT_INSTALL_MCP=1 to opt in.");
  }

  if (mcpOk) {
    log("Done. portpilot is ready. Open the dashboard with `portpilot` or `paat dashboard`.");
  }
}

try {
  main();
} catch (err) {
  warn("postinstall threw: " + (err && err.message ? err.message : String(err)));
  process.exit(0);
}
