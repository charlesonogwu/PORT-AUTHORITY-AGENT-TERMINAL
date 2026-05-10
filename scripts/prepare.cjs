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
 * practice we have seen it skip them when:
 *   - the user has `production=true` in their global .npmrc, or
 *   - certain npm 10.x configurations don't fetch devDeps for git installs
 * Either way the symptom is `tsc: not found` (or sharp ENOENT, when
 * we still ran `build:icons`). Now `build:icons` early-exits when its
 * outputs are already on disk (they're committed to git), so the only
 * devDep we strictly need at install time is typescript.
 *
 * If `node_modules/typescript` is missing we run a nested
 *   npm install --include=dev --no-audit --no-fund
 * once. That nested install would itself re-trigger this same prepare
 * script (npm runs prepare on `npm install` with no args), so we set
 * PAAT_PREPARE_RUNNING=1 in its env and check that env var at the top
 * of this script — the nested invocation early-exits and the outer
 * invocation continues to the build. This lets sharp's own postinstall
 * download its native binary (we deliberately removed the previous
 * `--ignore-scripts` flag because it was breaking sharp).
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const distEntry = path.join(repoRoot, "dist", "src", "cli", "index.js");
const typescriptDir = path.join(repoRoot, "node_modules", "typescript");

// Recursion guard. The nested `npm install --include=dev` we run below
// will trigger a second invocation of this script via the `prepare`
// lifecycle. We set PAAT_PREPARE_RUNNING=1 in that nested process's env
// so this top-of-script check exits it cleanly without re-running the
// install or build.
if (process.env.PAAT_PREPARE_RUNNING === "1") {
  console.log("[paat prepare] nested invocation detected (PAAT_PREPARE_RUNNING=1) — skipping");
  process.exit(0);
}

if (process.env.CI === "true") {
  console.log("[paat prepare] CI=true detected, skipping (CI runs build explicitly)");
  process.exit(0);
}

if (fs.existsSync(distEntry)) {
  console.log("[paat prepare] dist/src/cli/index.js exists — skipping build");
  process.exit(0);
}

// Self-heal missing devDeps (specifically: typescript for `tsc`). See
// header comment for the rationale and the recursion-guard contract.
if (!fs.existsSync(typescriptDir)) {
  console.log(
    "[paat prepare] typescript not found in node_modules — installing devDependencies " +
      "(this is normal on a fresh `npm install -g github:...`)",
  );
  const install = spawnSync(
    "npm",
    ["install", "--include=dev", "--no-audit", "--no-fund"],
    {
      stdio: "inherit",
      shell: true,
      cwd: repoRoot,
      env: { ...process.env, PAAT_PREPARE_RUNNING: "1" },
    },
  );
  if (install.status !== 0) {
    console.error(
      "[paat prepare] failed to install devDependencies (exit " + install.status + ").\n" +
        "Workaround — clone the repo and build manually:\n" +
        "  git clone https://github.com/charlesonogwu/port-authority-agent-terminal.git\n" +
        "  cd port-authority-agent-terminal\n" +
        "  npm install\n" +
        "  npm run build\n" +
        "  npm link",
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
  // Propagate the recursion-guard env into the build so any nested
  // `npm install` (e.g. `build:dashboard` doing `npm --prefix
  // dashboard-ui/portpilot-dashboard install`) doesn't re-fire
  // OUR prepare script. The dashboard subdir has its own package.json
  // and its own (unrelated) prepare hook, if any.
  env: { ...process.env, PAAT_PREPARE_RUNNING: "1" },
});
process.exit(r.status ?? 1);
