/**
 * Regression coverage for the localhost-only posture of the dashboard
 * server. The MEDIUM finding from the second-pass security audit was a
 * `Access-Control-Allow-Origin: *` header on /api/snapshot, which would
 * let any website the user visits cross-origin-fetch their session
 * metadata (cwd paths, profile dirs, pids). These tests pin that header
 * out of the response.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDashboardServer } from "../src/dashboard/server.js";
import { withTempHome } from "./helpers.js";

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const handle = await startDashboardServer({ port: 0, host: "127.0.0.1" });
  try {
    return await fn(handle.port);
  } finally {
    await handle.close();
  }
}

test("/api/snapshot must not advertise wildcard CORS (no cross-origin info leak)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
      assert.equal(res.status, 200);
      // Either no header, or the header is set to a localhost origin —
      // never the wildcard.
      const acao = res.headers.get("access-control-allow-origin");
      assert.notEqual(acao, "*", "snapshot must not respond with `Access-Control-Allow-Origin: *`");
    });
  });
});

test("/api/snapshot still returns valid JSON after the CORS removal", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
      const body = (await res.json()) as { ok: boolean };
      assert.equal(body.ok, true);
    });
  });
});

test("HTML route is unchanged (no regression in main page response)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
      const ct = res.headers.get("content-type") ?? "";
      assert.ok(ct.includes("text/html"), `expected text/html, got ${ct}`);
    });
  });
});

test("/healthz still returns ok (sanity check)", async () => {
  await withTempHome(async () => {
    await withServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.status, 200);
      assert.equal((await res.text()).trim(), "ok");
    });
  });
});
