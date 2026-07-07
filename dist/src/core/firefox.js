import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { normalizeCwd } from "./lane.js";
import { observationsForPort } from "./scanner.js";
import { UnsafeChromeArgError, isSafeInitialUrl, } from "./chrome.js";
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
export class UnsupportedFirefoxModeError extends Error {
    constructor(mode) {
        super(`Firefox does not support mode="${mode}". Firefox has no off-screen window ` +
            `positioning, so "background" cannot be honoured honestly. Use mode="visible" ` +
            `or mode="headless" (or browser="chrome" for background).`);
        this.name = "UnsupportedFirefoxModeError";
    }
}
const FIREFOX_FAMILY_BASENAMES = new Set([
    "firefox.exe",
    "firefox",
    "firefox-bin",
    "firefox-esr",
    "librewolf.exe",
    "librewolf",
    "waterfox.exe",
    "waterfox",
]);
function basenameLower(p) {
    return (p.split(/[\\/]+/).pop() ?? "").toLowerCase();
}
/** True iff `p` looks like a Firefox-family binary by basename. Gates
 *  caller-supplied binaryPath values coming in via MCP/CLI. */
export function isFirefoxBinaryPath(p) {
    if (!p)
        return false;
    return FIREFOX_FAMILY_BASENAMES.has(basenameLower(p));
}
const DEFAULT_FIREFOX_BINARIES = {
    win32: [
        "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
        "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
    ],
    darwin: ["/Applications/Firefox.app/Contents/MacOS/firefox"],
    linux: ["firefox", "firefox-esr"],
};
export function resolveFirefoxBinary(explicit) {
    if (explicit && explicit.length > 0) {
        if (!isFirefoxBinaryPath(explicit)) {
            throw new UnsafeChromeArgError(`Refusing to launch "${explicit}" — basename is not a recognised Firefox-family binary. ` +
                `Allowed basenames: ${Array.from(FIREFOX_FAMILY_BASENAMES).sort().join(", ")}`);
        }
        return explicit;
    }
    const envBin = process.env.PORTPILOT_FIREFOX_BIN ?? process.env.FIREFOX_PATH;
    if (envBin && envBin.length > 0)
        return envBin;
    const candidates = DEFAULT_FIREFOX_BINARIES[process.platform] ?? DEFAULT_FIREFOX_BINARIES.linux;
    return candidates[0];
}
export function isFirefoxProcess(o) {
    const cmd = (o.command ?? "").toLowerCase();
    if (!cmd)
        return false;
    return cmd.includes("firefox") || cmd.includes("librewolf") || cmd.includes("waterfox");
}
/**
 * Extract the `-profile` / `--profile` directory from a Firefox command line.
 * Firefox accepts both single- and double-dash forms, space-separated
 * (`-profile "C:\dir with spaces"` or -profile C:\dir).
 */
export function extractFirefoxProfileDir(commandLine) {
    if (!commandLine)
        return undefined;
    const m = /(?:^|\s)--?profile\s+("([^"]+)"|'([^']+)'|([^\s"']+))/.exec(commandLine);
    if (m)
        return m[2] ?? m[3] ?? m[4];
    return undefined;
}
function profilesMatch(expected, found) {
    return normalizeCwd(expected).toLowerCase() === normalizeCwd(found).toLowerCase();
}
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
export function evaluateFirefoxAttach(lane, observations) {
    const port = lane.chromeDebugPort ?? 0;
    if (!port)
        return { kind: "safe-free", port: 0 };
    const matches = observationsForPort(observations, port);
    if (matches.length === 0)
        return { kind: "safe-free", port };
    const obs = matches.find((m) => m.commandLine) ?? matches[0];
    if (!isFirefoxProcess(obs))
        return { kind: "unsafe-unknown", port, observation: obs };
    const found = extractFirefoxProfileDir(obs.commandLine);
    if (!found) {
        return { kind: "unsafe-foreign-chrome", port, observation: obs };
    }
    if (profilesMatch(lane.chromeProfileDir, found)) {
        return { kind: "safe-attach", port, observation: obs };
    }
    return { kind: "unsafe-foreign-chrome", port, observation: obs, foundProfile: found };
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
export function buildFirefoxLaunchPlan(lane, opts = {}) {
    if (typeof lane.chromeDebugPort !== "number") {
        throw new Error("Lane has no debug port assigned");
    }
    const mode = opts.mode ?? "visible";
    if (mode === "background")
        throw new UnsupportedFirefoxModeError(mode);
    const binary = resolveFirefoxBinary(opts.binaryPath);
    const args = [
        "-profile",
        lane.chromeProfileDir,
        "-no-remote",
        "--remote-debugging-port",
        String(lane.chromeDebugPort),
    ];
    if (mode === "headless")
        args.push("-headless");
    if (opts.extraArgs)
        args.push(...opts.extraArgs);
    if (opts.initialUrl && opts.initialUrl.length > 0) {
        if (!isSafeInitialUrl(opts.initialUrl)) {
            throw new UnsafeChromeArgError(`Refusing to pass "${opts.initialUrl}" as Firefox's startup URL. ` +
                `URLs must use http/https/about/file/chrome/view-source/data scheme and must not begin with "-".`);
        }
        args.push(opts.initialUrl);
    }
    return { binary, args, profileDir: lane.chromeProfileDir, port: lane.chromeDebugPort };
}
/** Launch Firefox for the lane. Caller must have verified the lane is safe
 *  (evaluateFirefoxAttach → safe-free) first, mirroring the Chrome contract. */
export async function launchFirefoxForLane(lane, opts = {}) {
    const mode = opts.mode ?? "visible";
    const plan = buildFirefoxLaunchPlan(lane, opts);
    await mkdir(plan.profileDir, { recursive: true });
    if (opts.dryRun) {
        return { binary: plan.binary, args: plan.args, spawned: false, mode };
    }
    const detached = opts.detached !== false;
    const child = spawn(plan.binary, plan.args, {
        detached,
        stdio: "ignore",
        windowsHide: mode !== "visible",
        shell: false,
    });
    if (detached)
        child.unref();
    return { pid: child.pid, binary: plan.binary, args: plan.args, spawned: true, mode };
}
