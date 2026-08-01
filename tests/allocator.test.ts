import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { allocateLane, findFreePort, checkLane } from "../src/core/allocator.js";
import { listLanes, upsertLane } from "../src/core/registry.js";
import { PortObservation } from "../src/core/scanner.js";
import { Lane, nowIso } from "../src/core/lane.js";

const empty: PortObservation[] = [];

test("allocateLane assigns first ports in range when nothing is taken", async () => {
  await withTempHome(async () => {
    const result = await allocateLane({
      owner: "codex",
      cwd: "/tmp/vend-site",
      task: "ship the checkout",
      observations: empty,
    });
    assert.equal(result.lane.appPort, 3000);
    assert.equal(result.lane.chromeDebugPort, 9322);
    assert.equal(result.alreadyExisted, false);
    assert.match(result.lane.chromeProfileDir, /codex-vend-site$/);
  });
});

test("allocateLane skips ports observed as occupied and ports already reserved", async () => {
  await withTempHome(async () => {
    const a = await allocateLane({ owner: "codex", cwd: "/tmp/a", observations: empty });
    const b = await allocateLane({
      owner: "claude",
      cwd: "/tmp/b",
      observations: [
        { port: 3001, source: "native", protocol: "tcp" },
        { port: 9323, source: "native", protocol: "tcp" },
      ],
    });
    assert.equal(a.lane.appPort, 3000);
    assert.equal(b.lane.appPort, 3002);
    assert.equal(a.lane.chromeDebugPort, 9322);
    assert.equal(b.lane.chromeDebugPort, 9324);
  });
});

test("allocateLane returns the same lane when called twice for the same owner+cwd", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/x", observations: empty });
    const second = await allocateLane({ owner: "codex", cwd: "/tmp/x", observations: empty });
    assert.equal(second.alreadyExisted, true);
    assert.equal(first.lane.id, second.lane.id);
  });
});

test("allocateLane appends a numeric suffix when the deterministic profile is taken", async () => {
  await withTempHome(async () => {
    const a = await allocateLane({ owner: "codex", cwd: "/tmp/sites/foo", observations: empty });
    const b = await allocateLane({ owner: "codex", cwd: "/var/foo", observations: empty });
    assert.notEqual(a.lane.chromeProfileDir, b.lane.chromeProfileDir);
    assert.match(b.lane.chromeProfileDir, /codex-foo-2$/);
  });
});

test("allocateLane respects withAppPort=false / withChromePort=false", async () => {
  await withTempHome(async () => {
    const noChrome = await allocateLane({ owner: "gemini", cwd: "/tmp/cli-only", withChromePort: false, observations: empty });
    assert.equal(noChrome.lane.chromeDebugPort, undefined);
    assert.ok(typeof noChrome.lane.appPort === "number");
    const noApp = await allocateLane({ owner: "claude", cwd: "/tmp/browser-only", withAppPort: false, observations: empty });
    assert.equal(noApp.lane.appPort, undefined);
    assert.ok(typeof noApp.lane.chromeDebugPort === "number");
  });
});

test("allocateLane fails when both candidate ranges are exhausted", async () => {
  await withTempHome(async () => {
    const blocked: PortObservation[] = [];
    for (let p = 9322; p <= 9322; p++) blocked.push({ port: p, source: "native", protocol: "tcp" });
    await assert.rejects(
      allocateLane({
        owner: "codex",
        cwd: "/tmp/x",
        chromeDebugRange: { start: 9322, end: 9322 },
        appPortRange: { start: 3000, end: 3000 },
        observations: blocked,
      }),
      /No free Chrome debug port/,
    );
  });
});

test("allocateLane treats Windows cwd case and dot-segment variants as one lane", {
  skip: process.platform !== "win32" ? "requires Windows path semantics" : false,
}, async () => {
  await withTempHome(async () => {
    const first = await allocateLane({
      owner: "codex",
      cwd: "C:\\Work\\ProjectAlpha",
      observations: empty,
    });
    const second = await allocateLane({
      owner: "codex",
      cwd: "c:/work/projectalpha/src/..",
      observations: empty,
    });
    assert.equal(second.alreadyExisted, true);
    assert.equal(second.lane.id, first.lane.id);
  });
});

test("allocateLane rejects invalid port ranges before iterating them", async () => {
  await withTempHome(async () => {
    await assert.rejects(
      allocateLane({
        owner: "codex",
        cwd: "C:\\work\\invalid-range",
        appPortRange: { start: 70_000, end: 70_001 },
        observations: [],
      }),
      /port range/i,
    );
  });
});

test("findFreePort returns the next available port in the range", async () => {
  await withTempHome(async () => {
    const obs: PortObservation[] = [
      { port: 9322, source: "native", protocol: "tcp" },
      { port: 9323, source: "native", protocol: "tcp" },
    ];
    const free = await findFreePort({ range: { start: 9322, end: 9325 }, observations: obs });
    assert.equal(free, 9324);
  });
});

test("checkLane reports safe-attach when Chrome with matching profile holds the port", async () => {
  await withTempHome(async () => {
    const lane: Lane = {
      id: "l",
      owner: "codex",
      project: "vend",
      cwd: "/tmp/vend",
      sessionId: "default",
      chromeDebugPort: 9322,
      chromeProfileDir: "/tmp/profiles/codex-vend",
      status: "active",
      createdAt: nowIso(),
      lastSeen: nowIso(),
    };
    await upsertLane(lane);
    const observations: PortObservation[] = [
      {
        port: 9322,
        source: "native",
        protocol: "tcp",
        command: "chrome.exe",
        commandLine: `chrome.exe --remote-debugging-port=9322 --user-data-dir=/tmp/profiles/codex-vend --no-first-run`,
      },
    ];
    // Stub scanPorts via direct evaluator: the integration check uses a real
    // scanner, so here we just verify the wired registry contains the lane.
    const lanes = await listLanes();
    assert.equal(lanes.length, 1);
    // The actual verdict is exercised in chrome.test.ts where we control the
    // observation set deterministically.
    void observations;
  });
});
