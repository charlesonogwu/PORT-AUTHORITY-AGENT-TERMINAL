import assert from "node:assert/strict";
import test from "node:test";
import type { ChromeAttachVerdict } from "../src/core/chrome.js";
import type { Lane } from "../src/core/lane.js";
import { createBrowserOwner } from "../src/supervisor/browser-owner.js";

function lane(): Lane {
  return {
    id: "lane-a",
    owner: "codex",
    project: "project",
    cwd: "C:\\project",
    sessionId: "default",
    chromeDebugPort: 9322,
    chromeProfileDir: "C:\\temp\\portpilot\\profiles\\lane-a",
    status: "reserved",
    createdAt: "2026-09-02T00:00:00.000Z",
    lastSeen: "2026-09-02T00:00:00.000Z",
  };
}

test("browser owner launches a free lane and records supervisor-owned identity", async () => {
  const original = lane();
  const writes: Lane[] = [];
  let launches = 0;
  let checks = 0;
  const owner = createBrowserOwner({
    supervisorId: "supervisor-a",
    getLane: async (id) => id === original.id ? original : undefined,
    check: async () => checks++ === 0
      ? ({ kind: "safe-free", port: 9322 })
      : ({
          kind: "safe-attach",
          port: 9322,
          observation: { port: 9322, pid: 7788, command: "chrome.exe", commandLine: `chrome.exe --user-data-dir=${original.chromeProfileDir}`, source: "native" },
        }),
    launch: async (resolvedLane) => {
      launches += 1;
      assert.equal(resolvedLane, original);
      return { binary: "chrome.exe", args: [], pid: 7788, spawned: true, mode: "visible" };
    },
    persist: async (updated) => { writes.push(updated); },
    close: async () => true,
  });

  const result = await owner.launch({ laneId: "lane-a", mode: "visible" });
  assert.deepEqual(result, {
    laneId: "lane-a",
    pid: 7788,
    reused: false,
    command: { binary: "chrome.exe", args: [] },
    mode: "visible",
  });
  assert.equal(launches, 1);
  assert.equal(writes[0]?.browserState, "starting");
  assert.equal(writes[1]?.browserState, "active");
  assert.equal(writes[1]?.browserPid, 7788);
  assert.equal(writes[1]?.supervisorId, "supervisor-a");
});

test("browser owner serializes concurrent launches and reuses the first browser", async () => {
  const original = lane();
  let live = false;
  let launches = 0;
  const owner = createBrowserOwner({
    supervisorId: "supervisor-lock",
    getLane: async () => original,
    check: async () => live
      ? ({ kind: "safe-attach", port: 9322, observation: { port: 9322, pid: 8800, command: "chrome.exe", commandLine: `chrome.exe --user-data-dir=${original.chromeProfileDir}`, source: "native" } })
      : ({ kind: "safe-free", port: 9322 }),
    launch: async () => {
      launches += 1;
      live = true;
      return { binary: "chrome.exe", args: [], pid: 8800, spawned: true, mode: "visible" };
    },
    persist: async () => {},
    close: async () => true,
    verifyDelayMs: 0,
  });

  const [first, second] = await Promise.all([
    owner.launch({ laneId: original.id }),
    owner.launch({ laneId: original.id }),
  ]);
  assert.equal(launches, 1);
  assert.equal(first.pid, 8800);
  assert.equal(second.pid, 8800);
  assert.equal(second.reused, true);
});

test("browser owner reconnects to a matching live browser without relaunching", async () => {
  const original = lane();
  let launches = 0;
  const writes: Lane[] = [];
  const verdict: ChromeAttachVerdict = {
    kind: "safe-attach",
    port: 9322,
    observation: {
      port: 9322,
      pid: 9911,
      command: "chrome.exe",
      commandLine: `chrome.exe --user-data-dir=${original.chromeProfileDir}`,
      source: "native",
    },
  };
  const owner = createBrowserOwner({
    supervisorId: "supervisor-b",
    getLane: async () => original,
    check: async () => verdict,
    launch: async () => { launches += 1; return { binary: "chrome.exe", args: [], pid: 1, spawned: true, mode: "visible" }; },
    persist: async (updated) => { writes.push(updated); },
    close: async () => true,
  });

  const result = await owner.launch({ laneId: "lane-a" });
  assert.deepEqual(result, { laneId: "lane-a", pid: 9911, reused: true });
  assert.equal(launches, 0);
  assert.equal(writes.at(-1)?.browserState, "active");
  assert.equal(writes.at(-1)?.browserPid, 9911);
});

test("Firefox adopts the verified main-process pid when its launcher pid differs", async () => {
  const original = { ...lane(), browser: "firefox" as const };
  let checks = 0;
  const writes: Lane[] = [];
  const owner = createBrowserOwner({
    supervisorId: "supervisor-firefox",
    getLane: async () => original,
    check: async () => checks++ === 0
      ? ({ kind: "safe-free", port: 9322 })
      : ({ kind: "safe-attach", port: 9322, observation: { port: 9322, pid: 2222, command: "firefox.exe", commandLine: `firefox.exe -profile ${original.chromeProfileDir}`, source: "native" } }),
    launch: async () => ({ binary: "firefox.exe", args: [], pid: 1111, spawned: true, mode: "visible" }),
    persist: async (updated) => { writes.push(updated); },
    close: async () => true,
    verifyDelayMs: 0,
  });
  const result = await owner.launch({ laneId: original.id });
  assert.equal(result.pid, 2222);
  assert.equal(writes.at(-1)?.browserPid, 2222);
  assert.equal(writes.at(-1)?.browserState, "active");
});

test("browser owner fails closed when a foreign process owns the lane port", async () => {
  const original = lane();
  const owner = createBrowserOwner({
    supervisorId: "supervisor-c",
    getLane: async () => original,
    check: async () => ({
      kind: "unsafe-unknown",
      port: 9322,
      observation: { port: 9322, pid: 555, command: "other.exe", source: "native" },
    }),
    launch: async () => { throw new Error("must not launch"); },
    persist: async () => { throw new Error("must not mutate"); },
    close: async () => true,
  });

  await assert.rejects(owner.launch({ laneId: "lane-a" }), /unsafe-unknown/);
});

test("browser owner marks a failed launch as crashed", async () => {
  const original = { ...lane(), pid: 4444, browserPid: 4444, browserStartedAt: "2026-09-02T00:30:00.000Z" };
  const writes: Lane[] = [];
  const owner = createBrowserOwner({
    supervisorId: "supervisor-d",
    getLane: async () => original,
    check: async () => ({ kind: "safe-free", port: 9322 }),
    launch: async () => { throw new Error("spawn failed"); },
    persist: async (updated) => { writes.push(updated); },
    close: async () => true,
  });

  await assert.rejects(owner.launch({ laneId: "lane-a" }), /spawn failed/);
  assert.equal(writes.at(-1)?.browserState, "crashed");
  assert.equal(writes.at(-1)?.browserPid, undefined);
  assert.equal(writes.at(-1)?.pid, undefined);
  assert.equal(writes.at(-1)?.browserStartedAt, undefined);
});

test("browser owner records an explicit close even when the process already exited", async () => {
  const original = {
    ...lane(),
    status: "active" as const,
    pid: 7788,
    browserPid: 7788,
    browserStartedAt: "2026-09-02T00:30:00.000Z",
    browserState: "active" as const,
  };
  const writes: Lane[] = [];
  const owner = createBrowserOwner({
    supervisorId: "supervisor-e",
    getLane: async () => original,
    check: async () => ({ kind: "safe-free", port: 9322 }),
    launch: async () => { throw new Error("must not launch"); },
    persist: async (updated) => { writes.push(updated); },
    close: async () => false,
  });

  const result = await owner.close({ laneId: "lane-a" });
  assert.deepEqual(result, { laneId: "lane-a", closed: false });
  assert.equal(writes.at(-1)?.browserState, "closed");
  assert.equal(writes.at(-1)?.status, "reserved");
  assert.equal(writes.at(-1)?.browserPid, undefined);
  assert.equal(writes.at(-1)?.pid, undefined);
  assert.equal(writes.at(-1)?.browserStartedAt, undefined);
});

test("close is serialized behind an in-flight launch for the same lane", async () => {
  const original = lane();
  let live = false;
  let releaseLaunch!: () => void;
  const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  let launchEntered!: () => void;
  const entered = new Promise<void>((resolve) => { launchEntered = resolve; });
  const states: Array<Lane["browserState"]> = [];
  const owner = createBrowserOwner({
    supervisorId: "supervisor-race",
    getLane: async () => original,
    check: async () => live
      ? ({ kind: "safe-attach", port: 9322, observation: { port: 9322, pid: 7700, command: "chrome.exe", commandLine: `chrome.exe --user-data-dir=${original.chromeProfileDir}`, source: "native" } })
      : ({ kind: "safe-free", port: 9322 }),
    launch: async () => {
      launchEntered();
      await launchGate;
      live = true;
      return { binary: "chrome.exe", args: [], pid: 7700, spawned: true, mode: "visible" };
    },
    persist: async (updated) => { states.push(updated.browserState); },
    close: async () => { live = false; return true; },
    verifyDelayMs: 0,
  });

  const launching = owner.launch({ laneId: original.id });
  await entered;
  const closing = owner.close({ laneId: original.id });
  releaseLaunch();
  await Promise.all([launching, closing]);
  assert.deepEqual(states, ["starting", "active", "closed"]);
});

test("launch verification has an absolute deadline and leaves a spawned browser recoverable without a guessed creation time", async () => {
  const original = lane();
  const writes: Lane[] = [];
  let checks = 0;
  const owner = createBrowserOwner({
    supervisorId: "supervisor-timeout",
    getLane: async () => original,
    check: async () => {
      if (checks++ === 0) return { kind: "safe-free", port: 9322 };
      return { kind: "safe-free", port: 9322 };
    },
    launch: async () => ({ binary: "chrome.exe", args: [], pid: 9912, spawned: true, mode: "visible" }),
    persist: async (updated) => { writes.push(updated); },
    close: async () => true,
    operationTimeoutMs: 25,
    verifyAttempts: 10,
    verifyDelayMs: 20,
  });

  const started = Date.now();
  await assert.rejects(owner.launch({ laneId: original.id }), /deadline exceeded/);
  assert.ok(Date.now() - started < 100, "the server-side deadline must bound retries and sleeps");
  assert.equal(writes.at(-1)?.browserState, "recoverable");
  assert.equal(writes.at(-1)?.browserPid, 9912);
  assert.equal(writes.at(-1)?.browserStartedAt, undefined);
});

test("a deadline expiring during registry persistence prevents the browser spawn", async () => {
  const original = lane();
  let launches = 0;
  let writes = 0;
  const owner = createBrowserOwner({
    supervisorId: "supervisor-persist-timeout",
    getLane: async () => original,
    check: async () => ({ kind: "safe-free", port: 9322 }),
    launch: async () => {
      launches += 1;
      return { binary: "chrome.exe", args: [], pid: 1234, spawned: true, mode: "visible" };
    },
    persist: async () => {
      writes += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    close: async () => true,
    operationTimeoutMs: 10,
  });

  await assert.rejects(owner.launch({ laneId: original.id }), /deadline exceeded/);
  assert.equal(launches, 0);
  assert.equal(writes, 1, "an expired pre-spawn operation must not wait on a second cleanup write");
});
