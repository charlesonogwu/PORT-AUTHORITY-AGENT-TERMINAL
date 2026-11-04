import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { parseUnixPsOutput, scanNative } from "../src/core/scanner.js";

test("parseUnixPsOutput preserves a complete macOS browser command line", () => {
  const command = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/portpilot --remote-debugging-port=9322";
  const lookup = parseUnixPsOutput(`  401 ${command}\nnot-a-process\n`);
  assert.equal(lookup.get(401)?.commandLine, command);
  assert.equal(lookup.get(401)?.command, undefined);
  assert.equal(lookup.size, 1);
});

test("scanNative enriches a real macOS listener with its ps command line", {
  skip: process.platform === "darwin" ? false : "requires macOS lsof and ps",
}, async () => {
  const marker = `portpilot-native-scan-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "const net=require('node:net'); const s=net.createServer(); s.listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)+'\\n'));", "--", marker], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let output = "";
    child.stdout.setEncoding("utf8");
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("temporary listener did not report a port")), 5_000);
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        const line = output.split(/\r?\n/, 1)[0];
        const value = Number(line);
        if (Number.isInteger(value) && value > 0) {
          clearTimeout(timeout);
          resolve(value);
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`temporary listener exited early: ${code}`)));
    });
    const observation = (await scanNative()).find((item) => item.port === port && item.pid === child.pid);
    assert.ok(observation, "lsof should identify the temporary loopback listener");
    assert.match(observation.commandLine ?? "", new RegExp(marker));
  } finally {
    child.kill();
    await once(child, "exit").catch(() => undefined);
  }
});

test("macOS ignores an executable named sonar injected into PATH", { skip: process.platform !== "darwin" }, async () => {
  const { mkdtemp, writeFile, access, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "portpilot-sonar-"));
  try {
    const marker = join(root, "executed");
    await writeFile(join(root, "sonar"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nconsole.log('sonar');\n`, { mode: 0o755 });
    const scanner = new URL("../src/core/scanner.js", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import {hasSonar} from ${JSON.stringify(scanner)}; console.log(await hasSonar());`], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "false");
    await assert.rejects(() => access(marker));
  } finally { await rm(root, { recursive: true, force: true }); }
});
