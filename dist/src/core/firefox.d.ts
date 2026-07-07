import { Lane } from "./lane.js";
import { PortObservation } from "./scanner.js";
import { ChromeAttachVerdict, ChromeLaunchMode, LaunchResult } from "./chrome.js";
/**
 * Firefox backend.
 *
 * PortPilot's job is identical for every browser: hand a lane a dedicated
 * profile + a debug port, launch, and keep other agents off it. The parts that
 * differ from Chrome:
 *
 *   - Profile isolation is `-profile <dir>` (+ `-no-remote` so we never join
 *     the user's running default-profile Firefox instance).
 *   - `--remote-debugging-port <port>` serves **WebDriver BiDi**
 *     (ws://127.0.0.1:<port>/session), NOT Chrome CDP. Agents need a
 *     BiDi-capable client (Playwright's firefox, WebDriver). PortPilot itself
 *     never drives the browser, so from PortPilot's perspective Firefox is
 *     launch + coordinate; tab enumeration (a CDP nicety) is unavailable.
 *   - Modes: "visible" and "headless" (`-headless`) are real. "background"
 *     (off-screen positioning) does not exist in Firefox — we REFUSE it
 *     rather than fake it.
 */
export declare class UnsupportedFirefoxModeError extends Error {
    constructor(mode: string);
}
/** True iff `p` looks like a Firefox-family binary by basename. Gates
 *  caller-supplied binaryPath values coming in via MCP/CLI. */
export declare function isFirefoxBinaryPath(p: string | undefined): boolean;
export declare function resolveFirefoxBinary(explicit?: string): string;
export declare function isFirefoxProcess(o: PortObservation): boolean;
/**
 * Extract the `-profile` / `--profile` directory from a Firefox command line.
 * Firefox accepts both single- and double-dash forms, space-separated
 * (`-profile "C:\dir with spaces"` or -profile C:\dir).
 */
export declare function extractFirefoxProfileDir(commandLine: string | undefined): string | undefined;
/**
 * Firefox flavour of the attach-safety verdict. Mirrors evaluateChromeAttach
 * and reuses the SAME verdict kinds so every existing consumer (MCP check_lane,
 * doctor, dashboard) keeps working unchanged:
 *
 *   - free port                               → safe-free
 *   - Firefox with matching -profile          → safe-attach
 *   - Firefox with different/unknown -profile → unsafe-foreign-chrome
 *     (kind string kept for API compat; read it as "foreign browser")
 *   - non-Firefox / unidentifiable owner      → unsafe-unknown
 */
export declare function evaluateFirefoxAttach(lane: Lane, observations: PortObservation[]): ChromeAttachVerdict;
export interface LaunchFirefoxOptions {
    detached?: boolean;
    extraArgs?: string[];
    binaryPath?: string;
    dryRun?: boolean;
    /** "visible" (default) or "headless". "background" throws — see module doc. */
    mode?: ChromeLaunchMode;
    initialUrl?: string;
}
export interface FirefoxLaunchPlan {
    binary: string;
    args: string[];
    profileDir: string;
    port: number;
}
/**
 * Build the Firefox launch command for a lane. Always passes:
 *   -profile <dir>              dedicated PortPilot profile, NEVER the user's
 *   -no-remote                  don't join an already-running Firefox instance
 *   --remote-debugging-port N   WebDriver BiDi endpoint on the lane's port
 *
 * initialUrl goes through the same isSafeInitialUrl gate as Chrome, so a
 * crafted "-flag" can't be smuggled in as a URL.
 */
export declare function buildFirefoxLaunchPlan(lane: Lane, opts?: LaunchFirefoxOptions): FirefoxLaunchPlan;
/** Launch Firefox for the lane. Caller must have verified the lane is safe
 *  (evaluateFirefoxAttach → safe-free) first, mirroring the Chrome contract. */
export declare function launchFirefoxForLane(lane: Lane, opts?: LaunchFirefoxOptions): Promise<LaunchResult>;
