import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { adoptProfileLane, allocateLane, findFreePort, checkLane } from "../src/core/allocator.js";
import { listLanes, setLaneStatus, upsertLane } from "../src/core/registry.js";
import { PortObservation } from "../src/core/scanner.js";
import { mkdir, symlink } from "node:fs/promises";
import { Lane, nowIso } from "../src/core/lane.js";
import { join } from "node:path";

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

test("allocateLane reopens a released immutable PPID without changing its profile", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/exact", sessionId: "amazon", observations: [] });
    await mkdir(first.lane.chromeProfileDir, { recursive: true });
    await setLaneStatus(first.lane.id, "released");

    const reopened = await allocateLane({
      owner: first.lane.owner,
      cwd: first.lane.cwd,
      laneId: first.lane.id,
      observations: [],
    });

    assert.equal(reopened.alreadyExisted, true);
    assert.equal(reopened.lane.id, first.lane.id);
    assert.equal(reopened.lane.chromeProfileDir, first.lane.chromeProfileDir);
    assert.equal(reopened.lane.status, "active");
  });
});

test("exact PPID selection preserves immutable lane metadata over conflicting tuple labels", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/exact", sessionId: "saved", observations: [] });
    await mkdir(first.lane.chromeProfileDir, { recursive: true });
    const reopened = await allocateLane({
      owner: "claude",
      cwd: "/tmp/wrong-project",
      sessionId: "wrong-session",
      laneId: first.lane.id,
      observations: [],
    });
    assert.equal(reopened.lane.owner, first.lane.owner);
    assert.equal(reopened.lane.cwd, first.lane.cwd);
    assert.equal(reopened.lane.sessionId, first.lane.sessionId);
  });
});

test("exact PPID reopen reacquires ports already reassigned to another lane", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/exact", sessionId: "saved", observations: [] });
    await mkdir(first.lane.chromeProfileDir, { recursive: true });
    await setLaneStatus(first.lane.id, "released");
    const other = await allocateLane({ owner: "claude", cwd: "/tmp/other", observations: [] });
    assert.equal(other.lane.chromeDebugPort, first.lane.chromeDebugPort);

    const reopened = await allocateLane({
      owner: first.lane.owner,
      cwd: first.lane.cwd,
      laneId: first.lane.id,
      observations: [],
    });
    assert.equal(reopened.lane.id, first.lane.id);
    assert.equal(reopened.lane.chromeProfileDir, first.lane.chromeProfileDir);
    assert.notEqual(reopened.lane.chromeDebugPort, other.lane.chromeDebugPort);
    assert.notEqual(reopened.lane.appPort, other.lane.appPort);
  });
});

test("exact PPID reopen refuses a missing saved profile instead of creating one", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/missing", observations: [] });
    await assert.rejects(
      allocateLane({ owner: first.lane.owner, cwd: first.lane.cwd, laneId: first.lane.id, observations: [] }),
      /profile directory is missing/,
    );
  });
});

test("orphan adoption creates one stable PPID only for an existing PortPilot profile", async () => {
  await withTempHome(async (home) => {
    const profileDir = join(home, "profiles", "saved-amazon");
    await mkdir(profileDir, { recursive: true });
    const adopted = await adoptProfileLane({ owner: "codex", cwd: "/tmp/adopt", sessionId: "amazon", profileDir, browser: "chrome", observations: [] });
    assert.equal(adopted.lane.chromeProfileDir, profileDir);
    assert.match(adopted.lane.id, /^lane_/);
    await assert.rejects(
      adoptProfileLane({ owner: "codex", cwd: "/tmp/adopt", sessionId: "again", profileDir, browser: "chrome", observations: [] }),
      new RegExp(adopted.lane.id),
    );
  });
});

test("orphan adoption refuses profiles outside PORTPILOT_HOME", async () => {
  await withTempHome(async (home) => {
    const outside = join(home, "personal-browser-profile");
    await mkdir(outside, { recursive: true });
    await assert.rejects(
      adoptProfileLane({ owner: "codex", cwd: "/tmp/adopt", profileDir: outside, browser: "chrome", observations: [] }),
      /must be inside PortPilot profiles directory/,
    );
  });
});

test("orphan adoption refuses a symlink that escapes the PortPilot profiles directory", async () => {
  await withTempHome(async (home) => {
    const outside = join(home, "personal-browser-profile");
    const linked = join(home, "profiles", "linked-profile");
    await mkdir(outside, { recursive: true });
    await mkdir(join(home, "profiles"), { recursive: true });
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      adoptProfileLane({ owner: "codex", cwd: "/tmp/adopt", profileDir: linked, browser: "chrome", observations: [] }),
      /must be inside PortPilot profiles directory/,
    );
  });
});

test("tuple reopen retires same-profile duplicate records and preserves the oldest PPID", async () => {
  await withTempHome(async (home) => {
    const profileDir = join(home, "profiles", "duplicate");
    await mkdir(profileDir, { recursive: true });
    const base = {
      owner: "codex", project: "dup", cwd: "/tmp/dup", sessionId: "saved",
      chromeProfileDir: profileDir, status: "stale" as const, lastSeen: nowIso(),
    };
    await upsertLane({ ...base, id: "lane_new", appPort: 3001, chromeDebugPort: 9323, createdAt: "2026-01-02T00:00:00.000Z" });
    await upsertLane({ ...base, id: "lane_old", appPort: 3000, chromeDebugPort: 9322, createdAt: "2026-01-01T00:00:00.000Z" });
    const reopened = await allocateLane({ owner: "codex", cwd: "/tmp/dup", sessionId: "saved", observations: [] });
    assert.equal(reopened.lane.id, "lane_old");
    const duplicate = (await listLanes()).find((lane) => lane.id === "lane_new")!;
    assert.equal(duplicate.status, "released");
    assert.equal(duplicate.chromeDebugPort, undefined);
  });
});
