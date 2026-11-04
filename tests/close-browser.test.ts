import assert from "node:assert/strict";
import test from "node:test";
import type { Lane } from "../src/core/lane.js";
import { closeBrowserForLane } from "../src/supervisor/close-browser.js";

const lane: Lane = {
  id: "lane-close",
  owner: "codex",
  project: "project",
  cwd: "C:\\project",
  sessionId: "default",
  chromeDebugPort: 9322,
  chromeProfileDir: "C:\\safe\\profile",
  status: "active",
  createdAt: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
};

test("explicit close terminates only a reverified matching lane browser", async () => {
  const killed: number[] = [];
  const result = await closeBrowserForLane(lane, {
    scan: async () => ({
      observations: [{
        port: 9322,
        pid: 7788,
        command: "chrome.exe",
        commandLine: 'chrome.exe --user-data-dir="C:\\safe\\profile"',
        source: "native",
      }],
      source: "native",
      errors: [],
    }),
    terminate: async (pid) => { killed.push(pid); },
  });
  assert.equal(result, true);
  assert.deepEqual(killed, [7788]);
});

test("explicit close refuses a foreign profile", async () => {
  await assert.rejects(closeBrowserForLane(lane, {
    scan: async () => ({
      observations: [{
        port: 9322,
        pid: 7788,
        command: "chrome.exe",
        commandLine: 'chrome.exe --user-data-dir="C:\\personal\\profile"',
        source: "native",
      }],
      source: "native",
      errors: [],
    }),
    terminate: async () => { throw new Error("must not terminate"); },
  }), /unsafe-foreign-chrome/);
});

test("explicit close refuses a replacement process with a different pid", async () => {
  const target = { ...lane, browserPid: 1234, browserState: "active" as const };
  let terminated = false;
  await assert.rejects(
    closeBrowserForLane(target, {
      scan: async () => ({
        source: "native",
        errors: [],
        observations: [{
          port: 9322,
          pid: 9999,
          command: "chrome.exe",
          commandLine: `chrome.exe --user-data-dir=${target.chromeProfileDir}`,
          source: "native",
        }],
      }),
      terminate: async () => { terminated = true; },
    }),
    /recorded pid 1234.*observed 9999/,
  );
  assert.equal(terminated, false);
});

test("explicit close refuses pid reuse with a different process creation time", async () => {
  const target = { ...lane, browserPid: 7788, browserStartedAt: "2026-09-02T01:00:00.000Z" };
  await assert.rejects(
    closeBrowserForLane(target, {
      scan: async () => ({
        source: "native",
        errors: [],
        observations: [{
          port: 9322,
          pid: 7788,
          command: "chrome.exe",
          commandLine: `chrome.exe --user-data-dir=${target.chromeProfileDir}`,
          processStartedAt: "2026-09-02T02:00:00.000Z",
          source: "native",
        }],
      }),
      terminate: async () => { throw new Error("must not terminate"); },
    }),
    /creation identity changed/,
  );
});

test("Windows close refuses when recorded creation identity cannot be re-observed", { skip: process.platform !== "win32" && "Windows native identity rule" }, async () => {
  const target = { ...lane, browserPid: 7788, browserStartedAt: "2026-09-02T01:00:00.000Z" };
  await assert.rejects(
    closeBrowserForLane(target, {
      scan: async () => ({
        source: "native",
        errors: [],
        observations: [{
          port: 9322,
          pid: 7788,
          command: "chrome.exe",
          commandLine: `chrome.exe --user-data-dir=${target.chromeProfileDir}`,
          source: "native",
        }],
      }),
      terminate: async () => { throw new Error("must not terminate"); },
    }),
    /creation identity is unavailable/,
  );
});

test("explicit close is idempotent when the lane browser is already gone", async () => {
  const result = await closeBrowserForLane(lane, {
    scan: async () => ({ observations: [], source: "native", errors: [] }),
    terminate: async () => { throw new Error("must not terminate"); },
  });
  assert.equal(result, false);
});
