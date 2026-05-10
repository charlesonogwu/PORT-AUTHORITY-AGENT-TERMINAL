import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { allocateLane } from "../src/core/allocator.js";
import { findLane, listLanes } from "../src/core/registry.js";
import { DEFAULT_SESSION_ID, laneSessionId, sessionSlug } from "../src/core/lane.js";
import { PortObservation } from "../src/core/scanner.js";

const empty: PortObservation[] = [];

test("sessionSlug normalizes input and falls back to default", () => {
  assert.equal(sessionSlug(undefined), DEFAULT_SESSION_ID);
  assert.equal(sessionSlug(""), DEFAULT_SESSION_ID);
  assert.equal(sessionSlug("   "), DEFAULT_SESSION_ID);
  assert.equal(sessionSlug("Task #1"), "task-1");
  assert.equal(sessionSlug("feature/auth-login"), "feature-auth-login");
  assert.equal(sessionSlug("CamelCase"), "camelcase");
});

test("laneSessionId defends against legacy lanes without the field", () => {
  assert.equal(laneSessionId({}), DEFAULT_SESSION_ID);
  assert.equal(laneSessionId({ sessionId: "" }), DEFAULT_SESSION_ID);
  assert.equal(laneSessionId({ sessionId: "task-1" }), "task-1");
});

test("two sessions for the same owner+cwd get different ports and profiles", async () => {
  await withTempHome(async () => {
    const a = await allocateLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "task-a", observations: empty });
    const b = await allocateLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "task-b", observations: empty });
    assert.notEqual(a.lane.id, b.lane.id);
    assert.notEqual(a.lane.appPort, b.lane.appPort);
    assert.notEqual(a.lane.chromeDebugPort, b.lane.chromeDebugPort);
    assert.notEqual(a.lane.chromeProfileDir, b.lane.chromeProfileDir);
    assert.match(a.lane.chromeProfileDir, /claude-proj-task-a$/);
    assert.match(b.lane.chromeProfileDir, /claude-proj-task-b$/);
  });
});

test("the same sessionId is idempotent", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "task-x", observations: empty });
    const second = await allocateLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "task-x", observations: empty });
    assert.equal(second.alreadyExisted, true);
    assert.equal(first.lane.id, second.lane.id);
  });
});

test("default session and named session coexist as separate lanes", async () => {
  await withTempHome(async () => {
    const def = await allocateLane({ owner: "claude", cwd: "/tmp/proj", observations: empty });
    const named = await allocateLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "task-1", observations: empty });
    assert.equal(laneSessionId(def.lane), DEFAULT_SESSION_ID);
    assert.equal(laneSessionId(named.lane), "task-1");
    assert.notEqual(def.lane.id, named.lane.id);
    // Default session profile has no session suffix; named one does.
    assert.match(def.lane.chromeProfileDir, /claude-proj$/);
    assert.match(named.lane.chromeProfileDir, /claude-proj-task-1$/);
  });
});

test("findLane filters by sessionId when provided", async () => {
  await withTempHome(async () => {
    await allocateLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "a", observations: empty });
    await allocateLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "b", observations: empty });
    const onlyA = await findLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "a" });
    const onlyB = await findLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "b" });
    assert.equal(laneSessionId(onlyA!), "a");
    assert.equal(laneSessionId(onlyB!), "b");
  });
});

test("findLane without sessionId returns the first matching lane (any session)", async () => {
  await withTempHome(async () => {
    await allocateLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "first", observations: empty });
    await allocateLane({ owner: "claude", cwd: "/tmp/proj", sessionId: "second", observations: empty });
    const any = await findLane({ owner: "claude", cwd: "/tmp/proj" });
    assert.ok(any);
    assert.ok(["first", "second"].includes(laneSessionId(any!)));
    const all = await listLanes();
    assert.equal(all.length, 2);
  });
});

test("many parallel sessions all get distinct ports", async () => {
  await withTempHome(async () => {
    const N = 5;
    const lanes = [];
    for (let i = 0; i < N; i++) {
      const r = await allocateLane({ owner: "codex", cwd: "/tmp/proj", sessionId: `task-${i}`, observations: empty });
      lanes.push(r.lane);
    }
    const appPorts = new Set(lanes.map((l) => l.appPort));
    const chromePorts = new Set(lanes.map((l) => l.chromeDebugPort));
    const profiles = new Set(lanes.map((l) => l.chromeProfileDir));
    assert.equal(appPorts.size, N, "every session got a distinct app port");
    assert.equal(chromePorts.size, N, "every session got a distinct Chrome debug port");
    assert.equal(profiles.size, N, "every session got a distinct profile dir");
  });
});

test("legacy lane without sessionId is treated as default and matches default queries", async () => {
  await withTempHome(async () => {
    // Manually craft a legacy lane (no sessionId field) like portpilot v0.1.0 wrote.
    const { upsertLane } = await import("../src/core/registry.js");
    const legacyLane = {
      id: "lane_legacy",
      owner: "claude",
      project: "proj",
      cwd: "/tmp/legacy",
      // sessionId intentionally omitted to simulate an older lane
      chromeProfileDir: "/tmp/profiles/claude-legacy",
      status: "active" as const,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    await upsertLane(legacyLane as unknown as Parameters<typeof upsertLane>[0]);
    const found = await findLane({ owner: "claude", cwd: "/tmp/legacy", sessionId: DEFAULT_SESSION_ID });
    assert.ok(found, "legacy lane should match a default-session query");
    // And reserving with the default session for the same cwd should be idempotent.
    const r = await allocateLane({ owner: "claude", cwd: "/tmp/legacy", observations: empty });
    assert.equal(r.alreadyExisted, true);
    assert.equal(r.lane.id, "lane_legacy");
  });
});
