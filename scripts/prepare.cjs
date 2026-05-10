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
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "src", "cli", "index.js");

if (process.env.CI === "true") {
  console.log("[paat prepare] CI=true detected, skipping (CI runs build explicitly)");
  process.exit(0);
}

if (fs.existsSync(distEntry)) {
  console.log("[paat prepare] dist/src/cli/index.js exists — skipping build");
  process.exit(0);
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
