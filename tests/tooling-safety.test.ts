import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

test("Windows npm invocation runs npm's JavaScript CLI through Node", () => {
  const npmCli = join(tmpdir(), "portpilot-test-npm-cli.js");
  writeFileSync(npmCli, "// disposable npm CLI marker\n");
  try {
    const { npmInvocation } = require(join(repoRoot, "scripts", "npm-invocation.cjs")) as {
      npmInvocation: (
        args: string[],
        options: {
          platform: NodeJS.Platform;
          execPath: string;
          env: NodeJS.ProcessEnv;
        },
      ) => { command: string; args: string[] };
    };
    const invocation = npmInvocation(["ci", "--no-audit"], {
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      env: { npm_execpath: npmCli },
    });
    assert.equal(invocation.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(invocation.args, [npmCli, "ci", "--no-audit"]);
  } finally {
    try {
      require("node:fs").rmSync(npmCli, { force: true });
    } catch {
      // Best-effort cleanup of a disposable marker.
    }
  }
});

test("prepack leaves an existing dependency tree intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "portpilot-prepack-test-"));
  try {
    const scriptsDir = join(root, "scripts");
    const nodeModulesDir = join(root, "node_modules");
    const sentinel = join(nodeModulesDir, "portpilot-prepack-sentinel.txt");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(nodeModulesDir, { recursive: true });
    copyFileSync(join(repoRoot, "scripts", "prepack.cjs"), join(scriptsDir, "prepack.cjs"));
    writeFileSync(sentinel, "must survive");

    const result = spawnSync(process.execPath, [join(scriptsDir, "prepack.cjs")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sentinel), true, "prepack must not delete node_modules");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Tauri dashboard uses a restrictive production CSP", () => {
  const config = JSON.parse(
    readFileSync(join(repoRoot, "gui", "src-tauri", "tauri.conf.json"), "utf8"),
  ) as { app?: { security?: { csp?: unknown } } };
  const csp = config.app?.security?.csp;
  assert.equal(typeof csp, "string");
  assert.match(String(csp), /default-src\s+'self'/);
  assert.match(String(csp), /object-src\s+'none'/);
  assert.doesNotMatch(String(csp), /default-src\s+\*/);
});
