import { BrowserKind, Lane } from "./lane.js";
import { PortObservation } from "./scanner.js";
import { ChromeAttachVerdict, ChromeLaunchMode, LaunchChromeOptions, LaunchResult } from "./chrome.js";
import { type PortTruthDependencies } from "./port-truth.js";
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
/**
 * Attach-safety verdict checked against the kernel as well as the listener
 * table. The table can leave a live debug port out (then the plain verdict
 * says safe-free and PortPilot would launch a second browser onto a port
 * another one already serves) or keep a row for a socket that is gone.
 * Use this wherever the verdict decides a launch, an attach or a close.
 */
export declare function evaluateBrowserAttachLive(lane: Lane, observations: PortObservation[], deps?: PortTruthDependencies): Promise<ChromeAttachVerdict>;
/** Plain-language description of who holds a lane's debug port, for refusals. */
export declare function describePortHolder(verdict: ChromeAttachVerdict): string | undefined;
/** Launch the lane's browser. Options are the Chrome option shape; the
 *  Firefox path honours the shared subset (mode/dryRun/binaryPath/initialUrl/
 *  extraArgs) and refuses what it can't do. Edge takes everything Chrome does. */
export declare function launchBrowserForLane(lane: Lane, opts?: LaunchChromeOptions): Promise<LaunchResult>;
