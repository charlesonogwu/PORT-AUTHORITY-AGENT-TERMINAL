import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withTempHome } from "./helpers.js";
import { allocateLane, checkLane, findFreePort } from "../src/core/allocator.js";
import { closeBrowserForLane } from "../src/supervisor/close-browser.js";
import { reconcileBrowserLanes } from "../src/supervisor/reconcile.js";
import { describePortHolder, evaluateBrowserAttachLive } from "../src/core/browsers.js";
import { nowIso, type Lane } from "../src/core/lane.js";
import type { PortProbe, PortProbeResult } from "../src/core/port-probe.js";
import type { PortTruthDependencies, ProcessRecord } from "../src/core/port-truth.js";
import { createBrowserOwner } from "../src/supervisor/browser-owner.js";
import { createSupervisorClient, SupervisorReplyError, type SupervisorClient } from "../src/supervisor/client.js";
import { launchPersistentBrowser } from "../src/supervisor/routing.js";
import { startSupervisorServer } from "../src/supervisor/server.js";

const CHROME_RANGE = { start: 9490, end: 9493 };
const APP_RANGE = { start: 3490, end: 3493 };

function probeWith(busy: Iterable<number>): PortProbe {
  const held = new Set(busy);
  return async (port: number): Promise<PortProbeResult> => (held.has(port) ? "busy" : "free");
}

function browserOn(port: number, profile: string, pid: number): ProcessRecord {
  return {
    pid,
    name: "chrome.exe",
    commandLine: `"chrome.exe" --remote-debugging-port=${port} --user-data-dir=${profile} --no-first-run`,
    startedAt: "2026-11-03T07:51:29.6088190Z",
  };
}

function truth(busy: Iterable<number>, processes: ProcessRecord[] = []): PortTruthDependencies {
  return { probe: probeWith(busy), listDebugPortProcesses: async () => processes };
}

function laneOn(port: number, profile: string): Lane {
  return {
    id: "lane-live",
    owner: "claude",
    project: "linux-box",
    cwd: "C:\\work\\linux-box",
    sessionId: "default",
    chromeDebugPort: port,
    chromeProfileDir: profile,
    status: "reserved",
    createdAt: nowIso(),
    lastSeen: nowIso(),
  };
}

test("a new lane never gets a debug port or app port that the kernel says is taken", async () => {
  await withTempHome(async () => {
    // The listener table is empty (it silently dropped the listeners); the
    // kernel probe knows better.
    const result = await allocateLane({
      owner: "claude",
      cwd: "/tmp/linux-box",
      chromeDebugRange: CHROME_RANGE,
      appPortRange: APP_RANGE,
      observations: [],
      portTruth: truth([9490, 3490]),
    });
    assert.equal(result.lane.chromeDebugPort, 9491);
    assert.equal(result.lane.appPort, 3491);
  });
});

test("allocation fails loudly when every port in range is taken, even if the table looks empty", async () => {
  await withTempHome(async () => {
    await assert.rejects(
      allocateLane({
        owner: "claude",
        cwd: "/tmp/full",
        chromeDebugRange: { start: 9490, end: 9491 },
        withAppPort: false,
        observations: [],
        portTruth: truth([9490, 9491]),
      }),
      /No free Chrome debug port/,
    );
  });
});

test("findFreePort skips ports the kernel says are taken", async () => {
  await withTempHome(async () => {
    const port = await findFreePort({ range: CHROME_RANGE, observations: [], portTruth: truth([9490, 9491]) });
    assert.equal(port, 9492);
  });
});

test("an unknown probe answer falls back to the listener table instead of blocking allocation", async () => {
  await withTempHome(async () => {
    const result = await allocateLane({
      owner: "claude",
      cwd: "/tmp/unknown",
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: { probe: async () => "unknown", listDebugPortProcesses: async () => [] },
    });
    assert.equal(result.lane.chromeDebugPort, 9490);
  });
});

test("reconnecting moves a lane off a debug port that another browser verifiably holds", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({
      owner: "claude",
      cwd: "/tmp/linux-box",
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: truth([]),
    });
    assert.equal(first.lane.chromeDebugPort, 9490);
    // Another agent's browser now serves 9490; the table does not show it.
    const again = await allocateLane({
      owner: "claude",
      cwd: "/tmp/linux-box",
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: truth([9490], [browserOn(9490, "C:\\pp\\profiles\\opencode-chinese-coolers", 47648)]),
    });
    assert.equal(again.alreadyExisted, true);
    assert.equal(again.lane.id, first.lane.id);
    assert.equal(again.lane.chromeProfileDir, first.lane.chromeProfileDir);
    assert.equal(again.lane.chromeDebugPort, 9491);
  });
});

test("reconnecting keeps the lane's port while its own browser serves it", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({
      owner: "claude",
      cwd: "/tmp/own",
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: truth([]),
    });
    const again = await allocateLane({
      owner: "claude",
      cwd: "/tmp/own",
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: truth([9490], [browserOn(9490, first.lane.chromeProfileDir, 7001)]),
    });
    assert.equal(again.lane.chromeDebugPort, 9490);
  });
});

test("reconnecting keeps the port when PortPilot cannot tell who holds it", async () => {
  await withTempHome(async () => {
    await allocateLane({
      owner: "claude",
      cwd: "/tmp/unidentified",
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: truth([]),
    });
    // Busy, but no browser claims it and the table has no row: moving the lane
    // could orphan its own browser, so keep the port and let the launch gate refuse.
    const again = await allocateLane({
      owner: "claude",
      cwd: "/tmp/unidentified",
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: truth([9490]),
    });
    assert.equal(again.lane.chromeDebugPort, 9490);
  });
});

test("reopening an exact PPID keeps its port when PortPilot cannot tell who holds it", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({
      owner: "codex",
      cwd: "/tmp/saved-login",
      sessionId: "amazon",
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: truth([]),
    });
    await mkdir(first.lane.chromeProfileDir, { recursive: true });
    // Busy, and the process list failed: the holder may be this lane's own browser.
    const reopened = await allocateLane({
      owner: first.lane.owner,
      cwd: first.lane.cwd,
      laneId: first.lane.id,
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: { probe: probeWith([9490]), listDebugPortProcesses: async () => { throw new Error("cim timed out"); } },
    });
    assert.equal(reopened.lane.chromeDebugPort, 9490);
  });
});

test("reopening an exact PPID moves off a port another browser verifiably holds", async () => {
  await withTempHome(async () => {
    const first = await allocateLane({
      owner: "codex",
      cwd: "/tmp/saved-login",
      sessionId: "amazon",
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: truth([]),
    });
    await mkdir(first.lane.chromeProfileDir, { recursive: true });
    const reopened = await allocateLane({
      owner: first.lane.owner,
      cwd: first.lane.cwd,
      laneId: first.lane.id,
      chromeDebugRange: CHROME_RANGE,
      withAppPort: false,
      observations: [],
      portTruth: truth([9490], [browserOn(9490, "C:\\pp\\profiles\\someone-else", 3131)]),
    });
    assert.equal(reopened.lane.id, first.lane.id);
    assert.equal(reopened.lane.chromeProfileDir, first.lane.chromeProfileDir);
    assert.equal(reopened.lane.chromeDebugPort, 9491);
  });
});

test("supervisor start-up keeps a lane's browser identity when the port holder is unidentified", () => {
  const running: Lane = {
    ...laneOn(9322, "C:\\pp\\profiles\\claude-linux-box"),
    status: "active",
    browserState: "active",
    pid: 47648,
    browserPid: 47648,
    browserStartedAt: "2026-11-03T07:51:29.6088190Z",
  };
  const [after] = reconcileBrowserLanes([running], [{ port: 9322, protocol: "tcp", source: "native" }], "supervisor-new");
  assert.deepEqual(after, running);
});

test("close finds the lane's browser even when the listener table leaves it out", async () => {
  const profile = "C:\\pp\\profiles\\claude-linux-box";
  const killed: number[] = [];
  const closed = await closeBrowserForLane(laneOn(9322, profile), {
    scan: async () => ({ observations: [], source: "native", errors: [] }),
    portTruth: truth([9322], [browserOn(9322, profile, 5150)]),
    terminate: async (pid) => { killed.push(pid); },
  });
  assert.equal(closed, true);
  assert.deepEqual(killed, [5150]);
});

test("close refuses, rather than reporting 'already closed', when it cannot identify the port holder", async () => {
  await assert.rejects(
    closeBrowserForLane(laneOn(9322, "C:\\pp\\profiles\\claude-linux-box"), {
      scan: async () => ({ observations: [], source: "native", errors: [] }),
      portTruth: { probe: probeWith([9322]), listDebugPortProcesses: async () => { throw new Error("cim timed out"); } },
      terminate: async () => { throw new Error("must not terminate"); },
    }),
    /refusing to close lane lane-live: unsafe-unknown/,
  );
});

test("checkLane sees the lane's own browser when the listener table leaves its port out", async () => {
  const profile = "C:\\pp\\profiles\\claude-check";
  const result = await checkLane(laneOn(9497, profile), truth([9497], [browserOn(9497, profile, 6061)]));
  assert.equal(result.verdict.kind, "safe-attach");
});

test("live attach verdict finds the lane's own browser when the listener table omits it", async () => {
  const profile = "C:\\pp\\profiles\\claude-linux-box";
  const verdict = await evaluateBrowserAttachLive(laneOn(9322, profile), [], truth([9322], [browserOn(9322, profile, 5150)]));
  assert.equal(verdict.kind, "safe-attach");
  assert.equal(verdict.kind === "safe-attach" ? verdict.observation.pid : undefined, 5150);
});

test("live attach verdict refuses a foreign browser that the listener table omits", async () => {
  const verdict = await evaluateBrowserAttachLive(
    laneOn(9322, "C:\\pp\\profiles\\claude-linux-box"),
    [],
    truth([9322], [browserOn(9322, "C:\\pp\\profiles\\opencode-chinese-coolers", 47648)]),
  );
  assert.equal(verdict.kind, "unsafe-foreign-chrome");
  assert.equal(verdict.kind === "unsafe-foreign-chrome" ? verdict.foundProfile : undefined, "C:\\pp\\profiles\\opencode-chinese-coolers");
});

test("live attach verdict treats a stale listener-table row as free when the kernel says so", async () => {
  const verdict = await evaluateBrowserAttachLive(
    laneOn(9322, "C:\\pp\\profiles\\claude-linux-box"),
    [{ port: 9322, pid: 0, source: "native", protocol: "tcp" }],
    truth([]),
  );
  assert.equal(verdict.kind, "safe-free");
});

test("describePortHolder names the browser and profile that hold a lane's port", () => {
  const text = describePortHolder({
    kind: "unsafe-foreign-chrome",
    port: 9322,
    observation: { port: 9322, pid: 47648, command: "chrome.exe", source: "native" },
    foundProfile: "C:\\pp\\profiles\\opencode-chinese-coolers",
  });
  assert.match(text ?? "", /debug port 9322/);
  assert.match(text ?? "", /another browser/);
  assert.match(text ?? "", /pid 47648/);
  assert.match(text ?? "", /opencode-chinese-coolers/);
  assert.match(describePortHolder({ kind: "unsafe-unknown", port: 3000, observation: { port: 3000, source: "native" } }) ?? "", /could not identify/);
  assert.equal(describePortHolder({ kind: "safe-free", port: 9322 }), undefined);
});

test("the supervisor explains which browser holds a lane's port when it refuses to launch", async () => {
  const owner = createBrowserOwner({
    supervisorId: "supervisor-live",
    getLane: async () => laneOn(9322, "C:\\pp\\profiles\\claude-linux-box"),
    check: async () => ({
      kind: "unsafe-foreign-chrome",
      port: 9322,
      observation: { port: 9322, pid: 47648, command: "chrome.exe", source: "native" },
      foundProfile: "C:\\pp\\profiles\\opencode-chinese-coolers",
    }),
    launch: async () => { throw new Error("must not launch"); },
    persist: async () => { throw new Error("must not mutate"); },
    close: async () => true,
  });
  await assert.rejects(
    owner.launch({ laneId: "lane-live" }),
    /unsafe to launch lane lane-live: unsafe-foreign-chrome.*debug port 9322.*opencode-chinese-coolers/,
  );
});

test("a supervisor refusal reaches the agent as a refusal, not as 'supervisor unavailable'", async () => {
  const client: SupervisorClient = {
    ping: async () => ({ supervisorId: "s", protocolVersion: 1 }),
    launch: async () => { throw new SupervisorReplyError("unsafe to launch lane lane-live: unsafe-foreign-chrome"); },
    close: async ({ laneId }) => ({ laneId, closed: false }),
  };
  await assert.rejects(launchPersistentBrowser(laneOn(9322, "C:\\pp\\p"), {}, client), (error: Error) => {
    assert.doesNotMatch(error.message, /unavailable|dashboard/i);
    assert.match(error.message, /lane-live/);
    assert.match(error.message, /unsafe-foreign-chrome/);
    return true;
  });
});

test("the supervisor client marks error replies as supervisor refusals", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-reply-error-"));
  const supervisor = await startSupervisorServer({
    home,
    handlers: {
      launch: async () => { throw new Error("unsafe to launch lane x: unsafe-unknown"); },
      close: async ({ laneId }) => ({ laneId, closed: false }),
    },
  });
  try {
    await assert.rejects(createSupervisorClient({ home }).launch({ laneId: "x" }), (error: Error) => {
      assert.ok(error instanceof SupervisorReplyError, "error replies are SupervisorReplyError");
      assert.match(error.message, /unsafe-unknown/);
      return true;
    });
  } finally {
    await supervisor.close();
    await rm(home, { recursive: true, force: true });
  }
});
