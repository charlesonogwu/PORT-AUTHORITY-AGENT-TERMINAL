#!/usr/bin/env node
/**
 * Builds the Tauri dashboard (replaces the old Vite-only build).
 *
 * Pipeline:
 *   1. Ensure cargo + cargo-tauri are on PATH. Warn (don't fail) if missing —
 *      the committed bin/paat-dashboard.exe is the source-of-truth for npm
 *      releases, just like build-launcher.cjs treated Go.
 *   2. `npm install` inside gui/ if node_modules is missing.
 *   3. `cargo tauri build --no-bundle` from gui/. We skip the bundler because
 *      we don't want .msi/.dmg installers — npm is the install mechanism.
 *   4. Copy the produced binary to bin/<binary-name> so the npm package can
 *      ship it. Naming:
 *        Windows: bin/paat-dashboard.exe
 *        macOS:   bin/paat-dashboard-darwin-<arch>
 *        Linux:   bin/paat-dashboard-linux-<arch>
 *
 * Why a Node wrapper around `cargo tauri`:
 *   - npm scripts can't cross-platform detect whether cargo is installed.
 *   - We want a readable message when the toolchain is missing.
 *   - We need to copy the produced binary out of target/release/ into bin/.
 *   - The committed bin/paat-dashboard.exe is the source of truth for
 *     Windows releases — this script only needs to run when the Rust /
 *     frontend source changes.
 *
 * Force a fail (useful in CI to verify the binary is up-to-date with
 * source) by passing --strict.
 */

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { npmInvocation } = require("./npm-invocation.cjs");

const repoRoot = path.resolve(__dirname, "..");
const guiDir = path.join(repoRoot, "gui");
const cargoTargetDir = path.join(guiDir, "src-tauri", "target", "release");
const binDir = path.join(repoRoot, "bin");

const strict = process.argv.includes("--strict");

function log(msg) { process.stdout.write(`[build-dashboard] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[build-dashboard] ${msg}\n`); }

/** Resolve the platform-correct executable name for cargo. */
function cargoCmd() { return process.platform === "win32" ? "cargo.exe" : "cargo"; }

/** Pick the binary name and output path per platform. */
function platformBinary() {
  const arch = process.arch; // 'x64', 'arm64', etc.
  if (process.platform === "win32") {
    return {
      sourceName: "paat-dashboard.exe",
      destName: "paat-dashboard.exe",
    };
  }
  if (process.platform === "darwin") {
    return {
      sourceName: "paat-dashboard",
      destName: `paat-dashboard-darwin-${arch}`,
    };
  }
  return {
    sourceName: "paat-dashboard",
    destName: `paat-dashboard-linux-${arch}`,
  };
}

/** Augment PATH with ~/.cargo/bin so cargo invocations work even when the
 *  user's profile env isn't loaded (npm scripts, CI sandboxes). */
function augmentPath(env) {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  if (fs.existsSync(cargoBin)) {
    const sep = process.platform === "win32" ? ";" : ":";
    const current = env.PATH ?? env.Path ?? "";
    if (!current.split(sep).includes(cargoBin)) {
      return { ...env, PATH: `${cargoBin}${sep}${current}` };
    }
  }
  return env;
}

function detectCargo(env) {
  const cargoCheck = spawnSync(cargoCmd(), ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    // shell: false everywhere; we resolve npm.cmd / cargo.exe explicitly on
    // Windows via the .cmd extension because Node 22+ warns about shell:true
    // with args (DEP0190).
  });
  if (cargoCheck.error || cargoCheck.status !== 0) return null;
  return cargoCheck.stdout.toString().trim();
}

function detectCargoTauri(env) {
  const check = spawnSync(cargoCmd(), ["tauri", "--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    // shell: false everywhere; we resolve npm.cmd / cargo.exe explicitly on
    // Windows via the .cmd extension because Node 22+ warns about shell:true
    // with args (DEP0190).
  });
  if (check.error || check.status !== 0) return null;
  return check.stdout.toString().trim();
}

function maybeNpmInstallGui(env) {
  const nodeModules = path.join(guiDir, "node_modules");
  if (fs.existsSync(nodeModules)) return true;
  log("gui/node_modules missing — running `npm ci` inside gui/ …");
  const ci = npmInvocation(["ci", "--no-audit", "--no-fund"]);
  const result = spawnSync(
    ci.command,
    ci.args,
    {
      cwd: guiDir,
      stdio: "inherit",
      env,
      // shell: false everywhere; we resolve npm.cmd / cargo.exe explicitly on
    // Windows via the .cmd extension because Node 22+ warns about shell:true
    // with args (DEP0190).
    },
  );
  if (result.status !== 0) {
    // Fall back to `npm install` if ci fails (no lockfile, version drift, etc.)
    warn("`npm ci` failed — falling back to `npm install`…");
    const fallback = npmInvocation(["install", "--no-audit", "--no-fund"]);
    const install = spawnSync(
      fallback.command,
      fallback.args,
      {
        cwd: guiDir,
        stdio: "inherit",
        env,
        // shell: false everywhere; we resolve npm.cmd / cargo.exe explicitly on
    // Windows via the .cmd extension because Node 22+ warns about shell:true
    // with args (DEP0190).
      },
    );
    return install.status === 0;
  }
  return true;
}

function buildTauri(env) {
  log("compiling Tauri release build (cargo tauri build --no-bundle) …");
  // Privacy: rustc embeds absolute source paths (the project dir and
  // C:\Users\<name>\.cargo\registry\…) into panic-location metadata, so a
  // published binary would otherwise disclose the build machine's username
  // and folder layout. Remap both roots to neutral names. Uses
  // CARGO_ENCODED_RUSTFLAGS (\x1f-separated) so paths with spaces survive.
  const remapFlags = [
    `--remap-path-prefix=${os.homedir()}=/build/home`,
    `--remap-path-prefix=${repoRoot}=/build/portpilot`,
  ];
  const priorFlags = (env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  const encodedFlags = [...priorFlags, ...remapFlags].join("\x1f");
  const build = spawnSync(
    cargoCmd(),
    ["tauri", "build", "--no-bundle"],
    {
      cwd: guiDir,
      stdio: "inherit",
      env: { ...env, CARGO_ENCODED_RUSTFLAGS: encodedFlags },
      // shell: false everywhere; we resolve npm.cmd / cargo.exe explicitly on
    // Windows via the .cmd extension because Node 22+ warns about shell:true
    // with args (DEP0190).
    },
  );
  return build.status === 0;
}

function copyToBin({ sourceName, destName }) {
  const source = path.join(cargoTargetDir, sourceName);
  if (!fs.existsSync(source)) {
    warn(`expected build output not found: ${source}`);
    return false;
  }
  fs.mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, destName);
  // EBUSY can happen if the user has the dashboard running while rebuilding.
  // Try to delete first; if that fails, copyFileSync will surface the error.
  try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
  try {
    fs.copyFileSync(source, dest);
  } catch (err) {
    if (err && err.code === "EBUSY") {
      warn(`${destName} is currently running — close the dashboard and rebuild.`);
      return false;
    }
    throw err;
  }
  // Make it executable on macOS/Linux (Windows preserves perms via copyFile).
  if (process.platform !== "win32") {
    try { fs.chmodSync(dest, 0o755); } catch { /* ignore */ }
  }
  const stat = fs.statSync(dest);
  log(`wrote ${dest} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  return true;
}

function main() {
  const env = augmentPath({ ...process.env });

  const cargoVer = detectCargo(env);
  if (!cargoVer) {
    const msg =
      "cargo: command not found. Install Rust from https://rustup.rs to rebuild bin/paat-dashboard.\n" +
      "  Skipping — bin/paat-dashboard.* is committed to git, so this is only a problem if\n" +
      "  you changed gui/ source and need to refresh the binary.";
    if (strict) { warn(msg); process.exit(1); }
    log(msg); process.exit(0);
  }
  log(`cargo found: ${cargoVer}`);

  const tauriVer = detectCargoTauri(env);
  if (!tauriVer) {
    log("cargo-tauri CLI not installed — running `cargo install tauri-cli@^2` …");
    const install = spawnSync(
      cargoCmd(),
      ["install", "tauri-cli", "--version", "^2", "--locked"],
      { stdio: "inherit", env },
    );
    if (install.status !== 0) {
      const msg = "failed to install tauri-cli — run `cargo install tauri-cli@^2` manually.";
      if (strict) { warn(msg); process.exit(1); }
      log(msg); process.exit(0);
    }
  } else {
    log(`cargo-tauri found: ${tauriVer}`);
  }

  if (!maybeNpmInstallGui(env)) {
    const msg = "frontend `npm install` failed inside gui/ — fix the gui/ deps and retry.";
    if (strict) { warn(msg); process.exit(1); }
    log(msg); process.exit(0);
  }

  if (!buildTauri(env)) {
    const msg = "cargo tauri build failed — see error above.";
    warn(msg);
    process.exit(strict ? 1 : 0);
  }

  const target = platformBinary();
  if (!copyToBin(target)) {
    const msg = "failed to copy binary into bin/ — see error above.";
    warn(msg);
    process.exit(strict ? 1 : 0);
  }

  log("done.");
}

try {
  main();
} catch (err) {
  warn(`build-dashboard threw: ${err && err.message ? err.message : String(err)}`);
  process.exit(strict ? 1 : 0);
}
