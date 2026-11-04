import assert from "node:assert/strict";
import test from "node:test";
import type { Lane } from "../src/core/lane.js";
import { markSupervisorDisconnected, reconcileBrowserLanes } from "../src/supervisor/reconcile.js";
import { persistBrowserIdentity } from "../src/supervisor/production.js";
import { listLanes, upsertLane } from "../src/core/registry.js";
import { withTempHome } from "./helpers.js";

function lane(state: Lane["browserState"] = "active"): Lane {
  return {
    id: "lane-r",
    owner: "codex",
    project: "project",
    cwd: "C:\\project",
    sessionId: "default",
    chromeDebugPort: 9322,
    chromeProfileDir: "C:\\safe\\profile",
    status: "active",
    browserState: state,
    browserPid: 1234,
    pid: 1234,
    supervisorId: "old",
    createdAt: "2026-09-02T00:00:00.000Z",
    lastSeen: "2026-09-02T00:00:00.000Z",
  };
}

test("startup reconciliation marks a matching surviving browser recoverable", () => {
  const result = reconcileBrowserLanes([lane()], [{
    port: 9322,
    pid: 5678,
    command: "chrome.exe",
    commandLine: 'chrome.exe --user-data-dir="C:\\safe\\profile"',
    processStartedAt: "2026-09-02T01:00:00.000Z",
    source: "native",
  }], "new", "2026-09-02T02:00:00.000Z")[0]!;
  assert.equal(result.browserState, "recoverable");
  assert.equal(result.browserPid, 5678);
  assert.equal(result.browserStartedAt, "2026-09-02T01:00:00.000Z");
});

test("startup reconciliation marks a missing expected browser crashed and clears pid", () => {
  const result = reconcileBrowserLanes([{ ...lane(), browserStartedAt: "2026-09-02T01:00:00.000Z" }], [], "new")[0]!;
  assert.equal(result.browserState, "crashed");
  assert.equal(result.status, "stale");
  assert.equal(result.browserPid, undefined);
  assert.equal(result.pid, undefined);
  assert.equal(result.browserStartedAt, undefined);
});

test("startup reconciliation preserves a fresh allocator reservation whose pid is the controller", () => {
  const fresh: Lane = {
    ...lane(),
    status: "reserved",
    pid: 4321,
  };
  delete fresh.browserPid;
  delete fresh.browserState;
  delete fresh.supervisorId;

  assert.deepEqual(reconcileBrowserLanes([fresh], [], "new")[0], fresh);
});

test("foreign port ownership becomes disconnected and graceful supervisor exit marks active lanes disconnected", () => {
  const foreign = reconcileBrowserLanes([lane()], [{ port: 9322, pid: 9999, command: "other.exe", source: "native" }], "new")[0]!;
  assert.equal(foreign.browserState, "disconnected");
  assert.equal(foreign.browserPid, undefined);
  assert.equal(foreign.browserStartedAt, undefined);

  const active = { ...lane(), supervisorId: "new" };
  assert.equal(markSupervisorDisconnected([active], "new")[0]?.browserState, "disconnected");
});

test("registry persistence clears the full browser identity tuple", async () => {
  await withTempHome(async () => {
    const original = { ...lane(), browserStartedAt: "2026-09-02T01:00:00.000Z" };
    await upsertLane(original);
    const closed: Lane = { ...original, status: "reserved", browserState: "closed" };
    delete closed.pid;
    delete closed.browserPid;
    delete closed.browserStartedAt;
    await persistBrowserIdentity(closed);
    const stored = (await listLanes())[0]!;
    assert.equal(stored.pid, undefined);
    assert.equal(stored.browserPid, undefined);
    assert.equal(stored.browserStartedAt, undefined);
  });
});
