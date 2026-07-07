import { BrowserKind, Lane } from "./lane.js";
import { PortObservation } from "./scanner.js";
import { ChromeAttachVerdict, ChromeLaunchMode, LaunchChromeOptions, LaunchResult } from "./chrome.js";
/**
 * The one place launch/attach decisions fan out by browser backend. Everything
 * upstream (allocator, MCP tools, CLI, dashboard) calls these and stays
 * browser-agnostic; chrome.ts / firefox.ts stay single-browser and simple.
 */
export declare function normalizeBrowserKind(value: unknown): BrowserKind | undefined;
/** The launch modes each backend can honour HONESTLY. */
export declare function supportedModes(browser: BrowserKind): ChromeLaunchMode[];
/** Throw (with the browser's own explanation) when a mode can't be honoured. */
export declare function assertModeSupported(browser: BrowserKind, mode: ChromeLaunchMode): void;
/** Attach-safety verdict, routed by the lane's browser. */
export declare function evaluateBrowserAttach(lane: Lane, observations: PortObservation[]): ChromeAttachVerdict;
/** Launch the lane's browser. Options are the Chrome option shape; the
 *  Firefox path honours the shared subset (mode/dryRun/binaryPath/initialUrl/
 *  extraArgs) and refuses what it can't do. */
export declare function launchBrowserForLane(lane: Lane, opts?: LaunchChromeOptions): Promise<LaunchResult>;
