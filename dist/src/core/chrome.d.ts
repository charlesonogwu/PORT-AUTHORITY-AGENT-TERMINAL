import { Lane } from "./lane.js";
import { PortObservation } from "./scanner.js";
/**
 * Decision returned by the Chrome safety check.
 *
 * - `safe-free`           — port is free; lane may launch its own Chrome.
 * - `safe-attach`         — port is occupied by Chrome whose --user-data-dir
 *                           matches the lane's profile, so the lane may attach.
 * - `unsafe-foreign-chrome` — port is occupied by Chrome but the profile does
 *                           not match this lane.
 * - `unsafe-unknown`      — port is occupied by a non-Chrome process, or by a
 *                           process we cannot identify.
 */
export type ChromeAttachVerdict = {
    kind: "safe-free";
    port: number;
} | {
    kind: "safe-attach";
    port: number;
    observation: PortObservation;
} | {
    kind: "unsafe-foreign-chrome";
    port: number;
    observation: PortObservation;
    foundProfile?: string;
} | {
    kind: "unsafe-unknown";
    port: number;
    observation: PortObservation;
};
export declare function isChromeProcess(o: PortObservation): boolean;
/**
 * Extract --user-data-dir from a process command line. Supports
 *   --user-data-dir=value
 *   --user-data-dir="value with spaces"
 *   --user-data-dir value
 */
export declare function extractUserDataDir(commandLine: string | undefined): string | undefined;
/**
 * Decide whether `lane` may safely attach to its Chrome debug port given the
 * current set of port observations. The rule mirrors the safety contract:
 *
 *   - free port                              → safe-free
 *   - Chrome with matching --user-data-dir   → safe-attach
 *   - Chrome with different --user-data-dir  → unsafe-foreign-chrome
 *   - non-Chrome / unidentifiable owner      → unsafe-unknown
 *
 * If the lane has no Chrome debug port assigned, it is treated as safe-free
 * for port `0` so callers can branch cleanly.
 */
export declare function evaluateChromeAttach(lane: Lane, observations: PortObservation[]): ChromeAttachVerdict;
export interface LaunchChromeOptions {
    detached?: boolean;
    extraArgs?: string[];
    binaryPath?: string;
    /** When true, skip launching and just return the resolved command + args. */
    dryRun?: boolean;
    /**
     * Optional URL to open as the first tab. Passed as the trailing positional
     * argument to chrome.exe so Chrome navigates immediately on startup —
     * avoiding a separate CDP round-trip.
     */
    initialUrl?: string;
}
export interface LaunchPlan {
    binary: string;
    args: string[];
    profileDir: string;
    port: number;
}
/**
 * Returns true iff `p` looks like a Chromium-family browser binary by its
 * basename (case-insensitive). Used to gate caller-supplied `binaryPath`
 * values that come in via the MCP `launch_chrome_lane` / `open` tools.
 */
export declare function isChromeBinaryPath(p: string | undefined): boolean;
/**
 * Returns true iff `url` is a value safe to pass as Chrome's startup URL
 * positional argument. Refuses anything starting with `-` (Chrome treats
 * `-flag` and `--flag` as flags regardless of argv position) or any scheme
 * not in the explicit allowlist. This blocks injection like
 *   url = "--load-extension=C:\evil"
 *   url = "--proxy-server=http://attacker"
 *   url = "--disable-web-security"
 * which a malicious MCP agent could otherwise smuggle through the `open`
 * tool to subvert the launched Chrome.
 */
export declare function isSafeInitialUrl(url: string | undefined): boolean;
export declare class UnsafeChromeArgError extends Error {
    constructor(message: string);
}
export declare function resolveChromeBinary(explicit?: string): string;
/**
 * Build the Chrome launch command for a lane. We always pass:
 *   --remote-debugging-port=<port>
 *   --user-data-dir=<profile>
 *   --no-first-run --no-default-browser-check
 * which together guarantee an isolated, attachable browser instance.
 *
 * If `initialUrl` is supplied it MUST pass `isSafeInitialUrl`, otherwise we
 * throw `UnsafeChromeArgError`. This is what stops an MCP agent from
 * smuggling `--load-extension=...` into the launch by labelling it as a
 * URL.
 */
export declare function buildLaunchPlan(lane: Lane, opts?: LaunchChromeOptions): LaunchPlan;
export interface LaunchResult {
    pid?: number;
    binary: string;
    args: string[];
    spawned: boolean;
}
/**
 * Launch Chrome for the lane. Caller must ensure `evaluateChromeAttach`
 * returned `safe-free` first. We do not enforce that here because callers may
 * have already decided to attach to a `safe-attach` instance instead.
 */
export declare function launchChromeForLane(lane: Lane, opts?: LaunchChromeOptions): Promise<LaunchResult>;
