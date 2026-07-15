import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { normalizeCwd } from "./lane.js";
import { observationsForPort } from "./scanner.js";
import { UnsafeChromeArgError, BrowserBinaryNotFoundError, buildLaunchPlan, extractUserDataDir, launchChromeForLane, } from "./chrome.js";
/**
 * Microsoft Edge backend.
 *
 * Edge is Chromium, so unlike Firefox it needs NO protocol caveats: the lane's
 * debug port serves real Chrome CDP, `--user-data-dir` isolates the profile,
 * and all three launch modes (visible / background / headless) work exactly
 * like Chrome's. This module only owns what actually differs:
 *
 *   - Binary resolution (msedge.exe lives in its own install dirs, which vary
 *     between "Program Files" and "Program Files (x86)" across machines).
 *   - Attach identity: an Edge lane should only report safe-attach for an
 *     EDGE process on its port — a Chrome on the same port is not ours.
 *
 * Everything else (arg building, URL safety gate, spawn) delegates to
 * chrome.ts so the two Chromium backends can never drift apart.
 */
const EDGE_FAMILY_BASENAMES = new Set([
    "msedge.exe",
    "msedge",
    "microsoft edge", // macOS .app bundle binary
    "microsoft-edge",
    "microsoft-edge-stable",
    "microsoft-edge-beta",
    "microsoft-edge-dev",
]);
function basenameLower(p) {
    return (p.split(/[\\/]+/).pop() ?? "").toLowerCase();
}
/** True iff `p` looks like an Edge-family binary by basename. Gates
 *  caller-supplied binaryPath values coming in via MCP/CLI. */
export function isEdgeBinaryPath(p) {
    if (!p)
        return false;
    return EDGE_FAMILY_BASENAMES.has(basenameLower(p));
}
/** Edge's install dir differs between x64 ("Program Files (x86)" for stable
 *  on 64-bit Windows) and other setups, so unlike Chrome we probe for the
 *  first candidate that exists instead of trusting a fixed first entry. */
const DEFAULT_EDGE_BINARIES = {
    win32: [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    darwin: macOsEdgeCandidates(),
    linux: ["microsoft-edge", "microsoft-edge-stable"],
};
export function macOsEdgeCandidates(home = homedir()) {
    const apps = ["/Applications", posix.join(home, "Applications")];
    const bundles = [
        ["Microsoft Edge.app", "Microsoft Edge"],
        ["Microsoft Edge Beta.app", "Microsoft Edge Beta"],
        ["Microsoft Edge Dev.app", "Microsoft Edge Dev"],
        ["Microsoft Edge Canary.app", "Microsoft Edge Canary"],
    ];
    return apps.flatMap((appDir) => bundles.map(([bundle, binary]) => posix.join(appDir, bundle, "Contents", "MacOS", binary)));
}
export function resolveEdgeBinary(explicit) {
    if (explicit && explicit.length > 0) {
        if (!isEdgeBinaryPath(explicit)) {
            throw new UnsafeChromeArgError(`Refusing to launch "${explicit}" — basename is not a recognised Edge-family binary. ` +
                `Allowed basenames: ${Array.from(EDGE_FAMILY_BASENAMES).sort().join(", ")}`);
        }
        return explicit;
    }
    const envBin = process.env.PORTPILOT_EDGE_BIN ?? process.env.EDGE_PATH;
    if (envBin && envBin.length > 0)
        return envBin;
    const candidates = DEFAULT_EDGE_BINARIES[process.platform] ?? DEFAULT_EDGE_BINARIES.linux;
    if (process.platform === "win32" || process.platform === "darwin") {
        const found = candidates.find((c) => existsSync(c));
        if (found)
            return found;
    }
    if (process.platform === "darwin")
        throw new BrowserBinaryNotFoundError("Microsoft Edge", candidates);
    return candidates[0];
}
export function isEdgeProcess(o) {
    const cmd = (o.command ?? "").toLowerCase();
    if (!cmd)
        return false;
    return cmd.includes("msedge") || cmd.includes("microsoft edge") || cmd.includes("microsoft-edge") || cmd === "edge.exe";
}
function profilesMatch(expected, found) {
    return normalizeCwd(expected).toLowerCase() === normalizeCwd(found).toLowerCase();
}
/**
 * Edge flavour of the attach-safety verdict. Same shape and kinds as
 * evaluateChromeAttach so every consumer (check_lane, doctor, dashboard)
 * works unchanged, but the identity check requires an EDGE process:
 *
 *   - free port                            → safe-free
 *   - Edge with matching --user-data-dir   → safe-attach
 *   - Edge with different/unknown profile  → unsafe-foreign-chrome
 *   - non-Edge (including Chrome!)         → unsafe-unknown
 *
 * A Chrome on an Edge lane's port is deliberately unsafe-unknown: it may be
 * Chromium-family, but it is not the browser this lane reserved.
 */
export function evaluateEdgeAttach(lane, observations) {
    const port = lane.chromeDebugPort ?? 0;
    if (!port)
        return { kind: "safe-free", port: 0 };
    const matches = observationsForPort(observations, port);
    if (matches.length === 0)
        return { kind: "safe-free", port };
    const obs = matches.find((m) => m.commandLine) ?? matches[0];
    if (!isEdgeProcess(obs))
        return { kind: "unsafe-unknown", port, observation: obs };
    const found = extractUserDataDir(obs.commandLine);
    if (!found) {
        return { kind: "unsafe-foreign-chrome", port, observation: obs };
    }
    if (profilesMatch(lane.chromeProfileDir, found)) {
        return { kind: "safe-attach", port, observation: obs };
    }
    return { kind: "unsafe-foreign-chrome", port, observation: obs, foundProfile: found };
}
/** Build the Edge launch command: identical to Chrome's (Edge IS Chromium),
 *  just with the Edge binary resolved/validated first. */
export function buildEdgeLaunchPlan(lane, opts = {}) {
    const binary = resolveEdgeBinary(opts.binaryPath);
    return buildLaunchPlan(lane, { ...opts, binaryPath: binary });
}
/** Launch Edge for the lane. Same contract as launchChromeForLane. */
export async function launchEdgeForLane(lane, opts = {}) {
    const binary = resolveEdgeBinary(opts.binaryPath);
    return launchChromeForLane(lane, { ...opts, binaryPath: binary });
}
