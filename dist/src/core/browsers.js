import { laneBrowser } from "./lane.js";
import { evaluateChromeAttach, launchChromeForLane, } from "./chrome.js";
import { UnsupportedFirefoxModeError, evaluateFirefoxAttach, launchFirefoxForLane, } from "./firefox.js";
/**
 * The one place launch/attach decisions fan out by browser backend. Everything
 * upstream (allocator, MCP tools, CLI, dashboard) calls these and stays
 * browser-agnostic; chrome.ts / firefox.ts stay single-browser and simple.
 */
export function normalizeBrowserKind(value) {
    if (typeof value !== "string")
        return undefined;
    const v = value.trim().toLowerCase();
    if (v === "chrome" || v === "firefox")
        return v;
    return undefined;
}
/** The launch modes each backend can honour HONESTLY. */
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
/** Attach-safety verdict, routed by the lane's browser. */
export function evaluateBrowserAttach(lane, observations) {
    return laneBrowser(lane) === "firefox"
        ? evaluateFirefoxAttach(lane, observations)
        : evaluateChromeAttach(lane, observations);
}
/** Launch the lane's browser. Options are the Chrome option shape; the
 *  Firefox path honours the shared subset (mode/dryRun/binaryPath/initialUrl/
 *  extraArgs) and refuses what it can't do. */
export async function launchBrowserForLane(lane, opts = {}) {
    return laneBrowser(lane) === "firefox"
        ? launchFirefoxForLane(lane, opts)
        : launchChromeForLane(lane, opts);
}
