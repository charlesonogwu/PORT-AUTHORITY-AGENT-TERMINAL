import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { allocateLane } from "../src/core/allocator.js";
import { listLanes, markStaleLanes, upsertLane } from "../src/core/registry.js";
import { Lane, STALE_AFTER_MS, normalizeCwd, nowIso } from "../src/core/lane.js";
import { saveConfig } from "../src/core/config.js";
import { buildSnapshot } from "../src/dashboard/snapshot.js";
import { PortObservation } from "../src/core/scanner.js";

const empty: PortObservation[] = [];

function makeLane(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "l_x",
    owner: "claude",
    project: "p",
    cwd: "/tmp/p",
    sessionId: "default",
    chromeProfileDir: "/tmp/p/profile",
    chromeDebugPort: 9322,
    appPort: 3000,
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
    ...overrides,
  };
}

const veryOld = (): string => new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();

test("allocateLane: capacity check excludes stale lanes (zombies don't block new work)", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, maxActiveLanes: 3 });
    // Three "active" lanes whose lastSeen is too old — they're really zombies.
    for (let i = 0; i < 3; i++) {
      await upsertLane(
        makeLane({
          id: `zombie_${i}`,
          owner: "claude",
          cwd: `/tmp/zombie-${i}`,
          chromeDebugPort: 9322 + i,
          appPort: 3000 + i,
          chromeProfileDir: `/tmp/zombie-${i}/profile`,
          status: "active",
          lastSeen: veryOld(),
        }),
      );
    }
    // Cap is 3, but those three should auto-flip to stale on next allocate
    // and free up the slots. A new reservation must succeed.
    const r = await allocateLane({
      owner: "claude",
      cwd: "/tmp/fresh",
      observations: empty,
    });
    assert.equal(r.lane.owner, "claude");
    assert.equal(r.lane.cwd, normalizeCwd("/tmp/fresh"));
    // The zombies should now be in the registry as status="stale".
    const lanes = await listLanes();
    const zombies = lanes.filter((l) => l.id.startsWith("zombie_"));
    assert.equal(zombies.length, 3);
    for (const z of zombies) assert.equal(z.status, "stale");
  });
});

test("allocateLane: re-reserving an existing stale lane re-activates it (same id, same port)", async () => {
  await withTempHome(async () => {
    // Existing lane that's been silent too long — will be marked stale by allocateLane
    const original = makeLane({
      id: "lane_returning",
      owner: "claude",
      cwd: "/tmp/proj",
      sessionId: "default",
      chromeDebugPort: 9322,
      appPort: 3000,
      chromeProfileDir: "/tmp/proj/profile",
      status: "active",
      lastSeen: veryOld(),
    });
    await upsertLane(original);

    // Caller comes back asking for the same (owner, cwd, sessionId).
    const r = await allocateLane({
      owner: "claude",
      cwd: "/tmp/proj",
      observations: empty,
    });
    assert.equal(r.alreadyExisted, true, "should reuse the existing lane");
    assert.equal(r.lane.id, "lane_returning");
    assert.equal(r.lane.chromeDebugPort, 9322, "same port preserved");
    // And it should be active again, not stale, after re-reservation.
    assert.equal(r.lane.status, "active", "stale lane should re-activate on re-reservation");
    const stored = (await listLanes()).find((l) => l.id === "lane_returning")!;
    assert.equal(stored.status, "active");
  });
});

test("allocateLane: at the cap with all-stale registry, new lanes still allocate freely", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, maxActiveLanes: 5 });
    // Five lanes already at the cap, all status="stale" already.
    for (let i = 0; i < 5; i++) {
      await upsertLane(
        makeLane({
          id: `pre_stale_${i}`,
          owner: "codex",
          cwd: `/tmp/old-${i}`,
          chromeDebugPort: 9400 + i,
          appPort: 3050 + i,
          chromeProfileDir: `/tmp/old-${i}/profile`,
          status: "stale",
          lastSeen: veryOld(),
        }),
      );
    }
    // Should still allocate — stale lanes don't count.
    const r = await allocateLane({
      owner: "claude",
      cwd: "/tmp/fresh",
      observations: empty,
    });
    assert.ok(r.lane);
  });
});

test("allocateLane: cap still blocks when actually-active lanes fill it", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, maxActiveLanes: 2 });
    // Two genuinely-fresh lanes (lastSeen is now, status active).
    await upsertLane(makeLane({ id: "fresh_a", cwd: "/tmp/a", chromeDebugPort: 9322, appPort: 3000, chromeProfileDir: "/tmp/a/p" }));
    await upsertLane(makeLane({ id: "fresh_b", cwd: "/tmp/b", chromeDebugPort: 9323, appPort: 3001, chromeProfileDir: "/tmp/b/p" }));
    // Third allocation should be refused — both existing lanes are active.
    await assert.rejects(
      allocateLane({ owner: "claude", cwd: "/tmp/c", observations: empty }),
      /MAX_ACTIVE_LANES_REACHED/,
    );
  });
});

test("buildSnapshot: marks stale lanes (zombies) on every snapshot", async () => {
  // Originally this test asserted the capacity meter reflected only fresh
  // lanes. The capacity stat was removed from the dashboard entirely, so
  // the contract this test now guards is just the stale-flip: zombies in
  // the registry should be persisted as status="stale" by the snapshot.
  await withTempHome(async () => {
    await saveConfig({ version: 1, maxActiveLanes: 20 });
    for (let i = 0; i < 12; i++) {
      await upsertLane(
        makeLane({
          id: `zombie_${i}`,
          owner: "codex",
          cwd: `/tmp/zombie-${i}`,
          chromeDebugPort: 9400 + i,
          appPort: 3050 + i,
          chromeProfileDir: `/tmp/zombie-${i}/profile`,
          status: "active",
          lastSeen: veryOld(),
        }),
      );
    }
    await upsertLane(
      makeLane({
        id: "fresh_one",
        owner: "claude",
        cwd: "/tmp/fresh",
        chromeDebugPort: 9500,
        appPort: 3100,
        chromeProfileDir: "/tmp/fresh/profile",
        status: "active",
        lastSeen: nowIso(),
      }),
    );
    await buildSnapshot({ cdpTimeoutMs: 200 });
    // Zombies are persisted as status="stale" in the registry.
    const lanes = await listLanes();
    const zombies = lanes.filter((l) => l.id.startsWith("zombie_"));
    assert.equal(zombies.length, 12);
    for (const z of zombies) assert.equal(z.status, "stale");
  });
});

test("markStaleLanes: short-circuits when nothing needs flipping (no-op cheap path)", async () => {
  await withTempHome(async () => {
    // No lanes — should return 0 without touching the registry.
    const n0 = await markStaleLanes();
    assert.equal(n0, 0);
    // Add one fresh lane — markStaleLanes must NOT flip it.
    await upsertLane(makeLane({ status: "active", lastSeen: nowIso() }));
    const n1 = await markStaleLanes();
    assert.equal(n1, 0);
    const stored = (await listLanes())[0]!;
    assert.equal(stored.status, "active");
  });
});

test("markStaleLanes: flips and persists when at least one lane is too old", async () => {
  await withTempHome(async () => {
    await upsertLane(makeLane({ id: "old", status: "active", lastSeen: veryOld() }));
    await upsertLane(makeLane({ id: "fresh", status: "active", lastSeen: nowIso(), chromeDebugPort: 9323, appPort: 3001 }));
    const n = await markStaleLanes();
    assert.equal(n, 1);
    const lanes = await listLanes();
    const old = lanes.find((l) => l.id === "old")!;
    const fresh = lanes.find((l) => l.id === "fresh")!;
    assert.equal(old.status, "stale");
    assert.equal(fresh.status, "active");
  });
});
