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
  const result = await host.run("owners");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(JSON.parse(result.stdout).some((p: { ProcessId: number }) => p.ProcessId === host.pid));
  return host.pid!;
}

test("fixed queries reuse one PowerShell and return real ports and processes", windowsOnly, async () => {
  await withHost(async (host) => {
    const first = await hostPid(host);
    const ports = await host.run("ports");
    assert.equal(ports.code, 0);
    assert.ok(JSON.parse(ports.stdout).length > 0);
    const table = JSON.parse((await host.run("processes")).stdout);
    assert.ok(table.processes.some((p: { pid: number }) => p.pid === process.pid));
    assert.ok(Array.isArray(table.connections));
    const debug = await host.run("debug-processes");
    assert.equal(debug.code, 0);
    assert.equal(host.pid, first);
  });
});

test("runner refuses arbitrary script text without starting PowerShell", async () => {
  await withHost(async (host) => {
    // @ts-expect-error exercise the runtime boundary too
    await assert.rejects(host.run("Write-Output 'injected'"), /Unknown PowerShell query/);
    assert.equal(host.pid, undefined);
  });
});

test("fixed queries queue in order", windowsOnly, async () => {
  await withHost(async (host) => {
    const results = await Promise.all([host.run("owners"), host.run("processes")]);
    assert.ok(Array.isArray(JSON.parse(results[0]!.stdout)));
    assert.ok(Array.isArray(JSON.parse(results[1]!.stdout).processes));
  });
});

test("timeout kills the helper and later queries recover in a persistent session", windowsOnly, async () => {
  await withHost(async (host) => {
    await assert.rejects(host.run("processes", { timeoutMs: 1 }), /timed out/);
    const pid = await hostPid(host);
    assert.equal(pid, host.pid);
  });
});

test("persistent PowerShell shuts down after sitting idle", windowsOnly, async () => {
  await withHost(async (host) => {
    const pid = await hostPid(host);
    await waitFor(() => !isAlive(pid), 5_000);
    assert.equal(host.pid, undefined);
    assert.notEqual(await hostPid(host), pid);
  }, { idleMs: 200 });
});

test("persistent PowerShell rotates at maxRuns", windowsOnly, async () => {
  await withHost(async (host) => {
    const first = await hostPid(host);
    assert.equal(await hostPid(host), first);
    assert.notEqual(await hostPid(host), first);
  }, { maxRuns: 2 });
});

test("startup failure falls back to the packaged one-off File query", windowsOnly, async () => {
  await withHost(async (host) => {
    for (let i = 0; i < 2; i++) {
      const result = await host.run("processes");
      assert.equal(result.code, 0, result.stderr);
      assert.ok(JSON.parse(result.stdout).processes.length > 0);
      assert.equal(host.pid, undefined);
    }
  }, { sessionFile: "C:/paat-nonexistent-session.ps1" });
});

test("closing ends the helper and refuses new work", windowsOnly, async () => {
  const host = createPersistentPowerShell();
  const pid = await hostPid(host);
  host.close();
  await waitFor(() => !isAlive(pid), 5_000);
  await assert.rejects(host.run("ports"), /closed/);
});
