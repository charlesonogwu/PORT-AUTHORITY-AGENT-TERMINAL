import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { readRegistry, listLanes, upsertLane, removeLane, markStaleLanes, setLaneStatus, touchLane, findLane } from "../src/core/registry.js";
import { Lane, REGISTRY_VERSION, nowIso } from "../src/core/lane.js";
import { registryPath } from "../src/core/paths.js";
import { writeFile } from "node:fs/promises";

function makeLane(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "lane_a",
    owner: "codex",
    project: "vend-site",
    cwd: "/tmp/vend-site",
    sessionId: "default",
    chromeProfileDir: "/tmp/profiles/codex-vend-site",
    status: "reserved",
    createdAt: nowIso(),
    lastSeen: nowIso(),
    ...overrides,
  };
}

test("readRegistry returns empty for missing file", async () => {
  await withTempHome(async () => {
    const reg = await readRegistry();
    assert.equal(reg.version, REGISTRY_VERSION);
    assert.deepEqual(reg.lanes, []);
  });
});

test("readRegistry rejects an incompatible schema instead of treating it as empty", async () => {
  await withTempHome(async () => {
    await writeFile(registryPath(), JSON.stringify({ version: 999, lanes: [] }), "utf8");
    await assert.rejects(readRegistry(), /schema version/i);
  });
});

test("upsertLane creates and updates", async () => {
  await withTempHome(async () => {
    const lane = makeLane();
    await upsertLane(lane);
    let lanes = await listLanes();
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0]!.owner, "codex");
    await upsertLane({ ...lane, task: "QA the checkout flow" });
    lanes = await listLanes();
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0]!.task, "QA the checkout flow");
  });
});

test("removeLane returns false when id not present", async () => {
  await withTempHome(async () => {
    assert.equal(await removeLane("missing"), false);
    await upsertLane(makeLane());
    assert.equal(await removeLane("lane_a"), true);
    assert.deepEqual(await listLanes(), []);
  });
});

test("setLaneStatus updates the status and lastSeen", async () => {
  await withTempHome(async () => {
    await upsertLane(makeLane());
    const updated = await setLaneStatus("lane_a", "active");
    assert.ok(updated);
    assert.equal(updated!.status, "active");
  });
});

test("touchLane updates only lastSeen", async () => {
  await withTempHome(async () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    await upsertLane(makeLane({ lastSeen: past }));
    const touched = await touchLane("lane_a");
    assert.ok(touched);
    assert.notEqual(touched!.lastSeen, past);
  });
});

test("markStaleLanes flips old reservations to stale", async () => {
  await withTempHome(async () => {
    const old = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    await upsertLane(makeLane({ lastSeen: old, status: "active" }));
    const count = await markStaleLanes();
    assert.equal(count, 1);
    const lane = await findLane({ owner: "codex", cwd: "/tmp/vend-site", status: "stale" });
    assert.ok(lane);
  });
});

test("findLane filter excludes released lanes by default", async () => {
  await withTempHome(async () => {
    await upsertLane(makeLane({ status: "released" }));
    const lane = await findLane({ owner: "codex", cwd: "/tmp/vend-site" });
    assert.equal(lane, undefined);
    const includedAll = await findLane({ owner: "codex", cwd: "/tmp/vend-site", includeReleased: true });
    assert.ok(includedAll);
  });
});
