import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { allocateLane } from "../src/core/allocator.js";
import { listLanes, setLaneStatus } from "../src/core/registry.js";
import { PortObservation } from "../src/core/scanner.js";

function obs(port: number): PortObservation {
  return { port, source: "native", protocol: "tcp", command: "firefox.exe", commandLine: "firefox.exe" };
}

// A one-port range forces the allocator to either reuse that port or throw,
// which makes the reservation semantics directly observable.
const ONE_PORT = { start: 9490, end: 9490 };

test("stale lane with a DEAD browser no longer squats its port", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/a", chromeDebugRange: ONE_PORT, withAppPort: false, observations: [] });
    assert.equal(first.lane.chromeDebugPort, 9490);
    await setLaneStatus(first.lane.id, "stale");
    // Nothing listens on 9490 → a different project may take the port.
    const second = await allocateLane({ owner: "codex", cwd: "/tmp/b", chromeDebugRange: ONE_PORT, withAppPort: false, observations: [] });
    assert.equal(second.lane.chromeDebugPort, 9490);
    assert.notEqual(second.lane.id, first.lane.id);
    // CRITICAL: the reclaim must be atomic — the stale lane's claim on the
    // port is dropped in the same transaction, so exactly ONE lane holds it
    // (two lanes on one port is the dashboard-conflict bug).
    const lanes = await listLanes();
    const holders = lanes.filter((l) => l.chromeDebugPort === 9490);
    assert.equal(holders.length, 1);
    assert.equal(holders[0]!.id, second.lane.id);
    const staleAfter = lanes.find((l) => l.id === first.lane.id);
    assert.ok(staleAfter, "stale lane keeps its identity/profile");
    assert.equal(staleAfter!.chromeDebugPort, undefined);
  });
});

test("a returning lane whose port was reclaimed gets a FRESH port (same profile)", async () => {
  await withTempHome(async () => {
    const twoPorts = { start: 9490, end: 9491 };
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/a", chromeDebugRange: twoPorts, withAppPort: false, observations: [] });
    await setLaneStatus(first.lane.id, "stale");
    // Another lane reclaims 9490 while /tmp/a is away.
    await allocateLane({ owner: "codex", cwd: "/tmp/b", chromeDebugRange: { start: 9490, end: 9490 }, withAppPort: false, observations: [] });
    // /tmp/a comes back: same lane id + profile, NEW port, no double-claim.
    const back = await allocateLane({ owner: "codex", cwd: "/tmp/a", chromeDebugRange: twoPorts, withAppPort: false, observations: [] });
    assert.equal(back.alreadyExisted, true);
    assert.equal(back.lane.id, first.lane.id);
    assert.equal(back.lane.chromeProfileDir, first.lane.chromeProfileDir);
    assert.equal(back.lane.chromeDebugPort, 9491);
    assert.equal(back.lane.status, "active");
    const lanes = await listLanes();
    assert.equal(lanes.filter((l) => l.chromeDebugPort === 9490).length, 1);
    assert.equal(lanes.filter((l) => l.chromeDebugPort === 9491).length, 1);
  });
});

test("a no-chrome-port lane stays portless on reconnect when the caller still opts out", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/a", withChromePort: false, withAppPort: false, observations: [] });
    assert.equal(first.lane.chromeDebugPort, undefined);
    const again = await allocateLane({ owner: "codex", cwd: "/tmp/a", withChromePort: false, withAppPort: false, observations: [] });
    assert.equal(again.alreadyExisted, true);
    assert.equal(again.lane.chromeDebugPort, undefined);
  });
});

test("stale lane with a LIVE browser still blocks its port (occupied wins)", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/a", chromeDebugRange: ONE_PORT, withAppPort: false, observations: [] });
    await setLaneStatus(first.lane.id, "stale");
    // The stale lane's browser is still running on 9490.
    await assert.rejects(
      () => allocateLane({ owner: "codex", cwd: "/tmp/b", chromeDebugRange: ONE_PORT, withAppPort: false, observations: [obs(9490)] }),
      /No free Chrome debug port/,
    );
  });
});

test("active and reserved lanes keep hard port reservations even with no listener", async () => {
  await withTempHome(async () => {
    // A freshly reserved lane may not have launched yet — its port must stay
    // reserved even though nothing listens on it.
    await allocateLane({ owner: "codex", cwd: "/tmp/a", chromeDebugRange: ONE_PORT, withAppPort: false, observations: [] });
    await assert.rejects(
      () => allocateLane({ owner: "codex", cwd: "/tmp/b", chromeDebugRange: ONE_PORT, withAppPort: false, observations: [] }),
      /No free Chrome debug port/,
    );
  });
});
