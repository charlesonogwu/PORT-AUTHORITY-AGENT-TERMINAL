import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessRecord, parseSnapshot, sumTreeMemoryMB } from "../src/dashboard/process-info.js";

const MB = 1024 * 1024;

function proc(pid: number, ppid: number, memoryMB: number, name = "chrome.exe"): ProcessRecord {
  return { pid, ppid, name, commandLine: "", memoryBytes: memoryMB * MB };
}

function mapOf(...procs: ProcessRecord[]): Map<number, ProcessRecord> {
  return new Map(procs.map((p) => [p.pid, p]));
}

// ── sumTreeMemoryMB ──────────────────────────────────────────────────────────

test("sumTreeMemoryMB: sums parent + direct children + grandchildren", () => {
  const procs = mapOf(
    proc(100, 1, 300), // browser parent
    proc(101, 100, 150), // renderer
    proc(102, 100, 150), // renderer
    proc(103, 101, 50), // grandchild (e.g. utility spawned by renderer)
    proc(999, 1, 500), // unrelated process — must NOT count
  );
  assert.equal(sumTreeMemoryMB(100, procs), 650);
});

test("sumTreeMemoryMB: unknown root → undefined (not 0)", () => {
  assert.equal(sumTreeMemoryMB(42, mapOf(proc(100, 1, 300))), undefined);
});

test("sumTreeMemoryMB: snapshot without memory data → undefined", () => {
  const procs = mapOf(proc(100, 1, 0), proc(101, 100, 0));
  assert.equal(sumTreeMemoryMB(100, procs), undefined);
});

test("sumTreeMemoryMB: survives a ppid cycle (PID reuse)", () => {
  // 100 -> 101 -> 100 cycle: must terminate and count each once.
  const a = proc(100, 101, 200);
  const b = proc(101, 100, 100);
  assert.equal(sumTreeMemoryMB(100, mapOf(a, b)), 300);
});

// ── parseSnapshot carries memory through ─────────────────────────────────────

test("parseSnapshot: keeps memoryBytes, defaults missing/negative to 0", () => {
  const snap = parseSnapshot({
    processes: [
      { pid: 1, ppid: 0, name: "a", commandLine: "", memoryBytes: 5 * MB },
      { pid: 2, ppid: 0, name: "b", commandLine: "" }, // no memory field
      { pid: 3, ppid: 0, name: "c", commandLine: "", memoryBytes: -1 },
    ],
    connections: [],
  });
  assert.equal(snap.processes.get(1)!.memoryBytes, 5 * MB);
  assert.equal(snap.processes.get(2)!.memoryBytes, 0);
  assert.equal(snap.processes.get(3)!.memoryBytes, 0);
});
