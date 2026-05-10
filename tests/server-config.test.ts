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

async function withServer<T>(fn: (port: number, csrfToken: string) => Promise<T>): Promise<T> {
  const handle = await startDashboardServer({ port: 0, host: "127.0.0.1" });
  try {
    return await fn(handle.port, handle.csrfToken);
  } finally {
    await handle.close();
  }
}

async function postConfig(
  port: number,
  body: string | object,
  csrfToken: string,
  opts: { contentType?: string | null; origin?: string | null } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) {
    headers["content-type"] = opts.contentType ?? "application/json";
  }
  if (csrfToken) headers["X-Portpilot-CSRF"] = csrfToken;
  if (opts.origin !== null && opts.origin !== undefined) headers["Origin"] = opts.origin;
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers,
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
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, "not-json{", csrfToken);
      assert.equal(r.status, 400);
      assert.equal((r.json as { ok: boolean }).ok, false);
      assert.match((r.json as { error: string }).error, /invalid JSON/i);
    });
  });
});

test("/api/config rejects array body (object required)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, "[1,2,3]", csrfToken);
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /object/i);
    });
  });
});

test("/api/config rejects null body (object required)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, "null", csrfToken);
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /object/i);
    });
  });
});

test("/api/config rejects body with no recognised settings", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      // unknown fields are silently dropped, so an empty patch is left
      const r = await postConfig(port, { somethingElse: 42, anotherKey: "x" }, csrfToken);
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
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 3.5 }, csrfToken);
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /maxActiveLanes.*integer/i);
    });
  });
});

test("/api/config rejects string maxActiveLanes", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: "20" }, csrfToken);
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /integer/i);
    });
  });
});

test("/api/config rejects out-of-bounds maxActiveLanes (too low)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 0 }, csrfToken);
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /between/i);
    });
  });
});

test("/api/config rejects out-of-bounds maxActiveLanes (too high)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 1_000_000 }, csrfToken);
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /between/i);
    });
  });
});

test("/api/config rejects negative warnAtActiveLanes", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { warnAtActiveLanes: -1 }, csrfToken);
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
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { warnAtActiveLanes: 10 }, csrfToken);
      assert.equal(r.status, 400);
      assert.match((r.json as { error: string }).error, /warnAtActiveLanes.*<=.*maxActiveLanes/i);
    });
  });
});

test("/api/config accepts warnAtActiveLanes == maxActiveLanes (boundary)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 10, warnAtActiveLanes: 10 }, csrfToken);
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
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 42 }, csrfToken);
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
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 30, warnAtActiveLanes: 20 }, csrfToken);
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
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 12 }, csrfToken);
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
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 25, version: 999, somethingElse: "ignore me" }, csrfToken);
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
    await withServer(async (port, csrfToken) => {
      void csrfToken;
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      assert.notEqual(res.status, 200);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  CSRF + Origin guard (security audit finding #2)                           */
/* -------------------------------------------------------------------------- */

test("/api/config rejects POST without X-Portpilot-CSRF header (forbidden 403)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, _csrfToken) => {
      // No token sent — must be rejected with 403, not 400.
      const r = await postConfig(port, { maxActiveLanes: 10 }, "");
      assert.equal(r.status, 403);
      assert.match((r.json as { error: string }).error, /missing or invalid.*csrf/i);
    });
  });
});

test("/api/config rejects POST with wrong CSRF token (forbidden 403)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, _csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 10 }, "deadbeef-not-a-real-token");
      assert.equal(r.status, 403);
      assert.match((r.json as { error: string }).error, /missing or invalid.*csrf/i);
    });
  });
});

test("/api/config rejects POST with non-JSON Content-Type (forbidden 403)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, JSON.stringify({ maxActiveLanes: 10 }), csrfToken, {
        contentType: "text/plain",
      });
      assert.equal(r.status, 403);
      assert.match((r.json as { error: string }).error, /content-type.*application\/json/i);
    });
  });
});

test("/api/config rejects POST with cross-origin Origin header (forbidden 403)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 10 }, csrfToken, {
        origin: "https://evil.example.com",
      });
      assert.equal(r.status, 403);
      assert.match((r.json as { error: string }).error, /cross-origin/i);
    });
  });
});

test("/api/config accepts POST with valid CSRF + same-origin Origin (200)", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const r = await postConfig(port, { maxActiveLanes: 25 }, csrfToken, {
        origin: `http://127.0.0.1:${port}`,
      });
      assert.equal(r.status, 200);
      assert.equal((r.json as { ok: boolean }).ok, true);
    });
  });
});

test("server exposes a CSRF token on the handle (used by tests + UI)", async () => {
  await withTempHome(async () => {
    await withServer(async (_port, csrfToken) => {
      assert.equal(typeof csrfToken, "string");
      assert.match(csrfToken, /^[0-9a-f]+$/i);
      assert.ok(csrfToken.length >= 32, `token should be at least 32 chars, got ${csrfToken.length}`);
    });
  });
});

test("served HTML contains the CSRF token in <meta name=\"paat-csrf\">", async () => {
  await withTempHome(async () => {
    await withServer(async (port, csrfToken) => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.match(html, /<meta\s+name="paat-csrf"\s+content="[0-9a-f]+"\s*\/>/i);
      assert.ok(html.includes(`content="${csrfToken}"`), "HTML must contain the actual token");
    });
  });
});
