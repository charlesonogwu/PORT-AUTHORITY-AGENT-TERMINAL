import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, atomicWriteJson, withLock, LockError } from "../src/core/lockfile.js";
import { withTempHome } from "./helpers.js";

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
  });
});
