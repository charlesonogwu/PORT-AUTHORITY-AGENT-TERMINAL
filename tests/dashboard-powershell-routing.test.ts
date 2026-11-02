import assert from "node:assert/strict";
import test from "node:test";
import type { PowerShellRunner } from "../src/core/powershell-host.js";
import { hasSonar, scanPorts } from "../src/core/scanner.js";
import { collectProcessSnapshot } from "../src/dashboard/process-info.js";
import { buildSnapshot } from "../src/dashboard/snapshot.js";
import { withTempHome } from "./helpers.js";

const windowsOnly = { skip: process.platform !== "win32" ? "PowerShell queries only run on Windows" : false };
// With the optional `sonar` scanner installed, a snapshot scans ports with it
// instead of PowerShell, so the three-query expectation below doesn't apply.
const windowsWithoutSonar = {
  skip: process.platform !== "win32"
    ? "PowerShell queries only run on Windows"
    : (await hasSonar()) ? "sonar is installed, so ports are not scanned with PowerShell" : false,
};

const LISTENER = { LocalPort: 45123, OwningProcess: 777, LocalAddress: "127.0.0.1" };
const LISTENER_PROCESS = { ProcessId: 777, Name: "node.exe", CommandLine: "node server.js", CreationDate: "2026-11-02T00:00:00.0000000Z" };
const PROCESS_TABLE = {
  processes: [{ pid: 777, ppid: 1, name: "node.exe", commandLine: "node server.js", memoryBytes: 1_048_576 }],
  connections: [],
};

/** Stands in for the dashboard's long-lived PowerShell session and records every script it was asked to run. */
function recordingRunner(): PowerShellRunner & { scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    run: async (script) => {
      scripts.push(script);
      if (script.includes("-State Listen")) return { stdout: JSON.stringify([LISTENER]), stderr: "", code: 0 };
      if (script.includes("-Filter")) return { stdout: JSON.stringify(LISTENER_PROCESS), stderr: "", code: 0 };
      return { stdout: JSON.stringify(PROCESS_TABLE), stderr: "", code: 0 };
    },
  };
}

test("process snapshot reuses the dashboard's PowerShell session", windowsOnly, async () => {
  const runner = recordingRunner();
  const snapshot = await collectProcessSnapshot({ powershell: runner });
  assert.equal(runner.scripts.length, 1);
  assert.match(runner.scripts[0]!, /Win32_Process/);
  assert.equal(snapshot.processes.get(777)?.name, "node.exe");
});

test("Windows port scan sends both PowerShell queries through the shared session", windowsOnly, async () => {
  const runner = recordingRunner();
  const result = await scanPorts({ preferSonar: false, powershell: runner });
  assert.equal(result.source, "native");
  assert.equal(runner.scripts.length, 2);
  const listener = result.observations.find((observation) => observation.port === LISTENER.LocalPort);
  assert.equal(listener?.pid, LISTENER.OwningProcess);
  assert.equal(listener?.command, "node.exe");
});

test("dashboard snapshot runs every PowerShell query through the shared session", windowsWithoutSonar, async () => {
  await withTempHome(async () => {
    const runner = recordingRunner();
    const snapshot = await buildSnapshot({ powershell: runner });
    assert.equal(runner.scripts.length, 3, "a dashboard refresh started its own powershell.exe");
    assert.ok(runner.scripts.some((script) => script.includes("-State Listen")));
    assert.ok(runner.scripts.some((script) => script.includes("-Filter")));
    assert.ok(runner.scripts.some((script) => script.includes("-State Established")));
    assert.ok(Array.isArray(snapshot.liveSessions));
  });
});
