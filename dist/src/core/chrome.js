import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isWindows } from "./paths.js";
import { normalizeCwd } from "./lane.js";
import { observationsForPort } from "./scanner.js";
export function isChromeProcess(o) {
    const cmd = (o.command ?? "").toLowerCase();
    if (!cmd)
        return false;
    return (cmd.includes("chrome") ||
        cmd.includes("chromium") ||
        cmd.includes("brave") ||
        cmd.includes("msedge") ||
        cmd === "edge.exe");
}
/**
 * Extract --user-data-dir from a process command line. Supports
 *   --user-data-dir=value
 *   --user-data-dir="value with spaces"
 *   --user-data-dir value
 */
export function extractUserDataDir(commandLine) {
    if (!commandLine)
        return undefined;
    const eq = /--user-data-dir=("([^"]+)"|'([^']+)'|([^\s"']+))/.exec(commandLine);
    if (eq)
        return eq[2] ?? eq[3] ?? eq[4];
    const sp = /--user-data-dir\s+("([^"]+)"|'([^']+)'|([^\s"']+))/.exec(commandLine);
    if (sp)
        return sp[2] ?? sp[3] ?? sp[4];
    return undefined;
}
function profilesMatch(expected, found) {
    return normalizeCwd(expected).toLowerCase() === normalizeCwd(found).toLowerCase();
}
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
export function evaluateChromeAttach(lane, observations) {
    const port = lane.chromeDebugPort ?? 0;
    if (!port)
        return { kind: "safe-free", port: 0 };
    const matches = observationsForPort(observations, port);
    if (matches.length === 0)
        return { kind: "safe-free", port };
    // Prefer the most informative observation (one with a command line).
    const obs = matches.find((m) => m.commandLine) ?? matches[0];
    if (!isChromeProcess(obs))
        return { kind: "unsafe-unknown", port, observation: obs };
    const found = extractUserDataDir(obs.commandLine);
    if (!found) {
        // Chrome process whose profile is unknown — refuse rather than attach blindly.
        return { kind: "unsafe-foreign-chrome", port, observation: obs };
    }
    if (profilesMatch(lane.chromeProfileDir, found)) {
        return { kind: "safe-attach", port, observation: obs };
    }
    return { kind: "unsafe-foreign-chrome", port, observation: obs, foundProfile: found };
}
export const DEFAULT_CHROME_MODE = "visible";
/**
 * Flags that push a headed Chrome window fully off the visible desktop.
 * -32000 is the position Windows itself parks minimized windows at, so it is
 * guaranteed to sit outside every real monitor on any multi-monitor layout.
 * The explicit size keeps the off-screen viewport big enough that responsive
 * layouts and lazy-loaded content render as they would on a normal display.
 */
export const OFFSCREEN_WINDOW_ARGS = [
    "--window-position=-32000,-32000",
    "--window-size=1280,1000",
];
/** Coerce an arbitrary value into a ChromeLaunchMode, or undefined if it is
 *  not one of the three recognised modes (case-insensitive, trimmed). */
export function normalizeChromeMode(value) {
    if (typeof value !== "string")
        return undefined;
    const v = value.trim().toLowerCase();
    if (v === "visible" || v === "background" || v === "headless")
        return v;
    return undefined;
}
/**
 * Resolve the effective launch mode using the precedence:
 *
 *   per-call argument  >  PORTPILOT_CHROME_MODE env var  >  config  >  visible
 *
 * The env var lets a user flip every launch on a machine to background mode
 * without touching config, and a per-call `mode` always wins so an agent can
 * still force a visible window for a login step even when the global default
 * is background. `envMode` is injectable for tests.
 */
export function resolveChromeMode(perCall, configMode, envMode = process.env.PORTPILOT_CHROME_MODE) {
    return (normalizeChromeMode(perCall) ??
        normalizeChromeMode(envMode) ??
        normalizeChromeMode(configMode) ??
        DEFAULT_CHROME_MODE);
}
/** The extra Chrome flags implied by a launch mode. */
export function modeLaunchArgs(mode) {
    switch (mode) {
        case "headless":
            return ["--headless=new"];
        case "background":
            return [...OFFSCREEN_WINDOW_ARGS];
        case "visible":
        default:
            return [];
    }
}
const DEFAULT_CHROME_BINARIES = {
    win32: [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    darwin: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"],
};
/**
 * Acceptable binary basenames for spawning. Anything outside this set is
 * refused by `resolveChromeBinary` when caller-supplied. Env-var paths
 * (PORTPILOT_CHROME_BIN / CHROME_PATH) bypass this check because they are
 * user-controlled at the OS level — if an attacker can set your env vars
 * they already have shell access to your account.
 */
const CHROMIUM_FAMILY_BASENAMES = new Set([
    "chrome.exe",
    "chrome",
    "google chrome", // macOS .app bundle binary
    "chromium.exe",
    "chromium",
    "chromium-browser",
    "msedge.exe",
    "msedge",
    "microsoft edge",
    "microsoft-edge",
    "microsoft-edge-stable",
    "microsoft-edge-beta",
    "microsoft-edge-dev",
    "brave.exe",
    "brave",
    "brave-browser",
    "google-chrome",
    "google-chrome-stable",
]);
function basenameLower(p) {
    return (p.split(/[\\/]+/).pop() ?? "").toLowerCase();
}
/**
 * Returns true iff `p` looks like a Chromium-family browser binary by its
 * basename (case-insensitive). Used to gate caller-supplied `binaryPath`
 * values that come in via the MCP `launch_chrome_lane` / `open` tools.
 */
export function isChromeBinaryPath(p) {
    if (!p)
        return false;
    return CHROMIUM_FAMILY_BASENAMES.has(basenameLower(p));
}
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
export function isSafeInitialUrl(url) {
    if (!url || url.length === 0)
        return false;
    if (url.startsWith("-"))
        return false;
    return /^(https?:|about:|file:|chrome:|view-source:|data:)/i.test(url);
}
export class UnsafeChromeArgError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnsafeChromeArgError";
    }
}
export function resolveChromeBinary(explicit) {
    if (explicit && explicit.length > 0) {
        if (!isChromeBinaryPath(explicit)) {
            throw new UnsafeChromeArgError(`Refusing to launch "${explicit}" — basename is not a recognised Chromium-family binary. ` +
                `Allowed basenames: ${Array.from(CHROMIUM_FAMILY_BASENAMES).sort().join(", ")}`);
        }
        return explicit;
    }
    const envBin = process.env.PORTPILOT_CHROME_BIN ?? process.env.CHROME_PATH;
    if (envBin && envBin.length > 0)
        return envBin;
    const candidates = DEFAULT_CHROME_BINARIES[process.platform] ?? DEFAULT_CHROME_BINARIES.linux;
    return candidates[0];
}
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
export function buildLaunchPlan(lane, opts = {}) {
    if (typeof lane.chromeDebugPort !== "number") {
        throw new Error("Lane has no chromeDebugPort assigned");
    }
    const binary = resolveChromeBinary(opts.binaryPath);
    const mode = opts.mode ?? DEFAULT_CHROME_MODE;
    const args = [
        `--remote-debugging-port=${lane.chromeDebugPort}`,
        `--user-data-dir=${lane.chromeProfileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        // Mode flags (off-screen for background, --headless=new for headless,
        // nothing for visible) go before any caller extraArgs and the URL.
        ...modeLaunchArgs(mode),
    ];
    if (opts.extraArgs)
        args.push(...opts.extraArgs);
    // initialUrl must be the LAST positional arg — Chrome treats trailing
    // non-flag arguments as start-up URLs. Validate the value first so a
    // crafted "--load-extension=..." can't pose as a URL.
    if (opts.initialUrl && opts.initialUrl.length > 0) {
        if (!isSafeInitialUrl(opts.initialUrl)) {
            throw new UnsafeChromeArgError(`Refusing to pass "${opts.initialUrl}" as Chrome's startup URL. ` +
                `URLs must use http/https/about/file/chrome/view-source/data scheme and must not begin with "-".`);
        }
        args.push(opts.initialUrl);
    }
    return { binary, args, profileDir: lane.chromeProfileDir, port: lane.chromeDebugPort };
}
/**
 * Launch Chrome for the lane. Caller must ensure `evaluateChromeAttach`
 * returned `safe-free` first. We do not enforce that here because callers may
 * have already decided to attach to a `safe-attach` instance instead.
 *
 * Hybrid background strategy: we spawn Chrome directly (so the returned pid is
 * the real Chrome pid the dashboard + kill button can use) and rely on the
 * off-screen `--window-position` flags plus Windows' foreground lock to keep
 * the window invisible and non-activating. No `cmd /c start /min` shim — that
 * would hand us the shim's short-lived pid instead of Chrome's.
 */
export async function launchChromeForLane(lane, opts = {}) {
    const mode = opts.mode ?? DEFAULT_CHROME_MODE;
    const plan = buildLaunchPlan(lane, opts);
    await mkdir(plan.profileDir, { recursive: true });
    if (opts.dryRun) {
        return { binary: plan.binary, args: plan.args, spawned: false, mode };
    }
    const detached = opts.detached !== false;
    const child = spawn(plan.binary, plan.args, {
        detached,
        stdio: "ignore",
        // For non-visible modes there is never a console we want, so hide it.
        // (windowsHide only affects the console window, never Chrome's GUI — the
        // off-screen flags handle the GUI for background mode.)
        windowsHide: mode !== "visible",
        shell: false,
    });
    if (detached)
        child.unref();
    return { pid: child.pid, binary: plan.binary, args: plan.args, spawned: true, mode };
}
void isWindows; // satisfy isolatedModules for unused exports
