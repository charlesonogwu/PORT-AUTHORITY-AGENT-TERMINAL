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
import { evaluateEdgeAttach, launchEdgeForLane } from "./edge.js";
import { confirmObservations, type PortTruthDependencies } from "./port-truth.js";

/**
 * The one place launch/attach decisions fan out by browser backend. Everything
 * upstream (allocator, MCP tools, CLI, dashboard) calls these and stays
 * browser-agnostic; chrome.ts / firefox.ts / edge.ts stay single-browser and
 * simple.
 */

export function normalizeBrowserKind(value: unknown): BrowserKind | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "chrome" || v === "firefox" || v === "edge") return v;
  if (v === "msedge") return "edge"; // common alias for Microsoft Edge
  return undefined;
}

/** The launch modes each backend can honour HONESTLY. Edge is Chromium, so it
 *  supports everything Chrome does; Firefox has no off-screen positioning. */
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

/** Human-readable label for user-facing messages. */
export function browserLabel(browser: BrowserKind): string {
  if (browser === "firefox") return "Firefox";
  if (browser === "edge") return "Edge";
  return "Chrome";
}

/** Attach-safety verdict, routed by the lane's browser. */
export function evaluateBrowserAttach(lane: Lane, observations: PortObservation[]): ChromeAttachVerdict {
  const browser = laneBrowser(lane);
  if (browser === "firefox") return evaluateFirefoxAttach(lane, observations);
  if (browser === "edge") return evaluateEdgeAttach(lane, observations);
  return evaluateChromeAttach(lane, observations);
}

/**
 * Attach-safety verdict checked against the kernel as well as the listener
 * table. The table can leave a live debug port out (then the plain verdict
 * says safe-free and PortPilot would launch a second browser onto a port
 * another one already serves) or keep a row for a socket that is gone.
 * Use this wherever the verdict decides a launch, an attach or a close.
 */
export async function evaluateBrowserAttachLive(
  lane: Lane,
  observations: PortObservation[],
  deps: PortTruthDependencies = {},
): Promise<ChromeAttachVerdict> {
  if (!lane.chromeDebugPort) return evaluateBrowserAttach(lane, observations);
  return evaluateBrowserAttach(lane, await confirmObservations([lane.chromeDebugPort], observations, deps));
}

/** Plain-language description of who holds a lane's debug port, for refusals. */
export function describePortHolder(verdict: ChromeAttachVerdict): string | undefined {
  if (verdict.kind !== "unsafe-foreign-chrome" && verdict.kind !== "unsafe-unknown") return undefined;
  const { observation } = verdict;
  if (!observation.command && !observation.commandLine && observation.pid === undefined) {
    return `debug port ${verdict.port} is in use by a program PortPilot could not identify`;
  }
  const holder = verdict.kind === "unsafe-foreign-chrome" ? "another browser" : "another program";
  const details = [
    observation.command,
    observation.pid !== undefined ? `pid ${observation.pid}` : undefined,
    verdict.kind === "unsafe-foreign-chrome" && verdict.foundProfile ? `profile ${verdict.foundProfile}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `debug port ${verdict.port} is in use by ${holder}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

/** Launch the lane's browser. Options are the Chrome option shape; the
 *  Firefox path honours the shared subset (mode/dryRun/binaryPath/initialUrl/
 *  extraArgs) and refuses what it can't do. Edge takes everything Chrome does. */
export async function launchBrowserForLane(lane: Lane, opts: LaunchChromeOptions = {}): Promise<LaunchResult> {
  const browser = laneBrowser(lane);
  if (browser === "firefox") return launchFirefoxForLane(lane, opts);
  if (browser === "edge") return launchEdgeForLane(lane, opts);
  return launchChromeForLane(lane, opts);
}
