/**
 * Tests for the chrome-birth registry and the inference fallback that
 * uses it.
 *
 * The registry is a persistent record of who launched each Chrome the
 * FIRST time we saw it. The agent-inference module checks it whenever
 * the live parent chain has only chrome itself (parent already exited).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BirthRegistry, birthsPath } from "../src/dashboard/chrome-births.js";
import { inferAgentFromLiveChrome } from "../src/dashboard/agent-inference.js";
import type { ProcessRecord, ProcessSnapshot } from "../src/dashboard/process-info.js";

let prevHome: string | undefined;
let tmp: string;

before(() => {
  prevHome = process.env["PORTPILOT_HOME"];
  tmp = mkdtempSync(join(tmpdir(), "paat-births-test-"));
  process.env["PORTPILOT_HOME"] = tmp;
});

after(() => {
  if (prevHome === undefined) delete process.env["PORTPILOT_HOME"];
  else process.env["PORTPILOT_HOME"] = prevHome;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function rec(pid: number, ppid: number, name: string, cmd = ""): ProcessRecord {
  return { pid, ppid, name, commandLine: cmd };
}

function snap(records: ProcessRecord[]): ProcessSnapshot {
  const m = new Map<number, ProcessRecord>();
  for (const r of records) m.set(r.pid, r);
  return { processes: m, connections: [] };
}

describe("BirthRegistry — basic semantics", () => {
  it("returns empty when no file exists", async () => {
    const r = await BirthRegistry.load();
    assert.equal(r.size(), 0);
  });

  it("first-write wins — second record() for same key is ignored", () => {
    const r = BirthRegistry.empty();
    const c1 = [rec(100, 1, "chrome.exe"), rec(1, 0, "shell.exe", "shell.exe codex/main.js")];
    const c2 = [rec(100, 1, "chrome.exe"), rec(1, 0, "shell.exe", "shell.exe DIFFERENT")];
    assert.equal(r.record(100, "C:\\foo", c1), true);
    assert.equal(r.record(100, "C:\\foo", c2), false);
    assert.equal(r.lookup(100, "C:\\foo")!.chain[1]!.commandLine, "shell.exe codex/main.js");
  });

  it("refuses to record a chain with no ancestry (chrome-only)", () => {
    const r = BirthRegistry.empty();
    const onlyChrome = [rec(100, 1, "chrome.exe")];
    assert.equal(r.record(100, "C:\\foo", onlyChrome), false);
    assert.equal(r.size(), 0);
  });

  it("round-trips through disk", async () => {
    const r1 = await BirthRegistry.load();
    r1.record(123, "C:\\rt", [
      rec(123, 99, "chrome.exe"),
      rec(99, 1, "node.exe", "node codex/main.js"),
    ]);
    await r1.flush();
    const r2 = await BirthRegistry.load();
    const got = r2.lookup(123, "C:\\rt");
    assert.ok(got, "record should round-trip");
    assert.equal(got!.chain.length, 2);
    assert.equal(got!.chain[1]!.commandLine, "node codex/main.js");
  });

  it("drops expired records on load (>24h old)", async () => {
    // Hand-write a stale record to disk and confirm load() drops it.
    const p = birthsPath();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const data = {
      version: 1,
      records: [
        { chromePid: 1, profileDir: "C:\\old", firstSeenAt: old, chain: [{ pid: 1, ppid: 0, name: "chrome.exe", commandLine: "" }, { pid: 0, ppid: 0, name: "shell", commandLine: "" }] },
        { chromePid: 2, profileDir: "C:\\fresh", firstSeenAt: fresh, chain: [{ pid: 2, ppid: 0, name: "chrome.exe", commandLine: "" }, { pid: 0, ppid: 0, name: "shell", commandLine: "" }] },
      ],
    };
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(data), "utf8");

    const r = await BirthRegistry.load();
    assert.equal(r.lookup(1, "C:\\old"), undefined, "stale record should be dropped");
    assert.ok(r.lookup(2, "C:\\fresh"), "fresh record should survive");
  });
});

describe("inferAgentFromLiveChrome — birth registry fallback", () => {
  it("uses the recorded chain when the live parent has exited", () => {
    // The live snapshot has chrome only — the launcher (Codex) is gone.
    // But the birth registry remembers it.
    const live = snap([rec(100, 999, "chrome.exe")]);
    const r = BirthRegistry.empty();
    r.record(100, "C:\\anonymous-profile", [
      rec(100, 999, "chrome.exe"),
      rec(999, 1, "node.exe", "node C:\\codex-cli\\dist\\main.js"),
    ]);
    const result = inferAgentFromLiveChrome(
      { chromePid: 100, port: 9222, profileDir: "C:\\anonymous-profile", births: r },
      live,
    );
    assert.equal(result.agent, "codex");
    assert.equal(result.confidence, "high");
    assert.match(result.evidence[0] ?? "", /birth-record/);
  });

  it("birth lookup is keyed by profileDir; mismatched dir does not match", () => {
    const live = snap([rec(100, 999, "chrome.exe")]);
    const r = BirthRegistry.empty();
    r.record(100, "C:\\one", [
      rec(100, 999, "chrome.exe"),
      rec(999, 1, "node.exe", "node codex-cli/main.js"),
    ]);
    const result = inferAgentFromLiveChrome(
      { chromePid: 100, port: 9222, profileDir: "C:\\TWO", births: r },
      live,
    );
    assert.equal(result.agent, "external");
  });

  it("live ancestry beats birth-record (trusts current truth first)", () => {
    // Live chain says cursor; birth says codex. Live wins.
    const live = snap([
      rec(50, 0, "Cursor.exe"),
      rec(100, 50, "chrome.exe"),
    ]);
    const r = BirthRegistry.empty();
    r.record(100, "C:\\proj", [
      rec(100, 50, "chrome.exe"),
      rec(50, 0, "node.exe", "node codex/main.js"),
    ]);
    const result = inferAgentFromLiveChrome(
      { chromePid: 100, port: 9222, profileDir: "C:\\proj", births: r },
      live,
    );
    assert.equal(result.agent, "cursor");
  });

  it("notes the orphan parent when neither live ancestry nor birth helps", () => {
    const live = snap([rec(100, 999, "chrome.exe")]); // ppid 999 not in snap
    const result = inferAgentFromLiveChrome(
      { chromePid: 100, port: 9222, profileDir: "C:\\unknown" },
      live,
    );
    assert.equal(result.agent, "external");
    const evidenceText = result.evidence.join(" ");
    assert.match(evidenceText, /already exited/);
  });
});
