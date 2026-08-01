import { BrowserKind, Lane } from "./lane.js";
import { PortObservation, ScanResult } from "./scanner.js";
import { ChromeAttachVerdict, ChromeLaunchMode, LaunchChromeOptions, LaunchResult } from "./chrome.js";
/**
 * The one place launch/attach decisions fan out by browser backend. Everything
 * upstream (allocator, MCP tools, CLI, dashboard) calls these and stays
 * browser-agnostic; chrome.ts / firefox.ts / edge.ts stay single-browser and
 * simple.
 */
export declare function normalizeBrowserKind(value: unknown): BrowserKind | undefined;
/** The launch modes each backend can honour HONESTLY. Edge is Chromium, so it
 *  supports everything Chrome does; Firefox has no off-screen positioning. */
export declare function supportedModes(browser: BrowserKind): ChromeLaunchMode[];
/** Throw (with the browser's own explanation) when a mode can't be honoured. */
export declare function assertModeSupported(browser: BrowserKind, mode: ChromeLaunchMode): void;
/** Human-readable label for user-facing messages. */
export declare function browserLabel(browser: BrowserKind): string;
/** Attach-safety verdict, routed by the lane's browser. */
export declare function evaluateBrowserAttach(lane: Lane, observations: PortObservation[]): ChromeAttachVerdict;
/** Launch the lane's browser. Options are the Chrome option shape; the
 *  Firefox path honours the shared subset (mode/dryRun/binaryPath/initialUrl/
 *  extraArgs) and refuses what it can't do. Edge takes everything Chrome does. */
export declare function launchBrowserForLane(lane: Lane, opts?: LaunchChromeOptions): Promise<LaunchResult>;
export interface LaunchBrowserDeps {
    scanPorts?: () => Promise<ScanResult>;
    launch?: (lane: Lane, opts: LaunchChromeOptions) => Promise<LaunchResult>;
    sleep?: (ms: number) => Promise<void>;
    readyTimeoutMs?: number;
}
/**
 * Serialize the check → launch → ready transition for a lane across processes.
 * The PID returned by browser spawn can be a short-lived relay when an existing
 * browser process adopts the profile. The authoritative PID is therefore the
 * process that actually owns the verified debugging port and profile.
 */
export declare function launchBrowserForLaneWithDeps(lane: Lane, opts?: LaunchChromeOptions, deps?: LaunchBrowserDeps): Promise<LaunchResult>;
