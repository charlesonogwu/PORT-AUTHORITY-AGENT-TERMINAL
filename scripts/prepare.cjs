#!/usr/bin/env node
/**
 * npm `prepare` lifecycle hook.
 *
 * Runs in three situations:
 *   1. `npm install -g github:charlesonogwu/...`     (true target — must build dist/)
 *   2. `npm publish`                                  (must build dist/)
 *   3. `npm install` from a local checkout            (devs — should be FAST)
 *
 * Without a guard, case 3 would re-run the full React-app + tsc build
 * every time a developer adds a dep, which is annoying. So: if
 * `dist/src/cli/index.js` already exists, assume the tree is built and
 * skip. The user can always force a rebuild with `npm run build`.
 *
 * Guard short-circuits in CI too (CI=true) — CI workflows do their own
 * explicit `npm run build` step and don't need prepare to do it again.
 *
 * Devdeps repair (the github-install path):
 * When npm runs `prepare` during `npm install -g github:user/repo`, in
 * theory npm installs devDependencies first so the build can run. In
 * practice we have seen two failure modes:
 *   - Users with `production=true` in their global .npmrc skip devDeps
 *     entirely, so `sharp`, `tsx`, and `typescript` aren't on disk when
 *     prepare fires.
 *   - Some npm versions (≥10.x in certain configurations) don't install
 *     devDeps for git installs at all.
 * Either way the symptom is the same: `npm run build:icons` fails with
 *   ERR_MODULE_NOT_FOUND: Cannot find package 'sharp'
 * To self-heal, we sniff for `node_modules/sharp`. If it's missing we run
 *   npm install --include=dev --no-audit --no-fund --ignore-scripts
 * exactly once before invoking the build. `--ignore-scripts` is critical
 * — without it, that nested install would re-trigger this same prepare
 * script and recurse.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "src", "cli", "index.js");
const sharpDir = path.join(repoRoot, "node_modules", "sharp");

if (process.env.CI === "true") {
  console.log("[paat prepare] CI=true detected, skipping (CI runs build explicitly)");
  process.exit(0);
}

if (fs.existsSync(distEntry)) {
  console.log("[paat prepare] dist/src/cli/index.js exists — skipping build");
  process.exit(0);
}

// Self-heal missing devDeps before invoking the build. See header comment.
if (!fs.existsSync(sharpDir)) {
  console.log(
    "[paat prepare] sharp not found in node_modules — installing devDependencies " +
      "(--include=dev --ignore-scripts) before build...",
  );
  const install = spawnSync(
    "npm",
    ["install", "--include=dev", "--no-audit", "--no-fund", "--ignore-scripts"],
    { stdio: "inherit", shell: true, cwd: repoRoot },
  );
  if (install.status !== 0) {
    console.error(
      "[paat prepare] failed to install devDependencies (exit " + install.status + "). " +
        "Try running this manually:\n" +
        "  cd " + repoRoot + "\n" +
        "  npm install --include=dev\n" +
        "  npm run build",
    );
    process.exit(install.status ?? 1);
  }
}

console.log(
  "[paat prepare] no dist/ found, running 'npm run build' to compile server + dashboard...",
);

const r = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: true,
  cwd: repoRoot,
});
process.exit(r.status ?? 1);
