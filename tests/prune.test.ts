import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import {
  DEFAULT_PRUNE_AGE_MS,
  listLanes,
  pruneReleasedLanes,
  upsertLane,
} from "../src/core/registry.js";
import { Lane, nowIso } from "../src/core/lane.js";
import { parseDurationMs } from "../src/cli/args.js";

function lane(overrides: Partial<Lane>): Lane {
  return {
    id: overrides.id ?? "lane_x",
    owner: "claude",
    project: "proj",
    cwd: "/tmp/proj",
    sessionId: "default",
    chromeProfileDir: "/tmp/proj-profile",
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
    ...overrides,
  };
}

test("parseDurationMs: handles s/m/h/d", () => {
  assert.equal(parseDurationMs("30s"), 30_000);
  assert.equal(parseDurationMs("5m"), 300_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs("7d"), 7 * 86_400_000);
});

test("parseDurationMs: rejects invalid input", () => {
  assert.equal(parseDurationMs("garbage"), undefined);
  assert.equal(parseDurationMs("5"), undefined);
  assert.equal(parseDurationMs("-1d"), undefined);
  assert.equal(parseDurationMs(""), undefined);
  assert.equal(parseDurationMs(undefined), undefined);
});

test("pruneReleasedLanes: leaves active/reserved/stale lanes alone", async () => {
  await withTempHome(async () => {
    await upsertLane(lane({ id: "active",   status: "active" }));
    await upsertLane(lane({ id: "reserved", status: "reserved" }));
    await upsertLane(lane({ id: "stale",    status: "stale" }));
    const r = await pruneReleasedLanes({ all: true });
    assert.equal(r.pruned.length, 0);
    const after = await listLanes();
    assert.equal(after.length, 3);
  });
});

test("pruneReleasedLanes --all: removes every released lane regardless of age", async () => {
  await withTempHome(async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();           // 1 min ago
    const old    = new Date(Date.now() - 7 * 86_400_000).toISOString();   // 7 days ago
    await upsertLane(lane({ id: "recent", status: "released", lastSeen: recent }));
    await upsertLane(lane({ id: "old",    status: "released", lastSeen: old }));
    await upsertLane(lane({ id: "active", status: "active" }));
    const r = await pruneReleasedLanes({ all: true });
    assert.equal(r.pruned.length, 2);
    const after = await listLanes();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, "active");
  });
});

test("pruneReleasedLanes default: keeps released lanes younger than 24h", async () => {
  await withTempHome(async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();             // 1 min ago
    const oldish = new Date(Date.now() - 12 * 60 * 60_000).toISOString();   // 12 hours ago
    const old    = new Date(Date.now() - 26 * 60 * 60_000).toISOString();   // 26 hours ago
    await upsertLane(lane({ id: "recent", status: "released", lastSeen: recent }));
    await upsertLane(lane({ id: "oldish", status: "released", lastSeen: oldish }));
    await upsertLane(lane({ id: "old",    status: "released", lastSeen: old }));
    const r = await pruneReleasedLanes(); // default 24h
    assert.equal(r.pruned.length, 1);
    assert.equal(r.pruned[0]!.id, "old");
    const after = await listLanes();
    assert.equal(after.length, 2);
  });
});

test("pruneReleasedLanes --older-than respects custom threshold", async () => {
  await withTempHome(async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const oldish = new Date(Date.now() - 12 * 60 * 60_000).toISOString();
    await upsertLane(lane({ id: "recent", status: "released", lastSeen: recent }));
    await upsertLane(lane({ id: "oldish", status: "released", lastSeen: oldish }));
    // 1 hour cutoff — both stale releases except the 1-min-ago one
    const r = await pruneReleasedLanes({ olderThanMs: 60 * 60_000 });
    assert.equal(r.pruned.length, 1);
    assert.equal(r.pruned[0]!.id, "oldish");
  });
});

test("pruneReleasedLanes --dry-run: returns candidates without writing", async () => {
  await withTempHome(async () => {
    await upsertLane(lane({ id: "old", status: "released", lastSeen: new Date(0).toISOString() }));
    await upsertLane(lane({ id: "active", status: "active" }));
    const r = await pruneReleasedLanes({ all: true, dryRun: true });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0]!.id, "old");
    assert.equal(r.pruned.length, 0);
    const after = await listLanes();
    assert.equal(after.length, 2, "registry untouched on dry-run");
  });
});

test("DEFAULT_PRUNE_AGE_MS is 24 hours", () => {
  assert.equal(DEFAULT_PRUNE_AGE_MS, 24 * 60 * 60 * 1000);
});

test("pruneReleasedLanes: handles unparseable lastSeen as 'old enough to prune'", async () => {
  await withTempHome(async () => {
    await upsertLane(lane({ id: "garbage-ts", status: "released", lastSeen: "not-a-date" }));
    const r = await pruneReleasedLanes();
    assert.equal(r.pruned.length, 1);
  });
});
