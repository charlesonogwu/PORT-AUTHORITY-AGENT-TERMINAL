import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readPackageJson(): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
}

test("postinstall lifecycle exits successfully if the helper script is absent", () => {
  const pkg = readPackageJson();
  const command = pkg.scripts?.postinstall;
  assert.ok(command, "package.json must define scripts.postinstall");

  const dir = mkdtempSync(join(tmpdir(), "paat-postinstall-missing-script-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    const result = spawnSync(command, {
      cwd: dir,
      shell: true,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_global: "true",
        PAAT_SKIP_POSTINSTALL: "",
        CI: "false",
      },
    });

    assert.equal(
      result.status,
      0,
      `postinstall should not fail when scripts/postinstall.cjs is missing\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postinstall MCP registration remains opt-in", () => {
  const source = readFileSync(join(repoRoot, "scripts", "postinstall.cjs"), "utf8");

  assert.match(source, /PAAT_INSTALL_MCP === "1"/);
  assert.match(source, /Skipping MCP wire-up by default/);

  const optIn = source.indexOf('process.env.PAAT_INSTALL_MCP === "1"');
  const installMcp = source.indexOf('run(cliJs, ["install-mcp"])');
  assert.ok(optIn >= 0 && installMcp > optIn, "install-mcp must be guarded by the opt-in env var");
});
