import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

type NpmInvocation = (
  args: string[],
  options: { platform: NodeJS.Platform; execPath: string; env: NodeJS.ProcessEnv },
) => { command: string; args: string[] };

function loadNpmInvocation(): NpmInvocation {
  return (require(join(repoRoot, "scripts", "npm-invocation.cjs")) as { npmInvocation: NpmInvocation }).npmInvocation;
}

function withFile<T>(name: string, run: (path: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "portpilot-npm-invocation-"));
  const path = join(dir, name);
  writeFileSync(path, "// disposable marker\n");
  try {
    return run(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Node refuses to spawn npm.cmd without a shell (CVE-2024-27980), so the
// dashboard build must run npm's JavaScript CLI through node.exe instead.
test("Windows npm invocation runs npm's JavaScript CLI through Node", () => {
  withFile("npm-cli.js", (npmCli) => {
    const invocation = loadNpmInvocation()(["ci", "--no-audit"], {
      platform: "win32",
      execPath: String.raw`C:\Program Files\nodejs\node.exe`,
      env: { npm_execpath: npmCli },
    });
    assert.equal(invocation.command, String.raw`C:\Program Files\nodejs\node.exe`);
    assert.deepEqual(invocation.args, [npmCli, "ci", "--no-audit"]);
  });
});

test("Windows npm invocation ignores an npm_execpath that is not npm's own CLI", () => {
  withFile("pnpm.cjs", (pnpm, dir) => {
    assert.throws(
      () => loadNpmInvocation()(["ci"], { platform: "win32", execPath: join(dir, "node.exe"), env: { npm_execpath: pnpm } }),
      /Could not locate npm-cli\.js/,
    );
  });
});

test("non-Windows npm invocation runs npm directly", () => {
  const invocation = loadNpmInvocation()(["ci"], { platform: "darwin", execPath: "/usr/local/bin/node", env: {} });
  assert.deepEqual(invocation, { command: "npm", args: ["ci"] });
});

test("the npm package ships the helper the dashboard build script requires", () => {
  const pkg = require(join(repoRoot, "package.json")) as { files: string[] };
  assert.ok(pkg.files.includes("scripts/build-dashboard-tauri.cjs"));
  assert.ok(pkg.files.includes("scripts/npm-invocation.cjs"), "build-dashboard-tauri.cjs requires ./npm-invocation.cjs");
});
