import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSupervisorClient,
  supervisorRequestTimeout,
  supervisorEndpoint,
  supervisorTokenPath,
} from "../src/supervisor/client.js";
import { startSupervisorServer } from "../src/supervisor/server.js";

test("supervisor launch timeout exceeds the full cold-start verification budget", () => {
  assert.ok(supervisorRequestTimeout("launch") >= 35_000);
  assert.equal(supervisorRequestTimeout("ping"), 3_000);
  assert.equal(supervisorRequestTimeout("launch", 123), 123);
});

test("supervisor serves authenticated ping and dispatches lane-only launch requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-supervisor-"));
  const launches: string[] = [];
  const server = await startSupervisorServer({
    home,
    handlers: {
      launch: async ({ laneId }) => {
        launches.push(laneId);
        return { laneId, pid: 4242, reused: false };
      },
      close: async ({ laneId }) => ({ laneId, closed: true }),
    },
  });
  try {
    const client = createSupervisorClient({ home, timeoutMs: 1_000 });
    const pong = await client.ping();
    assert.equal(pong.supervisorId, server.supervisorId);

    const launched = await client.launch({ laneId: "lane-safe" });
    assert.deepEqual(launched, { laneId: "lane-safe", pid: 4242, reused: false });
    assert.deepEqual(launches, ["lane-safe"]);

    const token = await readFile(supervisorTokenPath(home), "utf8");
    assert.equal(token.trim().length, 64);
    assert.ok(supervisorEndpoint(home).length > 0);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("supervisor ping does not report ready before startup reconciliation finishes", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-supervisor-ready-"));
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
  const server = await startSupervisorServer({
    home,
    waitUntilReady: async () => ready,
    handlers: {
      launch: async ({ laneId }) => ({ laneId, reused: true }),
      close: async ({ laneId }) => ({ laneId, closed: true }),
    },
  });
  try {
    let resolved = false;
    const ping = createSupervisorClient({ home, timeoutMs: 1_000 }).ping().then((value) => {
      resolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(resolved, false);
    releaseReady();
    assert.equal((await ping).supervisorId, server.supervisorId);
  } finally {
    releaseReady();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("supervisor rejects a client with the wrong token", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-supervisor-"));
  const server = await startSupervisorServer({
    home,
    handlers: {
      launch: async ({ laneId }) => ({ laneId, reused: true }),
      close: async ({ laneId }) => ({ laneId, closed: true }),
    },
  });
  try {
    const client = createSupervisorClient({ home, token: "0".repeat(64), timeoutMs: 1_000 });
    await assert.rejects(client.ping(), /unauthorized/i);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("supervisor rejects malformed lane ids before calling handlers", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-supervisor-"));
  let called = false;
  const server = await startSupervisorServer({
    home,
    handlers: {
      launch: async ({ laneId }) => {
        called = true;
        return { laneId, reused: false };
      },
      close: async ({ laneId }) => ({ laneId, closed: true }),
    },
  });
  try {
    const client = createSupervisorClient({ home, timeoutMs: 1_000 });
    await assert.rejects(client.launch({ laneId: "" }), /laneId/i);
    assert.equal(called, false);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a second supervisor cannot replace a live supervisor endpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-supervisor-"));
  const handlers = {
    launch: async ({ laneId }: { laneId: string }) => ({ laneId, reused: true }),
    close: async ({ laneId }: { laneId: string }) => ({ laneId, closed: true }),
  };
  const first = await startSupervisorServer({ home, handlers, supervisorId: "first" });
  try {
    await assert.rejects(
      startSupervisorServer({ home, handlers, supervisorId: "second" }),
      /already running|EADDRINUSE/i,
    );
    const ping = await createSupervisorClient({ home, timeoutMs: 1_000 }).ping();
    assert.equal(ping.supervisorId, "first");
  } finally {
    await first.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent supervisor starters publish one token and one server", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-supervisor-race-"));
  const handlers = {
    launch: async ({ laneId }: { laneId: string }) => ({ laneId, reused: true }),
    close: async ({ laneId }: { laneId: string }) => ({ laneId, closed: true }),
  };
  const results = await Promise.allSettled([
    startSupervisorServer({ home, handlers, supervisorId: "race-a" }),
    startSupervisorServer({ home, handlers, supervisorId: "race-b" }),
  ]);
  const winners = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startSupervisorServer>>> => result.status === "fulfilled");
  try {
    assert.equal(winners.length, 1);
    const token = (await readFile(supervisorTokenPath(home), "utf8")).trim();
    assert.match(token, /^[a-f0-9]{64}$/);
    const ping = await createSupervisorClient({ home, timeoutMs: 1_000 }).ping();
    assert.equal(ping.supervisorId, winners[0]!.value.supervisorId);
  } finally {
    await Promise.all(winners.map((winner) => winner.value.close()));
    await rm(home, { recursive: true, force: true });
  }
});

test("supervisor refuses a malformed existing token", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-supervisor-token-"));
  await writeFile(supervisorTokenPath(home), "\n", "utf8");
  try {
    await assert.rejects(
      startSupervisorServer({
        home,
        handlers: {
          launch: async ({ laneId }) => ({ laneId, reused: true }),
          close: async ({ laneId }) => ({ laneId, closed: true }),
        },
      }),
      /invalid PortPilot supervisor token file/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
