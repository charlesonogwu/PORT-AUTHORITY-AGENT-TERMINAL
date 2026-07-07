import { laneBrowser } from "./lane.js";
import { evaluateChromeAttach, launchChromeForLane, } from "./chrome.js";
import { UnsupportedFirefoxModeError, evaluateFirefoxAttach, launchFirefoxForLane, } from "./firefox.js";
import { evaluateEdgeAttach, launchEdgeForLane } from "./edge.js";
/**
 * The one place launch/attach decisions fan out by browser backend. Everything
 * upstream (allocator, MCP tools, CLI, dashboard) calls these and stays
 * browser-agnostic; chrome.ts / firefox.ts / edge.ts stay single-browser and
 * simple.
 */
export function normalizeBrowserKind(value) {
    if (typeof value !== "string")
        return undefined;
    const v = value.trim().toLowerCase();
    if (v === "chrome" || v === "firefox" || v === "edge")
        return v;
    if (v === "msedge")
        return "edge"; // common alias for Microsoft Edge
    return undefined;
}
/** The launch modes each backend can honour HONESTLY. Edge is Chromium, so it
 *  supports everything Chrome does; Firefox has no off-screen positioning. */
export function supportedModes(browser) {
    return browser === "firefox" ? ["visible", "headless"] : ["visible", "background", "headless"];
}
/** Throw (with the browser's own explanation) when a mode can't be honoured. */
export function assertModeSupported(browser, mode) {
    if (!supportedModes(browser).includes(mode)) {
        if (browser === "firefox")
            throw new UnsupportedFirefoxModeError(mode);
        throw new Error(`Browser "${browser}" does not support mode "${mode}"`);
    }
}
/** Human-readable label for user-facing messages. */
export function browserLabel(browser) {
    if (browser === "firefox")
        return "Firefox";
    if (browser === "edge")
        return "Edge";
    return "Chrome";
}
/** Attach-safety verdict, routed by the lane's browser. */
export function evaluateBrowserAttach(lane, observations) {
    const browser = laneBrowser(lane);
    if (browser === "firefox")
        return evaluateFirefoxAttach(lane, observations);
    if (browser === "edge")
        return evaluateEdgeAttach(lane, observations);
    return evaluateChromeAttach(lane, observations);
}
/** Launch the lane's browser. Options are the Chrome option shape; the
 *  Firefox path honours the shared subset (mode/dryRun/binaryPath/initialUrl/
 *  extraArgs) and refuses what it can't do. Edge takes everything Chrome does. */
export async function launchBrowserForLane(lane, opts = {}) {
    const browser = laneBrowser(lane);
    if (browser === "firefox")
        return launchFirefoxForLane(lane, opts);
    if (browser === "edge")
        return launchEdgeForLane(lane, opts);
    return launchChromeForLane(lane, opts);
}
