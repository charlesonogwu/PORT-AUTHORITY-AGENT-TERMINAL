/**
 * Process termination for the dashboard's "kill" button.
 *
 * Safety contract:
 *   - Refuses to kill a pid we cannot identify as a Chromium-family process.
 *     The check happens against a fresh port scan, so even if the dashboard's
 *     UI is showing slightly stale data, we won't terminate the wrong pid.
 *   - Never kills automatically. This module is invoked only from a POST
 *     handler that exists to serve a deliberate user click.
 *   - When the killed Chrome's port + profile match a portpilot lane, the
 *     lane is marked released so the registry stays consistent. External
 *     Chromes (any process not in portpilot's registry) are killed without
 *     registry mutation.
 */
export interface KillResult {
    ok: boolean;
    error?: string;
    killed?: {
        pid: number;
        command?: string;
        port?: number;
        profileDir?: string;
    };
    releasedLaneId?: string;
}
/**
 * Verify-and-kill a pid claimed to be an agent-driven Chrome.
 * Order:
 *   1. Re-scan TCP listeners. The pid must show up as a listening port owner.
 *   2. The owning command must be Chromium-family (chrome, chromium, edge, brave).
 *      Anything else: refuse.
 *   3. Capture port + profile path BEFORE killing (so we can match the lane
 *      after the process is gone).
 *   4. Cross-platform terminate.
 *   5. If a portpilot lane matches the killed Chrome's (port, profile),
 *      release it so the registry doesn't keep stale "active" rows.
 */
export declare function killChromeByPid(pid: number): Promise<KillResult>;
