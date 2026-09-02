import assert from "node:assert/strict";
import test from "node:test";
import type { Lane } from "../src/core/lane.js";
import type { SupervisorClient } from "../src/supervisor/client.js";
import { launchPersistentBrowser } from "../src/supervisor/routing.js";

const lane: Lane = {
  id: "lane-route",
  owner: "codex",
  project: "project",
  cwd: "C:\\project",
  sessionId: "default",
  chromeDebugPort: 9322,
  chromeProfileDir: "C:\\safe\\profile",
  status: "reserved",
  createdAt: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
};

test("persistent launch sends lane identity to the supervisor instead of spawning locally", async () => {
  const requests: unknown[] = [];
  const client: SupervisorClient = {
    ping: async () => ({ supervisorId: "s", protocolVersion: 1 }),
    launch: async (request) => {
      requests.push(request);
      return { laneId: request.laneId, pid: 9123, reused: false };
    },
    close: async ({ laneId }) => ({ laneId, closed: true }),
  };
  const result = await launchPersistentBrowser(lane, {
    mode: "background",
    binaryPath: "chrome.exe",
    initialUrl: "https://example.com",
  }, client);
  assert.deepEqual(requests, [{
    laneId: "lane-route",
    mode: "background",
    binaryPath: "chrome.exe",
    initialUrl: "https://example.com",
  }]);
  assert.equal(result.pid, 9123);
});

test("persistent launch gives an actionable error when supervisor is unavailable", async () => {
  const client: SupervisorClient = {
    ping: async () => { throw new Error("not used"); },
    launch: async () => { throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }); },
    close: async ({ laneId }) => ({ laneId, closed: false }),
  };
  await assert.rejects(
    launchPersistentBrowser(lane, {}, client),
    /PortPilot supervisor is unavailable.*dashboard/i,
  );
});
