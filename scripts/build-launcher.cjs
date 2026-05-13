#!/usr/bin/env node
/**
 * Builds bin/paat-launcher.exe from cmd/paat-launcher/main.go.
 *
 * Why a Node wrapper around `go build`:
 *
 *   1. npm scripts don't have a clean cross-platform way to detect
 *      whether a tool is installed; doing it in Node lets us print a
 *      readable message if Go is missing.
 *   2. The compiled .exe is committed to git (bin/paat-launcher.exe),
 *      so this script only needs to run when the launcher's Go source
 *      changes — not on every `npm publish`. Most contributors will
 *      never need Go installed at all.
 *   3. We use ldflags to strip symbol info and request the Windows GUI
 *      subsystem (so double-clicking the .exe doesn't briefly flash a
 *      console window).
 *
 * If Go isn't on PATH, this script EXITS 0 with a hint, not a hard
 * failure. Reason: the committed bin/paat-launcher.exe is the source
 * of truth for releases. Missing Go just means you can't recompile —
 * not that the build is broken.
 *
 * Force a fail (useful in CI to verify the .exe is up-to-date with
 * source) by passing --strict.
 */

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "cmd", "paat-launcher");
const outputBin = path.join(repoRoot, "bin", "paat-launcher.exe");

const strict = process.argv.includes("--strict");

function log(msg) {
  process.stdout.write(`[build-launcher] ${msg}\n`);
}
function warn(msg) {
  process.stderr.write(`[build-launcher] ${msg}\n`);
}

// 1. Detect Go.
const goCheck = spawnSync("go", ["version"], { stdio: ["ignore", "pipe", "pipe"] });
if (goCheck.error || goCheck.status !== 0) {
  const msg =
    "go: command not found. Install Go from https://go.dev/dl/ to rebuild bin/paat-launcher.exe.\n" +
    "  Skipping — bin/paat-launcher.exe is committed to git, so this is only a problem if\n" +
    "  you changed cmd/paat-launcher/*.go and need to refresh the binary.";
  if (strict) {
    warn(msg);
    process.exit(1);
  }
  log(msg);
  process.exit(0);
}

log(`go found: ${goCheck.stdout.toString().trim()}`);

// 2. Make sure bin/ exists.
fs.mkdirSync(path.dirname(outputBin), { recursive: true });

// 3. Build. -H windowsgui = no console flash. -s -w = strip debug symbols
//    (≈30% smaller binary).
log("compiling cmd/paat-launcher/ -> bin/paat-launcher.exe ...");
const build = spawnSync(
  "go",
  ["build", "-ldflags", "-H windowsgui -s -w", "-o", outputBin, "."],
  {
    cwd: sourceDir,
    stdio: "inherit",
    env: { ...process.env, GOOS: "windows", GOARCH: "amd64" },
  },
);
if (build.status !== 0) {
  warn(`go build failed (exit ${build.status})`);
  process.exit(build.status ?? 1);
}

const stat = fs.statSync(outputBin);
log(`wrote ${outputBin} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
