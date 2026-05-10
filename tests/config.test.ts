import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import {
  CapacityError,
  configForMachine,
  configPath,
  DEFAULT_CONFIG,
  loadConfig,
  recommendForMachine,
  saveConfig,
} from "../src/core/config.js";
import { allocateLane } from "../src/core/allocator.js";
import { PortObservation } from "../src/core/scanner.js";

const empty: PortObservation[] = [];

test("loadConfig returns defaults when file is missing", async () => {
  await withTempHome(async () => {
    const cfg = await loadConfig();
    assert.equal(cfg.version, 1);
    assert.deepEqual(cfg.chromeDebugRange, DEFAULT_CONFIG.chromeDebugRange);
    assert.equal(cfg.maxActiveLanes, undefined);
  });
});

test("saveConfig + loadConfig roundtrip", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, maxActiveLanes: 7, warnAtActiveLanes: 5 });
    const cfg = await loadConfig();
    assert.equal(cfg.maxActiveLanes, 7);
    assert.equal(cfg.warnAtActiveLanes, 5);
  });
});

test("recommendForMachine clamps small machines to >= 2", () => {
  const rec = recommendForMachine(2 * 1024 ** 3); // 2 GB
  assert.ok(rec.recommendedMaxActiveLanes >= 2);
  assert.ok(rec.recommendedMaxActiveLanes <= 78);
});

test("recommendForMachine on 32GB returns a sensible cap", () => {
  const rec = recommendForMachine(32 * 1024 ** 3);
  assert.ok(rec.recommendedMaxActiveLanes >= 15);
  assert.ok(rec.recommendedMaxActiveLanes <= 78);
  assert.ok(rec.recommendedWarnAtActiveLanes < rec.recommendedMaxActiveLanes);
});

test("recommendForMachine on a 256GB workstation caps at 78", () => {
  const rec = recommendForMachine(256 * 1024 ** 3);
  assert.equal(rec.recommendedMaxActiveLanes, 78);
});

test("configForMachine fills in only missing fields", () => {
  const { config } = configForMachine({ version: 1, maxActiveLanes: 5 });
  assert.equal(config.maxActiveLanes, 5, "user-set value preserved");
  assert.ok(typeof config.warnAtActiveLanes === "number", "missing field filled in");
  assert.ok(config.chromeDebugRange);
  assert.ok(config.appPortRange);
});

test("allocateLane enforces maxActiveLanes when configured", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, maxActiveLanes: 2 });
    await allocateLane({ owner: "claude", cwd: "/tmp/a", observations: empty });
    await allocateLane({ owner: "claude", cwd: "/tmp/b", observations: empty });
    await assert.rejects(
      allocateLane({ owner: "claude", cwd: "/tmp/c", observations: empty }),
      (err: unknown) => err instanceof CapacityError && (err as CapacityError).code === "MAX_ACTIVE_LANES_REACHED",
    );
  });
});

test("allocateLane releases free up capacity", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, maxActiveLanes: 1 });
    const a = await allocateLane({ owner: "claude", cwd: "/tmp/a", observations: empty });
    await assert.rejects(allocateLane({ owner: "claude", cwd: "/tmp/b", observations: empty }), CapacityError);
    // Release the first lane
    const { setLaneStatus } = await import("../src/core/registry.js");
    await setLaneStatus(a.lane.id, "released");
    // Now a new allocation succeeds
    const b = await allocateLane({ owner: "claude", cwd: "/tmp/b", observations: empty });
    assert.notEqual(b.lane.id, a.lane.id);
  });
});

test("re-reservation of an existing lane is allowed even at the cap", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, maxActiveLanes: 1 });
    const first = await allocateLane({ owner: "claude", cwd: "/tmp/a", observations: empty });
    // At the cap, but this is the SAME (owner, cwd, sessionId) so should be idempotent.
    const second = await allocateLane({ owner: "claude", cwd: "/tmp/a", observations: empty });
    assert.equal(second.alreadyExisted, true);
    assert.equal(first.lane.id, second.lane.id);
  });
});

test("allocateLane returns a soft warning when warnAtActiveLanes is reached", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, maxActiveLanes: 5, warnAtActiveLanes: 2 });
    const r1 = await allocateLane({ owner: "a", cwd: "/tmp/x", observations: empty });
    assert.equal(r1.warning, undefined);
    const r2 = await allocateLane({ owner: "b", cwd: "/tmp/y", observations: empty });
    assert.ok(r2.warning, "second allocation should produce a soft warning at threshold 2");
    assert.equal(r2.activeLaneCount, 2);
  });
});

test("config-supplied chromeDebugRange is used when caller omits it", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, chromeDebugRange: { start: 9500, end: 9501 }, appPortRange: { start: 4000, end: 4001 } });
    const r = await allocateLane({ owner: "claude", cwd: "/tmp/x", observations: empty });
    assert.equal(r.lane.chromeDebugPort, 9500);
    assert.equal(r.lane.appPort, 4000);
  });
});

test("configPath points inside PORTPILOT_HOME", async () => {
  await withTempHome(async (home) => {
    assert.ok(configPath().toLowerCase().startsWith(home.toLowerCase()));
  });
});
