import { Server } from "node:http";
export interface DashboardServerOptions {
    port?: number;
    host?: string;
    cdpTimeoutMs?: number;
}
export interface DashboardServerHandle {
    server: Server;
    port: number;
    url: string;
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
export declare function startDashboardServer(opts?: DashboardServerOptions): Promise<DashboardServerHandle>;
/**
 * Best-effort cross-platform "open this URL in the user's browser." We do not
 * await — this is a fire-and-forget convenience. If it fails (no display,
 * SSH session, etc.) the caller should still print the URL to stdout.
 */
export declare function openInBrowser(url: string): void;
