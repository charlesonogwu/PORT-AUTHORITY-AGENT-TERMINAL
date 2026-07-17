/**
 * Dashboard snapshot — live-first data model.
 *
 * The PRIMARY entity is a "live session" — a real Chrome process listening
 * with --remote-debugging-port that we can talk to via CDP. That's the
 * ground truth.
 *
 * portpilot's registry is SECONDARY — it describes what agents *intended*
 * to do. The dashboard surfaces it as `registryHealth` summary and
 * `conflicts` warnings; we never let stale registry rows pollute the live
 * view.
 */
import { canonicalizeOwner, isStale, laneSessionId } from "../core/lane.js";
import { scanPorts } from "../core/scanner.js";
import { isChromeProcess } from "../core/chrome.js";
import { loadConfig } from "../core/config.js";
import { portpilotHome, registryPath } from "../core/paths.js";
import { markStaleLanes } from "../core/registry.js";
import { profileHasSavedData } from "../core/profiles.js";
import { findAllAgentChromes, findAllAgentFirefoxes, findLiveChromes, findLiveFirefoxes, inferCwdFromProfile, inferOwnerFromProfile, inferProjectFromProfile, readPortpilotLanes, } from "./sources.js";
import { collectProcessSnapshot, sumTreeMemoryMB } from "./process-info.js";
import { inferAgentFromLiveChrome, walkParentChain } from "./agent-inference.js";
import { BirthRegistry } from "./chrome-births.js";
async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok)
            throw new Error(`HTTP ${res.status} from ${url}`);
        return (await res.json());
    }
    finally {
        clearTimeout(t);
    }
}
async function gatherCdp(port, timeoutMs) {
    try {
        const [version, tabs] = await Promise.all([
            fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs),
            fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs),
        ]);
        return {
            version: version.Browser,
            tabs: tabs.filter((t) => t.type === "page" || t.type === "background_page"),
        };
    }
    catch (err) {
        return { tabs: [], error: err.message };
    }
}
function profilesEqual(a, b) {
    if (!a || !b)
        return false;
    return a.replace(/[\\/]+/g, "/").toLowerCase() === b.replace(/[\\/]+/g, "/").toLowerCase();
}
function findOwningLane(liveProfile, livePort, lanes, browser = "chrome") {
    // Strict match: same browser + same port + same profile dir. Profile match is
    // the authoritative signal — port alone is not enough. Browser must match so
    // a Firefox process can't be matched to a Chrome lane (or vice versa).
    return lanes.find((l) => l.browser === browser && l.chromeDebugPort === livePort && profilesEqual(l.chromeProfileDir, liveProfile));
}
function isInternalTab(t) {
    const url = t.url ?? "";
    return url.startsWith("chrome://") || url.startsWith("devtools://") || url.startsWith("edge://");
}
function buildLiveSession(live, ppLane, cdp, processSnap, births) {
    const lane = ppLane;
    const registeredBy = ppLane ? "portpilot" : null;
    const profile = live.profileDir ?? "";
    let agent;
    let agentConfidence;
    let project;
    let projectConfidence;
    let cwd;
    let cwdConfidence;
    let inferenceConfidence;
    let inferenceEvidence;
    if (lane) {
        // Canonicalize the registered owner too — old lanes in the registry
        // may have non-canonical strings like "codex-test-alpha". The
        // dashboard's AGENT column should always show only the LLM provider
        // name; any custom suffix already lives in sessionId.
        agent = canonicalizeOwner(lane.owner).canonical;
        agentConfidence = "registered";
        project = lane.project;
        projectConfidence = "registered";
        cwd = lane.cwd;
        cwdConfidence = "registered";
    }
    else {
        // No portpilot reservation. Run the smarter agent fingerprint —
        // process ancestry + CDP peer + profile keyword — and fall back to
        // the legacy keyword-only path if the new inference returns "external".
        const inferred = inferAgentFromLiveChrome({ chromePid: live.pid, port: live.port, profileDir: profile || undefined, births }, processSnap);
        let inferredAgent = inferred.agent;
        if (inferredAgent === "external") {
            // Legacy fallback — covers cases where the agent process has
            // already exited but the profile path still leaks a name.
            inferredAgent = inferOwnerFromProfile(profile);
        }
        agent = inferredAgent;
        agentConfidence = inferredAgent === "external" ? "unknown" : "inferred";
        inferenceConfidence = inferred.confidence;
        inferenceEvidence = inferred.evidence;
        project = inferProjectFromProfile(profile);
        projectConfidence = project === "unknown" ? "unknown" : "inferred";
        const inferredCwd = inferCwdFromProfile(profile);
        if (inferredCwd) {
            cwd = inferredCwd;
            cwdConfidence = "inferred";
        }
        else {
            cwdConfidence = "unknown";
        }
    }
    const session = {
        key: `${live.pid ?? "?"}:${live.port}:${profile}`,
        agent,
        agentConfidence,
        project,
        projectConfidence,
        cwdConfidence,
        pid: live.pid ?? 0,
        chromeDebugPort: live.port,
        debugMode: live.debugMode,
        chromeProfileDir: profile,
        browser: live.browser ?? lane?.browser ?? "chrome",
        hasSavedData: false, // filled in by the caller (async stat check)
        tabs: cdp.tabs,
        primaryTabs: cdp.tabs.filter((t) => !isInternalTab(t)),
        registeredBy,
    };
    if (cwd)
        session.cwd = cwd;
    if (lane?.task)
        session.task = lane.task;
    if (lane?.appPort !== undefined)
        session.appPort = lane.appPort;
    if (cdp.version)
        session.browserVersion = cdp.version;
    if (cdp.error)
        session.cdpError = cdp.error;
    if (lane?.id)
        session.laneId = lane.id;
    if (inferenceConfidence)
        session.agentInferenceConfidence = inferenceConfidence;
    if (inferenceEvidence && inferenceEvidence.length > 0)
        session.agentInferenceEvidence = inferenceEvidence;
    return session;
}
function summarizeRegistry(lanes, liveByPortAndProfile, found, now) {
    let live = 0;
    let stale = 0;
    let empty = 0;
    const staleEntries = [];
    for (const lane of lanes) {
        if (typeof lane.chromeDebugPort !== "number") {
            empty++;
            continue;
        }
        const key = `${lane.chromeDebugPort}:${(lane.chromeProfileDir ?? "").replace(/[\\/]+/g, "/").toLowerCase()}`;
        if (liveByPortAndProfile.has(key)) {
            live++;
            continue;
        }
        const sameLane = { status: lane.status, lastSeen: lane.lastSeen };
        const looksAbandoned = isStale(sameLane, now) || lane.status === "stale" || lane.status === "released";
        const portInUseByOther = Array.from(liveByPortAndProfile.values()).some((l) => l.port === lane.chromeDebugPort);
        if (looksAbandoned || portInUseByOther) {
            stale++;
            staleEntries.push({
                laneId: lane.id,
                agent: lane.owner,
                project: lane.project,
                reason: portInUseByOther
                    ? `port ${lane.chromeDebugPort} is held by a different profile`
                    : `lastSeen ${lane.lastSeen}`,
            });
        }
        else {
            empty++;
        }
    }
    return { found, total: lanes.length, live, stale, empty, staleEntries };
}
function detectConflicts(portpilotLanes, liveChromes) {
    const conflicts = [];
    // Released lanes are historical paperwork — they no longer claim a port.
    // Filter them out before any conflict reasoning. Without this, a stack of
    // old released entries on a port produces a flood of false alarms even
    // when only one (or zero) lanes are actually using the port.
    const active = portpilotLanes.filter((l) => l.status !== "released");
    // 1. Registry says X owns the port, but the live Chrome's profile is Y.
    for (const lane of active) {
        if (typeof lane.chromeDebugPort !== "number")
            continue;
        const live = liveChromes.find((l) => l.port === lane.chromeDebugPort);
        if (!live)
            continue;
        if (profilesEqual(live.profileDir, lane.chromeProfileDir))
            continue;
        conflicts.push({
            kind: "registry-mismatch-with-live",
            port: lane.chromeDebugPort,
            message: `port ${lane.chromeDebugPort}: portpilot reserves for ${lane.owner}/${lane.project}, ` +
                `but the running Chrome's --user-data-dir is ${live.profileDir ?? "(unknown)"}`,
            involvedLaneIds: [lane.id],
        });
    }
    // 2. Two ACTIVE lanes claiming the same port — a real bug if it ever fires.
    const byPort = new Map();
    for (const lane of active) {
        if (typeof lane.chromeDebugPort !== "number")
            continue;
        const arr = byPort.get(lane.chromeDebugPort) ?? [];
        arr.push(lane);
        byPort.set(lane.chromeDebugPort, arr);
    }
    for (const [port, ls] of byPort) {
        if (ls.length > 1) {
            conflicts.push({
                kind: "duplicate-port-within-tool",
                port,
                message: `portpilot: ${ls.length} active reservations claim port ${port}`,
                involvedLaneIds: ls.map((l) => l.id),
            });
        }
    }
    return conflicts;
}
export async function buildSnapshot(opts = {}) {
    const cdpTimeoutMs = opts.cdpTimeoutMs ?? 1500;
    // Promote any registry entry whose lastSeen is too old to "stale" before
    // we read. Without this, an active-status zombie keeps consuming a slot
    // in the capacity meter even though no agent is using it. After this
    // pass the meter reflects current truth: only lanes that have actually
    // checked in recently count.
    await markStaleLanes();
    const [portpilotLanes, scan, config, processSnap, births] = await Promise.all([
        readPortpilotLanes(),
        scanPorts(),
        loadConfig(),
        // One PowerShell round-trip for the entire snapshot's worth of agent
        // inference. Empty on non-Windows or on failure, in which case the
        // legacy profile-keyword fallback still runs.
        collectProcessSnapshot(),
        // Persistent record of who launched each chrome, captured the first
        // time we saw it. Survives the launcher process exiting.
        BirthRegistry.load(),
    ]);
    // Two enumeration sources, deduped by PID:
    //   1. findAllAgentChromes — every Chromium process whose command line
    //      has --remote-debugging-port OR --remote-debugging-pipe. Catches
    //      Playwright/Puppeteer pipe-mode Chromes that have no TCP port.
    //   2. findLiveChromes — the legacy port-scan path. Still useful as a
    //      backup when the process snapshot is empty (non-Windows, perms
    //      denied, etc.) and as belt-and-braces for the port-mode case.
    const fromProcs = findAllAgentChromes(processSnap);
    const fromFirefox = findAllAgentFirefoxes(processSnap);
    const fromScan = findLiveChromes(scan.observations);
    const fromScanFirefox = findLiveFirefoxes(scan.observations);
    const seenPids = new Set();
    const liveChromes = [];
    for (const lc of [...fromProcs, ...fromFirefox]) {
        if (lc.pid !== undefined)
            seenPids.add(lc.pid);
        liveChromes.push(lc);
    }
    for (const lc of [...fromScan, ...fromScanFirefox]) {
        if (lc.pid !== undefined && seenPids.has(lc.pid))
            continue;
        if (lc.pid !== undefined)
            seenPids.add(lc.pid);
        liveChromes.push(lc);
    }
    // Capture the parent chain for every chrome we see. First-write wins,
    // so once we record (chromePid, profileDir) we trust THAT chain even
    // if the parent dies before the next snapshot. This is what lets us
    // identify codex/claude/etc. after the launcher CLI has exited.
    for (const live of liveChromes) {
        if (!live.pid || !live.profileDir)
            continue;
        if (births.has(live.pid, live.profileDir))
            continue;
        const chain = walkParentChain(live.pid, processSnap.processes, 8);
        births.record(live.pid, live.profileDir, chain);
    }
    // Best-effort flush — failure here shouldn't block the snapshot.
    births.flush().catch(() => { });
    // Build live sessions. CDP polled in parallel — but only for Chromes
    // running in port mode. Pipe-mode Chromes can't be reached from outside
    // the launcher process, so we emit a friendly placeholder instead.
    const liveSessions = await Promise.all(liveChromes.map(async (live) => {
        const liveBrowser = live.browser ?? "chrome";
        const ppLane = findOwningLane(live.profileDir, live.port, portpilotLanes, liveBrowser);
        // Firefox's debug port is WebDriver BiDi, not Chrome CDP — never poke it
        // with CDP HTTP calls (they'd just time out and produce a bogus error).
        // Chrome pipe-mode also has no reachable CDP. Both degrade cleanly to
        // "no enumerable tabs" with an honest reason.
        const isFirefox = liveBrowser === "firefox";
        const cdp = !isFirefox && live.debugMode === "port" && live.port > 0
            ? await gatherCdp(live.port, cdpTimeoutMs)
            : {
                tabs: [],
                error: isFirefox
                    ? "Firefox lane: BiDi debug port (not Chrome CDP) — tab list unavailable; drive it with the page_* tools"
                    : "pipe-mode CDP — only the launching agent can read this Chrome's tabs",
            };
        const session = buildLiveSession(live, ppLane, cdp, processSnap, births);
        session.hasSavedData = session.chromeProfileDir ? await profileHasSavedData(session.chromeProfileDir) : false;
        if (live.pid !== undefined) {
            const mem = sumTreeMemoryMB(live.pid, processSnap.processes);
            if (mem !== undefined)
                session.memoryMB = mem;
        }
        return session;
    }));
    // Sort: with-pages first, then by agent name, then by port.
    liveSessions.sort((a, b) => {
        const pa = a.primaryTabs.length === 0 ? 1 : 0;
        const pb = b.primaryTabs.length === 0 ? 1 : 0;
        if (pa !== pb)
            return pa - pb;
        if (a.agent !== b.agent)
            return a.agent.localeCompare(b.agent);
        return a.chromeDebugPort - b.chromeDebugPort;
    });
    // Index live chromes by port + (normalized) profile for registry health.
    const liveByPortAndProfile = new Map();
    for (const lc of liveChromes) {
        if (lc.profileDir) {
            const k = `${lc.port}:${lc.profileDir.replace(/[\\/]+/g, "/").toLowerCase()}`;
            liveByPortAndProfile.set(k, lc);
        }
    }
    const now = Date.now();
    const ppHealth = summarizeRegistry(portpilotLanes, liveByPortAndProfile, true, now);
    const conflicts = detectConflicts(portpilotLanes, liveChromes);
    const distinctAgents = new Set(liveSessions.map((s) => s.agent)).size;
    return {
        ok: true,
        generatedAt: new Date().toISOString(),
        scanSource: scan.source,
        scanErrors: scan.errors,
        home: portpilotHome(),
        registryPath: registryPath(),
        config: {
            ...(config.maxActiveLanes !== undefined && { maxActiveLanes: config.maxActiveLanes }),
            ...(config.warnAtActiveLanes !== undefined && { warnAtActiveLanes: config.warnAtActiveLanes }),
            ...(config.chromeDebugRange && { chromeDebugRange: config.chromeDebugRange }),
            ...(config.appPortRange && { appPortRange: config.appPortRange }),
        },
        summary: {
            liveSessions: liveSessions.length,
            distinctAgents,
            conflicts: conflicts.length,
        },
        liveSessions,
        registryHealth: { portpilot: ppHealth },
        conflicts,
    };
}
void laneSessionId;
void isChromeProcess;
