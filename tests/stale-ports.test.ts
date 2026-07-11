import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { allocateLane } from "../src/core/allocator.js";
import { setLaneStatus } from "../src/core/registry.js";
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
