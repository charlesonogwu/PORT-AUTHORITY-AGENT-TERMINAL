/**
 * Coverage for the dashboard's POST /api/config endpoint, which lets the
 * UI edit `maxActiveLanes` and `warnAtActiveLanes` without dropping to the
 * CLI. The endpoint is the only network-exposed write into the per-machine
 * config file, so we pin every validator branch and the persistence path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDashboardServer } from "../src/dashboard/server.js";
import { loadConfig, saveConfig, CONFIG_VERSION } from "../src/core/config.js";
import { withTempHome } from "./helpers.js";

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const handle = await startDashboardServer({ port: 0, host: "127.0.0.1" });
  try {
    return await fn(handle.port);
  } finally {
    await handle.close();
  }
}

async function postConfig(port: number, body: string | object): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

/* -------------------------------------------------------------------------- */
/*  Body-shape rejections                                                     */
/* -------------------------------------------------------------------------- */

test("/api/config rejects non-JSON body with 400", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, "not-json{");
      assert.equal(r.status, 400);
      assert.equal((r.json as { ok: boolean }).ok, false);
      assert.match((r.json as { error: string }).error, /invalid JSON/i);
    });
  });
});

test("/api/config rejects array body (object required)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, "[1,2,3]");
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /object/i);
    });
  });
});

test("/api/config rejects null body (object required)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, "null");
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /object/i);
    });
  });
});

test("/api/config rejects body with no recognised settings", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      // unknown fields are silently dropped, so an empty patch is left
      const r = await postConfig(port, { somethingElse: 42, anotherKey: "x" });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /no recognised settings/i);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Field-level validation                                                    */
/* -------------------------------------------------------------------------- */

test("/api/config rejects non-integer maxActiveLanes", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, { maxActiveLanes: 3.5 });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /maxActiveLanes.*integer/i);
    });
  });
});

test("/api/config rejects string maxActiveLanes", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, { maxActiveLanes: "20" });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /integer/i);
    });
  });
});

test("/api/config rejects out-of-bounds maxActiveLanes (too low)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, { maxActiveLanes: 0 });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /between/i);
    });
  });
});

test("/api/config rejects out-of-bounds maxActiveLanes (too high)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, { maxActiveLanes: 1_000_000 });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /between/i);
    });
  });
});

test("/api/config rejects negative warnAtActiveLanes", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, { warnAtActiveLanes: -1 });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /between/i);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Cross-field validation                                                    */
/* -------------------------------------------------------------------------- */

test("/api/config rejects warnAtActiveLanes > maxActiveLanes (cross-field)", async () => {
  await withTempHome(async () => {
    // Seed a low maxActiveLanes so a high warn value blows the cross-field rule
    await saveConfig({ version: CONFIG_VERSION, maxActiveLanes: 5, warnAtActiveLanes: 3 });
    await withServer(async (port) => {
      const r = await postConfig(port, { warnAtActiveLanes: 10 });
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /warnAtActiveLanes.*<=.*maxActiveLanes/i);
    });
  });
});

test("/api/config accepts warnAtActiveLanes == maxActiveLanes (boundary)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, { maxActiveLanes: 10, warnAtActiveLanes: 10 });
      assert.equal(r.status, 200);
      assert.equal((r.json as { ok: boolean }).ok, true);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Happy path + persistence                                                  */
/* -------------------------------------------------------------------------- */

test("/api/config persists a valid maxActiveLanes update to ~/.portpilot/config.json", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, { maxActiveLanes: 42 });
      assert.equal(r.status, 200);
      const body = r.json as { ok: boolean; config: { maxActiveLanes: number; version: number } };
      assert.equal(body.ok, true);
      assert.equal(body.config.maxActiveLanes, 42);
      assert.equal(body.config.version, CONFIG_VERSION);

      // Confirm it's actually on disk
      const saved = await loadConfig();
      assert.equal(saved.maxActiveLanes, 42);
    });
  });
});

test("/api/config persists a combined update of both fields", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, { maxActiveLanes: 30, warnAtActiveLanes: 20 });
      assert.equal(r.status, 200);
      const saved = await loadConfig();
      assert.equal(saved.maxActiveLanes, 30);
      assert.equal(saved.warnAtActiveLanes, 20);
    });
  });
});

test("/api/config preserves unrelated fields (chromeDebugRange) on update", async () => {
  await withTempHome(async () => {
    await saveConfig({
      version: CONFIG_VERSION,
      chromeDebugRange: { start: 9500, end: 9599 },
      maxActiveLanes: 8,
    });
    await withServer(async (port) => {
      const r = await postConfig(port, { maxActiveLanes: 12 });
      assert.equal(r.status, 200);
      const saved = await loadConfig();
      assert.equal(saved.maxActiveLanes, 12);
      // The update must NOT clobber unrelated fields
      assert.deepEqual(saved.chromeDebugRange, { start: 9500, end: 9599 });
    });
  });
});

test("/api/config silently drops unknown fields without rejecting (when at least one valid field is present)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const r = await postConfig(port, { maxActiveLanes: 25, version: 999, somethingElse: "ignore me" });
      assert.equal(r.status, 200);
      const saved = await loadConfig();
      assert.equal(saved.maxActiveLanes, 25);
      assert.equal(saved.version, CONFIG_VERSION, "server must always pin the version field");
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Method routing                                                            */
/* -------------------------------------------------------------------------- */

test("GET /api/config is not allowed (POST-only)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      assert.notEqual(res.status, 200);
    });
  });
});
