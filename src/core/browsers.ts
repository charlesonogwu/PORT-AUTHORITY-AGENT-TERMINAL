import { BrowserKind, Lane, laneBrowser } from "./lane.js";
import { PortObservation } from "./scanner.js";
import {
  ChromeAttachVerdict,
  ChromeLaunchMode,
  LaunchChromeOptions,
  LaunchResult,
  evaluateChromeAttach,
  launchChromeForLane,
} from "./chrome.js";
import {
  UnsupportedFirefoxModeError,
  evaluateFirefoxAttach,
  launchFirefoxForLane,
} from "./firefox.js";

/**
 * The one place launch/attach decisions fan out by browser backend. Everything
 * upstream (allocator, MCP tools, CLI, dashboard) calls these and stays
 * browser-agnostic; chrome.ts / firefox.ts stay single-browser and simple.
 */

export function normalizeBrowserKind(value: unknown): BrowserKind | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "chrome" || v === "firefox") return v;
  return undefined;
}

/** The launch modes each backend can honour HONESTLY. */
export function supportedModes(browser: BrowserKind): ChromeLaunchMode[] {
  return browser === "firefox" ? ["visible", "headless"] : ["visible", "background", "headless"];
}

/** Throw (with the browser's own explanation) when a mode can't be honoured. */
export function assertModeSupported(browser: BrowserKind, mode: ChromeLaunchMode): void {
  if (!supportedModes(browser).includes(mode)) {
    if (browser === "firefox") throw new UnsupportedFirefoxModeError(mode);
    throw new Error(`Browser "${browser}" does not support mode "${mode}"`);
  }
}

/** Attach-safety verdict, routed by the lane's browser. */
export function evaluateBrowserAttach(lane: Lane, observations: PortObservation[]): ChromeAttachVerdict {
  return laneBrowser(lane) === "firefox"
    ? evaluateFirefoxAttach(lane, observations)
    : evaluateChromeAttach(lane, observations);
}

/** Launch the lane's browser. Options are the Chrome option shape; the
 *  Firefox path honours the shared subset (mode/dryRun/binaryPath/initialUrl/
 *  extraArgs) and refuses what it can't do. */
export async function launchBrowserForLane(lane: Lane, opts: LaunchChromeOptions = {}): Promise<LaunchResult> {
  return laneBrowser(lane) === "firefox"
    ? launchFirefoxForLane(lane, opts)
    : launchChromeForLane(lane, opts);
}
