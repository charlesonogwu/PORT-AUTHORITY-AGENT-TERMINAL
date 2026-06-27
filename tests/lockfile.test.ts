import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, atomicWriteJson, renameWithRetry, withLock, LockError } from "../src/core/lockfile.js";
import { withTempHome } from "./helpers.js";

function errWithCode(message: string, code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(message);
  e.code = code;
  return e;
}

test("acquireLock blocks a second acquirer until the first releases", async () => {
  await withTempHome(async (home) => {
    const lockPath = join(home, "lanes.json.lock");
    const release = await acquireLock(lockPath, { timeoutMs: 100 });
    await assert.rejects(acquireLock(lockPath, { timeoutMs: 100 }), LockError);
    await release();
    const release2 = await acquireLock(lockPath, { timeoutMs: 500 });
    await release2();
  });
});

test("withLock serializes concurrent updates", async () => {
  await withTempHome(async (home) => {
    const lockPath = join(home, "lanes.json.lock");
    const order: string[] = [];
    const a = withLock(lockPath, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
    const b = withLock(lockPath, async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("b-end");
    });
    await Promise.all([a, b]);
    // We do not care which task wins the lock — only that they did not
    // interleave. start/end of each task must be adjacent in `order`.
    assert.equal(order.length, 4);
    const firstStart = order[0]!;
    const firstEnd = order[1]!;
    const secondStart = order[2]!;
    const secondEnd = order[3]!;
    assert.equal(firstStart.replace(/-(start|end)$/, ""), firstEnd.replace(/-(start|end)$/, ""));
    assert.equal(secondStart.replace(/-(start|end)$/, ""), secondEnd.replace(/-(start|end)$/, ""));
    assert.equal(firstStart.endsWith("-start") && firstEnd.endsWith("-end"), true);
    assert.equal(secondStart.endsWith("-start") && secondEnd.endsWith("-end"), true);
    assert.notEqual(firstStart, secondStart);
  });
});

test("withLock recovers from a stale lock file", async () => {
  await withTempHome(async (home) => {
    const lockPath = join(home, "stale.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 1, at: 0 }), "utf8");
    const release = await acquireLock(lockPath, { timeoutMs: 1000, staleMs: 10, retryMs: 5 });
    await release();
  });
});

test("atomicWriteJson does not leave a temp file when complete", async () => {
  await withTempHome(async (home) => {
    const target = join(home, "data.json");
    await atomicWriteJson(target, { hello: "world" });
    const raw = await readFile(target, "utf8");
    assert.deepEqual(JSON.parse(raw), { hello: "world" });
    const leftovers = (await readdir(home)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

test("renameWithRetry calls rename once on success", async () => {
  let calls = 0;
  await renameWithRetry("a", "b", { rename: async () => { calls++; }, attempts: 5, baseDelayMs: 1 });
  assert.equal(calls, 1);
});

test("renameWithRetry retries a transient EPERM then succeeds", async () => {
  let calls = 0;
  await renameWithRetry("a", "b", {
    rename: async () => {
      calls++;
      if (calls < 3) throw errWithCode("locked", "EPERM");
    },
    attempts: 5,
    baseDelayMs: 1,
  });
  assert.equal(calls, 3);
});

test("renameWithRetry rethrows a non-transient error immediately", async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry("a", "b", {
      rename: async () => { calls++; throw errWithCode("gone", "ENOENT"); },
      attempts: 5,
      baseDelayMs: 1,
    }),
    /gone/,
  );
  assert.equal(calls, 1); // failed fast, did not burn the retry budget
});

test("renameWithRetry gives up after the attempt budget on persistent EPERM", async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry("a", "b", {
      rename: async () => { calls++; throw errWithCode("still locked", "EPERM"); },
      attempts: 4,
      baseDelayMs: 1,
    }),
    /still locked/,
  );
  assert.equal(calls, 4);
});

test("atomicWriteJson removes its temp file when rename keeps failing", async () => {
  await withTempHome(async (home) => {
    const target = join(home, "lanes.json");
    await assert.rejects(
      atomicWriteJson(target, { hello: "world" }, {
        rename: async () => { throw errWithCode("locked", "EPERM"); },
        attempts: 3,
        baseDelayMs: 1,
      }),
      /locked/,
    );
    const leftovers = (await readdir(home)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], `expected no orphaned temp files, found: ${leftovers.join(", ")}`);
  });
});
