import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { buildSnapshot } from "./snapshot.js";
import { killChromeByPid } from "./kill.js";
import { focusChromeWindow, hideChromeWindow } from "./focus.js";
import { DASHBOARD_HTML } from "../ui/dashboard.js";
import {
  CONFIG_VERSION,
  loadConfig,
  PortpilotConfig,
  saveConfig,
} from "../core/config.js";

/**
 * Strict allowed-field validator for POST /api/config. Anything not in this
 * set is silently dropped — no path traversal, no schema injection, no
 * surprising key collisions in the saved file. Bounds are wide enough for
 * legitimate use, narrow enough to refuse obvious abuse (e.g.
 * maxActiveLanes = 1_000_000 to exhaust the host machine).
 */
const CONFIG_FIELD_BOUNDS = {
  maxActiveLanes: { min: 1, max: 500 },
  warnAtActiveLanes: { min: 0, max: 500 },
} as const;

interface ConfigPatch {
  maxActiveLanes?: number;
  warnAtActiveLanes?: number;
}

function validateConfigPatch(raw: unknown): { ok: true; patch: ConfigPatch } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const patch: ConfigPatch = {};
  for (const key of ["maxActiveLanes", "warnAtActiveLanes"] as const) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      return { ok: false, error: `${key} must be an integer` };
    }
    const { min, max } = CONFIG_FIELD_BOUNDS[key];
    if (v < min || v > max) {
      return { ok: false, error: `${key} must be between ${min} and ${max}` };
    }
    patch[key] = v;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "body had no recognised settings to update" };
  }
  return { ok: true, patch };
}

/* -------------------------------------------------------------------------- */
/*  CSRF + cross-origin guard for state-changing POST endpoints               */
/* -------------------------------------------------------------------------- */
/**
 * The dashboard binds 127.0.0.1 by default. Without a CSRF check, any web
 * page the user visits in any browser can issue blind POSTs to
 * `http://127.0.0.1:7321/api/{kill,focus,hide,config}` — the browser
 * fires the request even though CORS prevents reading the response. That
 * lets a hostile page (a) kill arbitrary chrome PIDs by guessing them,
 * or worse (b) overwrite portpilot's config (no PID guessing needed for
 * /api/config).
 *
 * Defense in three layers, all required:
 *
 *   1. A random per-server-startup token. The dashboard HTML embeds it
 *      via `<meta name="paat-csrf">`. The React app reads that meta tag
 *      and sends it as the `X-Portpilot-CSRF` header on every POST.
 *      A cross-site page cannot read that meta tag (same-origin
 *      restriction) and cannot reproduce the token.
 *
 *   2. Strict `Content-Type: application/json`. This forces a CORS
 *      preflight on cross-origin requests, which our missing CORS
 *      headers will then reject. Combined with #1, the only way a
 *      request can reach a POST handler is if it came from the
 *      dashboard's own origin.
 *
 *   3. Origin / Sec-Fetch-Site sanity checks. Belt-and-braces: even if
 *      a future config relaxes CORS, requests from other origins are
 *      rejected explicitly.
 *
 * The token is regenerated on every server start. Restarting the
 * dashboard invalidates outstanding browser tabs, which forces a
 * page reload to fetch the new token. That's the right behavior — old
 * tabs from a previous server lifetime shouldn't be authorized.
 */

function generateCsrfToken(): string {
  return randomBytes(24).toString("hex"); // 48 hex chars, 192 bits
}

const CSRF_HEADER = "x-portpilot-csrf";

/**
 * Returns null on success, or an HTTP 403 reason string when the
 * request must be rejected. The caller is expected to write a 403 with
 * the reason as the response body.
 */
function checkCsrfAndOrigin(req: IncomingMessage, expectedToken: string, listenHost: string, listenPort: number): string | null {
  // 1. Token must match
  const got = (req.headers[CSRF_HEADER] as string | undefined) ?? "";
  if (!got || got !== expectedToken) {
    return "missing or invalid X-Portpilot-CSRF header";
  }

  // 2. Content-Type must be application/json (forces CORS preflight on cross-origin)
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) {
    return "Content-Type must be application/json";
  }

  // 3. Origin/Referer must be same-origin (when present — Origin is sent on
  //    cross-origin and same-origin POSTs by every modern browser).
  const expectedOrigins = new Set<string>([
    `http://${listenHost}:${listenPort}`,
    `http://localhost:${listenPort}`,
    `http://127.0.0.1:${listenPort}`,
  ]);
  const origin = req.headers.origin as string | undefined;
  if (origin && !expectedOrigins.has(origin.toLowerCase())) {
    return `cross-origin request from ${origin} rejected`;
  }
  // Sec-Fetch-Site: same-origin / same-site / none (direct nav). Reject
  // "cross-site" explicitly — the only way a real attacker page reaches
  // us is via cross-site fetch.
  const sfs = req.headers["sec-fetch-site"];
  if (sfs && String(sfs).toLowerCase() === "cross-site") {
    return "Sec-Fetch-Site: cross-site rejected";
  }

  return null;
}

function rejectCsrf(res: ServerResponse, reason: string): void {
  res.writeHead(403, {
    "content-type": "application/json",
    "cache-control": "no-store",
  }).end(JSON.stringify({ ok: false, error: `forbidden: ${reason}` }));
}

/**
 * Embed the CSRF token into the served dashboard HTML. The React app
 * reads it from `<meta name="paat-csrf" content="...">` on first load.
 */
function injectCsrfToken(html: string, token: string): string {
  const metaTag = `<meta name="paat-csrf" content="${token}" />`;
  // Insert just after <head> if there's no existing csrf meta; replace
  // any prior placeholder if our build pipeline added one.
  if (/<meta\s+name=["']paat-csrf["'][^>]*\/?>/i.test(html)) {
    return html.replace(/<meta\s+name=["']paat-csrf["'][^>]*\/?>/i, metaTag);
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${metaTag}`);
  }
  // Fallback: prepend (HTML without <head> is unusual but handle it)
  return `${metaTag}\n${html}`;
}

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  cdpTimeoutMs?: number;
}

export interface DashboardServerHandle {
  server: Server;
  port: number;
  url: string;
  /** The CSRF token in use this server lifetime — exposed for tests. */
  csrfToken: string;
  close(): Promise<void>;
}

/**
 * Start the dashboard HTTP server. Routes:
 *
 *   GET /                    → the dashboard HTML
 *   GET /api/snapshot        → JSON snapshot of every lane + tabs + verdict
 *   POST /api/config         → update maxActiveLanes / warnAtActiveLanes
 *   POST /api/kill           → terminate a Chrome process by pid
 *   GET /healthz             → health check
 *
 * Bound to 127.0.0.1 by default — the dashboard exposes process metadata
 * and CDP information, so we never want it reachable from the network.
 */
export async function startDashboardServer(opts: DashboardServerOptions = {}): Promise<DashboardServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const wantPort = opts.port ?? 7321;
  const cdpTimeoutMs = opts.cdpTimeoutMs ?? 1500;

  // Random per-server-startup CSRF token. Embedded into the HTML the
  // dashboard serves, required on every state-changing POST. Restarting
  // the server invalidates open browser tabs (they'll fail their first
  // POST and the user reloads). That's intentional — a token from a
  // previous server lifetime should not authorize new actions.
  const csrfToken = generateCsrfToken();
  const dashboardHtml = injectCsrfToken(DASHBOARD_HTML, csrfToken);

  // listenedPort is filled in after server.listen() completes. Until
  // then we use the requested port for origin checks; the value gets
  // updated to the actual bound port (matters if wantPort was taken).
  let listenedPort = wantPort;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      // GET routes
      if (req.method === "GET") {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          }).end(dashboardHtml);
          return;
        }
        if (url.pathname === "/api/snapshot") {
          const snap = await buildSnapshot({ cdpTimeoutMs });
          const body = JSON.stringify(snap);
          // No CORS header — same-origin only. The dashboard frontend is
          // served from this same origin so it never needs CORS, and
          // omitting the header prevents any random website the user
          // visits from cross-origin-fetching this endpoint and reading
          // their session metadata (cwd paths, profile dirs, pids).
          res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          }).end(body);
          return;
        }
        if (url.pathname === "/healthz") {
          res.writeHead(200, { "content-type": "text/plain" }).end("ok");
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      // ALL POST routes require a valid CSRF token + same-origin headers.
      // Reject before any side effect runs.
      if (req.method === "POST") {
        const reason = checkCsrfAndOrigin(req, csrfToken, host, listenedPort);
        if (reason !== null) {
          rejectCsrf(res, reason);
          return;
        }
      }
      // POST /api/config — update maxActiveLanes / warnAtActiveLanes from the dashboard UI
      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = await readBody(req);
        let raw: unknown;
        try {
          raw = JSON.parse(body) as unknown;
        } catch {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
          return;
        }
        const v = validateConfigPatch(raw);
        if (!v.ok) {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: v.error }));
          return;
        }
        // Cross-field check after merging: warnAt must not exceed max.
        const current = await loadConfig();
        const merged: PortpilotConfig = { ...current, ...v.patch, version: CONFIG_VERSION };
        if (
          merged.warnAtActiveLanes !== undefined &&
          merged.maxActiveLanes !== undefined &&
          merged.warnAtActiveLanes > merged.maxActiveLanes
        ) {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: "warnAtActiveLanes must be <= maxActiveLanes" }));
          return;
        }
        await saveConfig(merged);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify({ ok: true, config: merged }));
        return;
      }
      // POST /api/hide — minimize a Chrome window (user-initiated only)
      if (req.method === "POST" && url.pathname === "/api/hide") {
        const body = await readBody(req);
        let payload: { pid?: number };
        try {
          payload = JSON.parse(body) as { pid?: number };
        } catch {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
          return;
        }
        if (typeof payload.pid !== "number") {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: "missing or invalid 'pid' (number required)" }));
          return;
        }
        const result = await hideChromeWindow(payload.pid);
        res.writeHead(result.ok ? 200 : 400, {
          "content-type": "application/json",
          "cache-control": "no-store",
        }).end(JSON.stringify(result));
        return;
      }
      // POST /api/focus — bring a Chrome window to the foreground (user-initiated only)
      if (req.method === "POST" && url.pathname === "/api/focus") {
        const body = await readBody(req);
        let payload: { pid?: number };
        try {
          payload = JSON.parse(body) as { pid?: number };
        } catch {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
          return;
        }
        if (typeof payload.pid !== "number") {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: "missing or invalid 'pid' (number required)" }));
          return;
        }
        const result = await focusChromeWindow(payload.pid);
        res.writeHead(result.ok ? 200 : 400, {
          "content-type": "application/json",
          "cache-control": "no-store",
        }).end(JSON.stringify(result));
        return;
      }
      // POST /api/kill — terminate a Chrome process by pid (user-initiated only)
      if (req.method === "POST" && url.pathname === "/api/kill") {
        const body = await readBody(req);
        let payload: { pid?: number };
        try {
          payload = JSON.parse(body) as { pid?: number };
        } catch {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
          return;
        }
        if (typeof payload.pid !== "number") {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: "missing or invalid 'pid' (number required)" }));
          return;
        }
        const result = await killChromeByPid(payload.pid);
        res.writeHead(result.ok ? 200 : 400, {
          "content-type": "application/json",
          "cache-control": "no-store",
        }).end(JSON.stringify(result));
        return;
      }
      res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: false, error: msg }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error): void => reject(err);
    server.once("error", onErr);
    server.listen(wantPort, host, () => {
      server.off("error", onErr);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  listenedPort = port; // sync the closure-visible value with the actual bound port
  const url = `http://${host}:${port}/`;

  return {
    server,
    port,
    url,
    csrfToken,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Read a request body into a UTF-8 string, capped at 1 MiB to avoid abuse. */
async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 1024 * 1024) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Best-effort cross-platform "open this URL in the user's browser." We do not
 * await — this is a fire-and-forget convenience. If it fails (no display,
 * SSH session, etc.) the caller should still print the URL to stdout.
 */
export function openInBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // start "" "url" — needs the empty title arg.
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // ignore — caller will fall back to printing the URL
  }
}
