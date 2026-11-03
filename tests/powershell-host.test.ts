import assert from "node:assert/strict";
import test from "node:test";
import { createPersistentPowerShell, type PersistentPowerShell } from "../src/core/powershell-host.js";

const windowsOnly = { skip: process.platform !== "win32" ? "the persistent PowerShell session is Windows-only" : false };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withHost<T>(fn: (host: PersistentPowerShell) => Promise<T>, options = {}): Promise<T> {
  const host = createPersistentPowerShell(options);
  try {
    return await fn(host);
  } finally {
    host.close();
  }
}

async function hostPid(host: PersistentPowerShell): Promise<number> {
  return Number((await host.run("$PID")).stdout.trim());
}

test("persistent PowerShell runs many scripts in one powershell.exe", windowsOnly, async () => {
  await withHost(async (host) => {
    const first = await host.run("$PID");
    const second = await host.run("$PID");
    assert.equal(first.code, 0);
    assert.equal(first.stdout.trim(), second.stdout.trim(), "each script started a new powershell.exe");
    assert.equal(Number(first.stdout.trim()), host.pid);
  });
});

test("persistent PowerShell returns script output as UTF-8 text", windowsOnly, async () => {
  await withHost(async (host) => {
    const result = await host.run("@{ name = 'Zoë'; n = 2 } | ConvertTo-Json -Compress");
    assert.deepEqual(JSON.parse(result.stdout), { name: "Zoë", n: 2 });
  });
});

test("persistent PowerShell keeps one script's variables out of the next", windowsOnly, async () => {
  await withHost(async (host) => {
    await host.run("$leak = 'x'");
    const result = await host.run("if ($null -eq $leak) { 'clean' } else { 'leaked' }");
    assert.equal(result.stdout.trim(), "clean");
  });
});

test("persistent PowerShell reports a throwing script and keeps working", windowsOnly, async () => {
  await withHost(async (host) => {
    const failed = await host.run("throw 'boom'");
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /boom/);
    const after = await host.run("'still alive'");
    assert.equal(after.code, 0);
    assert.equal(after.stdout.trim(), "still alive");
  });
});

test("persistent PowerShell runs queued scripts one at a time, in order", windowsOnly, async () => {
  await withHost(async (host) => {
    const results = await Promise.all([host.run("'a'"), host.run("'b'"), host.run("'c'")]);
    assert.deepEqual(results.map((result) => result.stdout.trim()), ["a", "b", "c"]);
  });
});

test("persistent PowerShell kills a hung script and recovers in a fresh process", windowsOnly, async () => {
  await withHost(async (host) => {
    const before = await hostPid(host);
    await assert.rejects(host.run("Start-Sleep -Seconds 30", { timeoutMs: 500 }), /timed out/);
    await waitFor(() => !isAlive(before), 5_000);
    const after = await hostPid(host);
    assert.notEqual(after, before);
  });
});

test("persistent PowerShell shuts its process down after sitting idle", windowsOnly, async () => {
  await withHost(async (host) => {
    const pid = await hostPid(host);
    await waitFor(() => !isAlive(pid), 5_000);
    assert.equal(host.pid, undefined);
    const next = await hostPid(host);
    assert.notEqual(next, pid);
  }, { idleMs: 200 });
});

test("persistent PowerShell starts a fresh process after maxRuns scripts", windowsOnly, async () => {
  await withHost(async (host) => {
    const first = await hostPid(host);
    const second = await hostPid(host);
    const third = await hostPid(host);
    assert.equal(second, first);
    assert.notEqual(third, first);
  }, { maxRuns: 2 });
});

test("persistent PowerShell falls back to one-off runs when its session cannot start", windowsOnly, async () => {
  // Simulates e.g. Constrained Language Mode, where the session loop itself is refused.
  await withHost(async (host) => {
    const first = await host.run("'still answered'");
    assert.equal(first.code, 0);
    assert.equal(first.stdout.trim(), "still answered");
    const second = await host.run("'and again'");
    assert.equal(second.stdout.trim(), "and again");
    assert.equal(host.pid, undefined, "no long-lived session should be running");
  }, { hostScript: "exit 3" });
});

test("a first script that times out does not switch the session off", windowsOnly, async () => {
  await withHost(async (host) => {
    await assert.rejects(host.run("Start-Sleep -Seconds 30", { timeoutMs: 500 }), /timed out/);
    const pid = await hostPid(host);
    assert.equal(pid, host.pid, "later scripts should still run in a long-lived session");
  });
});

test("closing the persistent PowerShell ends its process and refuses new work", windowsOnly, async () => {
  const host = createPersistentPowerShell();
  const pid = await hostPid(host);
  host.close();
  await waitFor(() => !isAlive(pid), 5_000);
  await assert.rejects(host.run("'x'"), /closed/);
});
