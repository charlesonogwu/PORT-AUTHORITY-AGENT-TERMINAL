import { createServer } from "node:http";
import { spawn } from "node:child_process";
import process from "node:process";
import { buildSnapshot } from "./snapshot.js";
import { killChromeByPid } from "./kill.js";
import { focusChromeWindow, hideChromeWindow } from "./focus.js";
import { DASHBOARD_HTML } from "../ui/dashboard.js";
import { CONFIG_VERSION, loadConfig, saveConfig, } from "../core/config.js";
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
};
function validateConfigPatch(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: "body must be a JSON object" };
    }
    const obj = raw;
    const patch = {};
    for (const key of ["maxActiveLanes", "warnAtActiveLanes"]) {
        if (!(key in obj))
            continue;
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
export async function startDashboardServer(opts = {}) {
    const host = opts.host ?? "127.0.0.1";
    const wantPort = opts.port ?? 7321;
    const cdpTimeoutMs = opts.cdpTimeoutMs ?? 1500;
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", `http://${host}`);
            // GET routes
            if (req.method === "GET") {
                if (url.pathname === "/" || url.pathname === "/index.html") {
                    res.writeHead(200, {
                        "content-type": "text/html; charset=utf-8",
                        "cache-control": "no-store",
                    }).end(DASHBOARD_HTML);
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
            // POST /api/config — update maxActiveLanes / warnAtActiveLanes from the dashboard UI
            if (req.method === "POST" && url.pathname === "/api/config") {
                const body = await readBody(req);
                let raw;
                try {
                    raw = JSON.parse(body);
                }
                catch {
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
                const merged = { ...current, ...v.patch, version: CONFIG_VERSION };
                if (merged.warnAtActiveLanes !== undefined &&
                    merged.maxActiveLanes !== undefined &&
                    merged.warnAtActiveLanes > merged.maxActiveLanes) {
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
                let payload;
                try {
                    payload = JSON.parse(body);
                }
                catch {
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
                let payload;
                try {
                    payload = JSON.parse(body);
                }
                catch {
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
                let payload;
                try {
                    payload = JSON.parse(body);
                }
                catch {
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "content-type": "application/json" })
                .end(JSON.stringify({ ok: false, error: msg }));
        }
    });
    await new Promise((resolve, reject) => {
        const onErr = (err) => reject(err);
        server.once("error", onErr);
        server.listen(wantPort, host, () => {
            server.off("error", onErr);
            resolve();
        });
    });
    const addr = server.address();
    const port = addr.port;
    const url = `http://${host}:${port}/`;
    return {
        server,
        port,
        url,
        async close() {
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
/** Read a request body into a UTF-8 string, capped at 1 MiB to avoid abuse. */
async function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (c) => {
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
export function openInBrowser(url) {
    try {
        if (process.platform === "win32") {
            // start "" "url" — needs the empty title arg.
            spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        }
        else if (process.platform === "darwin") {
            spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
        }
        else {
            spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
        }
    }
    catch {
        // ignore — caller will fall back to printing the URL
    }
}
