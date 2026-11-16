import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";

test("source runner resolves its packaged collector under tsx", () => {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "import { QUERY_FILE } from './src/core/powershell-host.ts'; import { accessSync } from 'node:fs'; accessSync(QUERY_FILE);"], { stdio: "pipe" });
});

test("dashboard host never compiles stdin as PowerShell code", () => {
  const source = readFileSync("src/core/powershell-host.ts", "utf8");
  assert.doesNotMatch(source, /ScriptBlock|Invoke-Expression/);
  assert.match(source, /"-File"/);
  const collector = readFileSync("scripts/dashboard-queries.ps1", "utf8");
  assert.doesNotMatch(collector, /ScriptBlock|Invoke-Expression/);
});
