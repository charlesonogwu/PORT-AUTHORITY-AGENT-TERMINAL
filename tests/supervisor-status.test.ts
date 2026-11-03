import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getSupervisorStatus } from "../src/supervisor/client.js";
import { startSupervisorServer } from "../src/supervisor/server.js";

test("supervisor status reports running when the supervisor answers", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-supervisor-status-"));
  const server = await startSupervisorServer({
    home,
    handlers: {
      launch: async ({ laneId }) => ({ laneId, reused: false }),
      close: async ({ laneId }) => ({ laneId, closed: true }),
    },
  });
  try {
    const status = await getSupervisorStatus({ home });
    assert.equal(status.ok, true);
    assert.equal(status.running, true);
    assert.equal(status.supervisorId, server.supervisorId);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("supervisor status reports not running instead of throwing", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-supervisor-status-"));
  try {
    const status = await getSupervisorStatus({ home, timeoutMs: 500 });
    assert.equal(status.ok, false);
    assert.equal(status.running, false);
    assert.equal(typeof status.error, "string");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
