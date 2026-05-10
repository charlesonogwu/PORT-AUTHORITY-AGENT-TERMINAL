/**
 * Tests for findAllAgentChromes — the process-snapshot-based Chrome
 * enumeration path that catches BOTH `--remote-debugging-port` and
 * `--remote-debugging-pipe` Chromes.
 *
 * Pipe-mode is the important case: Playwright/Puppeteer default to it,
 * and they don't open any TCP port, so the legacy port-scan path can't
 * see them at all.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findAllAgentChromes } from "../src/dashboard/sources.js";
import type { ProcessRecord, ProcessSnapshot } from "../src/dashboard/process-info.js";

function snap(records: ProcessRecord[]): ProcessSnapshot {
  const m = new Map<number, ProcessRecord>();
  for (const r of records) m.set(r.pid, r);
  return { processes: m, connections: [] };
}

function rec(pid: number, ppid: number, name: string, cmd: string): ProcessRecord {
  return { pid, ppid, name, commandLine: cmd };
}

describe("findAllAgentChromes", () => {
  it("returns empty for an empty snapshot", () => {
    assert.deepEqual(findAllAgentChromes({ processes: new Map() }), []);
  });

  it("finds chrome.exe with --remote-debugging-port", () => {
    const s = snap([
      rec(100, 1, "chrome.exe", `chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\foo`),
    ]);
    const chromes = findAllAgentChromes(s);
    assert.equal(chromes.length, 1);
    assert.equal(chromes[0]!.port, 9222);
    assert.equal(chromes[0]!.debugMode, "port");
    assert.equal(chromes[0]!.profileDir, "C:\\foo");
    assert.equal(chromes[0]!.pid, 100);
  });

  it("finds chrome.exe with --remote-debugging-pipe (the Playwright case)", () => {
    const s = snap([
      rec(100, 1, "chrome.exe", `chrome.exe --remote-debugging-pipe --user-data-dir=C:\\pw\\profile`),
    ]);
    const chromes = findAllAgentChromes(s);
    assert.equal(chromes.length, 1);
    assert.equal(chromes[0]!.debugMode, "pipe");
    assert.equal(chromes[0]!.port, 0);
    assert.equal(chromes[0]!.profileDir, "C:\\pw\\profile");
  });

  it("prefers port mode when both flags are present", () => {
    const s = snap([
      rec(100, 1, "chrome.exe", `chrome.exe --remote-debugging-port=9222 --remote-debugging-pipe`),
    ]);
    const chromes = findAllAgentChromes(s);
    assert.equal(chromes.length, 1);
    assert.equal(chromes[0]!.debugMode, "port");
    assert.equal(chromes[0]!.port, 9222);
  });

  it("skips Chrome subprocesses (--type=renderer / utility / gpu / zygote)", () => {
    const s = snap([
      rec(100, 1, "chrome.exe", `chrome.exe --remote-debugging-port=9222`),
      rec(101, 100, "chrome.exe", `chrome.exe --type=renderer --remote-debugging-port=9222`),
      rec(102, 100, "chrome.exe", `chrome.exe --type=gpu-process --remote-debugging-port=9222`),
      rec(103, 100, "chrome.exe", `chrome.exe --type=utility --remote-debugging-port=9222`),
    ]);
    const chromes = findAllAgentChromes(s);
    assert.equal(chromes.length, 1, "only the parent should be returned");
    assert.equal(chromes[0]!.pid, 100);
  });

  it("skips the user's regular browsing Chrome (no debug flags)", () => {
    const s = snap([
      rec(100, 1, "chrome.exe", `chrome.exe https://www.google.com`),
      rec(101, 1, "chrome.exe", `chrome.exe --user-data-dir=C:\\Users\\u\\AppData\\Local\\Google\\Chrome`),
    ]);
    assert.deepEqual(findAllAgentChromes(s), []);
  });

  it("recognises msedge.exe / brave.exe / chromium.exe", () => {
    const s = snap([
      rec(100, 1, "msedge.exe", `msedge.exe --remote-debugging-port=9223`),
      rec(101, 1, "brave.exe", `brave.exe --remote-debugging-pipe`),
      rec(102, 1, "chromium.exe", `chromium.exe --remote-debugging-port=9224`),
    ]);
    const chromes = findAllAgentChromes(s);
    assert.equal(chromes.length, 3);
    const byName = chromes.map((c) => c.command).sort();
    assert.deepEqual(byName, ["brave.exe", "chromium.exe", "msedge.exe"]);
  });

  it("does NOT match arbitrary processes that mention chrome in their command line", () => {
    const s = snap([
      rec(100, 1, "node.exe", `node.exe scrape-chrome.js --remote-debugging-port=9222`),
    ]);
    assert.deepEqual(findAllAgentChromes(s), []);
  });

  it("dedupes by PID when the same process record appears twice", () => {
    const procs = new Map<number, ProcessRecord>();
    procs.set(100, rec(100, 1, "chrome.exe", `chrome.exe --remote-debugging-pipe`));
    const chromes = findAllAgentChromes({ processes: procs });
    assert.equal(chromes.length, 1);
  });

  it("does not match --remote-debugging-pipe-token-foo as a literal pipe flag", () => {
    // Defensive: ensure the regex requires a word boundary after `pipe`.
    const s = snap([
      rec(100, 1, "chrome.exe", `chrome.exe --remote-debugging-pipe-token=abc123`),
    ]);
    assert.deepEqual(findAllAgentChromes(s), []);
  });
});
