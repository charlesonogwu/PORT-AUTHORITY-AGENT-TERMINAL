import { laneBrowser } from "./lane.js";
import { scanPorts } from "./scanner.js";
import { withLock } from "./lockfile.js";
import { launchLockPath } from "./paths.js";
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
    return launchBrowserForLaneWithDeps(lane, opts);
}
async function launchBackend(lane, opts) {
    const browser = laneBrowser(lane);
    if (browser === "firefox")
        return launchFirefoxForLane(lane, opts);
    if (browser === "edge")
        return launchEdgeForLane(lane, opts);
    return launchChromeForLane(lane, opts);
}
/**
 * Serialize the check → launch → ready transition for a lane across processes.
 * The PID returned by browser spawn can be a short-lived relay when an existing
 * browser process adopts the profile. The authoritative PID is therefore the
 * process that actually owns the verified debugging port and profile.
 */
export async function launchBrowserForLaneWithDeps(lane, opts = {}, deps = {}) {
    const doLaunch = deps.launch ?? launchBackend;
    if (opts.dryRun)
        return doLaunch(lane, opts);
    const doScan = deps.scanPorts ?? scanPorts;
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const timeoutMs = deps.readyTimeoutMs ?? (laneBrowser(lane) === "firefox" ? 15_000 : 10_000);
    const mode = opts.mode ?? "visible";
    return withLock(launchLockPath(lane.id), async () => {
        const before = evaluateBrowserAttach(lane, (await doScan()).observations);
        if (before.kind === "safe-attach" && typeof before.observation.pid === "number") {
            return {
                pid: before.observation.pid,
                binary: opts.binaryPath ?? browserLabel(laneBrowser(lane)),
                args: [],
                spawned: false,
                mode,
            };
        }
        if (before.kind !== "safe-free") {
            throw new Error(`Refusing to launch ${browserLabel(laneBrowser(lane))}: ${before.kind}`);
        }
        const launched = await doLaunch(lane, opts);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() <= deadline) {
            const verdict = evaluateBrowserAttach(lane, (await doScan()).observations);
            if (verdict.kind === "safe-attach" && typeof verdict.observation.pid === "number") {
                return { ...launched, pid: verdict.observation.pid };
            }
            if (verdict.kind !== "safe-free") {
                throw new Error(`Launched ${browserLabel(laneBrowser(lane))}, but its lane became unsafe: ${verdict.kind}`);
            }
            await sleep(100);
        }
        throw new Error(`${browserLabel(laneBrowser(lane))} started but did not expose its verified debugging port and isolated profile within ${timeoutMs}ms`);
    }, { staleMs: 30_000, timeoutMs: 30_000, retryMs: 40 });
}
