import { laneBrowser, DEFAULT_APP_PORT_RANGE, DEFAULT_CHROME_DEBUG_RANGE, DEFAULT_SESSION_ID, canonicalizeOwner, cwdIdentity, isStale, laneSessionId, newLaneId, normalizeCwd, nowIso, ownerSlug, projectSlug, sessionSlug, validatePortRange, } from "./lane.js";
import { profileDirFor } from "./paths.js";
import { isPortInUse, scanPorts } from "./scanner.js";
import { evaluateBrowserAttach, normalizeBrowserKind } from "./browsers.js";
import { listLanes, updateRegistry } from "./registry.js";
import { CapacityError, loadConfig } from "./config.js";
function rangeIter(range) {
    const out = [];
    for (let p = range.start; p <= range.end; p++)
        out.push(p);
    return out;
}
function pickPort(range, taken) {
    for (const p of rangeIter(range)) {
        if (!taken.has(p))
            return p;
    }
    return undefined;
}
function buildContext(observations, lanes) {
    const occupied = new Set();
    for (const o of observations)
        occupied.add(o.port);
    const reservedAppPorts = new Set();
    const reservedChromePorts = new Set();
    for (const lane of lanes) {
        if (lane.status === "released")
            continue;
        // A STALE lane only holds its ports while something actually listens
        // there (the `occupied` set already blocks live ports). A stale lane
        // with a dead browser is a leftover, not a reservation — without this
        // rule abandoned lanes accumulate until they squat the entire range and
        // every allocation fails with "No free ... port" (observed live: 74
        // stale lanes holding all 78 debug ports while only 5 were listening).
        // If an agent later returns to a reclaimed port, check_lane's safety
        // verdict refuses the attach — a safe, loud failure for one lane
        // instead of a global allocation outage for everyone.
        if (lane.status === "stale")
            continue;
        if (typeof lane.appPort === "number")
            reservedAppPorts.add(lane.appPort);
        if (typeof lane.chromeDebugPort === "number")
            reservedChromePorts.add(lane.chromeDebugPort);
    }
    return { occupied, reservedAppPorts, reservedChromePorts };
}
/**
 * Retire port claims we just handed to another lane from any STALE lane
 * still bookkeeping them. Reclaiming (buildContext ignores stale holds) must
 * also drop the stale lane's claim in the same transaction — otherwise the
 * registry ends up with two lanes on one port and the dashboard reports a
 * conflict (seen live: a stale drive-bench lane and a fresh lane both
 * claiming 9322). The stale lane keeps its identity and profile; if its
 * agent returns, allocateLane's existing-lane path mints it a fresh port.
 */
function stripReclaimedPorts(lanes, claimantId, appPort, chromeDebugPort) {
    if (appPort === undefined && chromeDebugPort === undefined)
        return lanes;
    return lanes.map((l) => {
        if (l.status !== "stale" || l.id === claimantId)
            return l;
        let out = l;
        if (chromeDebugPort !== undefined && out.chromeDebugPort === chromeDebugPort) {
            const { chromeDebugPort: _dropped, ...rest } = out;
            out = rest;
        }
        if (appPort !== undefined && out.appPort === appPort) {
            const { appPort: _dropped, ...rest } = out;
            out = rest;
        }
        return out;
    });
}
function buildProfileDir(owner, project, sessionId, taken, override, browser) {
    if (override)
        return override;
    const o = ownerSlug(owner);
    const p = projectSlug(project);
    const s = sessionId === DEFAULT_SESSION_ID ? undefined : sessionId;
    const base = profileDirFor(o, p, { sessionId: s, browser });
    if (!taken.has(base.toLowerCase()))
        return base;
    let suffix = 2;
    while (true) {
        const candidate = profileDirFor(o, p, { sessionId: s, browser, dedupeSuffix: String(suffix) });
        if (!taken.has(candidate.toLowerCase()))
            return candidate;
        suffix++;
    }
}
function takenProfileDirs(lanes) {
    const out = new Set();
    for (const lane of lanes) {
        if (lane.status === "released")
            continue;
        out.add(lane.chromeProfileDir.toLowerCase());
    }
    return out;
}
export function findExistingLane(lanes, owner, cwd, sessionId = DEFAULT_SESSION_ID, browser = "chrome") {
    const target = cwdIdentity(cwd);
    // Match canonical-against-canonical so a registry that still contains
    // pre-canonicalization owners (e.g. "codex-test-alpha" written before
    // canonicalizeOwner shipped) can still satisfy idempotency for new
    // callers passing the same raw inputs. Without this, allocateLane would
    // create a duplicate lane on every retry, eating ports + profile dirs.
    // Browser must match too: a Chrome lane and a Firefox lane for the same
    // (owner, cwd, session) are DIFFERENT lanes — reusing one for the other
    // would hand a Firefox caller a Chrome profile dir.
    return lanes.find((l) => {
        if (laneBrowser(l) !== browser)
            return false;
        return laneMatchesKey(l, owner, target, sessionId);
    });
}
function laneMatchesKey(l, owner, normalizedCwd, sessionId) {
    if (cwdIdentity(l.cwd) !== normalizedCwd)
        return false;
    if (laneSessionId(l) !== sessionId)
        return false;
    if (l.status === "released")
        return false;
    if (l.owner === owner)
        return true;
    return canonicalizeOwner(l.owner).canonical === owner;
}
/**
 * Find an existing lane for (owner, cwd, sessionId) regardless of browser.
 * Used when a caller does NOT specify a browser: reconnecting to whatever
 * lane it already has beats creating a second lane in the default browser.
 * When the key has lanes in several browsers (created explicitly), prefer
 * the `prefer` browser if one matches, else the most recently seen lane.
 */
export function findExistingLaneAnyBrowser(lanes, owner, cwd, sessionId = DEFAULT_SESSION_ID, prefer) {
    const target = cwdIdentity(cwd);
    const matches = lanes.filter((l) => laneMatchesKey(l, owner, target, sessionId));
    if (matches.length === 0)
        return undefined;
    if (prefer) {
        const hit = matches.find((l) => laneBrowser(l) === prefer);
        if (hit)
            return hit;
    }
    return matches.reduce((a, b) => (a.lastSeen >= b.lastSeen ? a : b));
}
/**
 * Reserve a lane for `owner` working in `cwd`. If an active reservation
 * already exists for this (owner, cwd, sessionId) tuple, it is returned
 * unchanged. Different sessionIds produce different lanes — the same agent
 * can hold many parallel lanes in one project.
 *
 * Honours `maxActiveLanes` from the local config: when reached, a brand new
 * allocation throws CapacityError. Idempotent re-reservation of an existing
 * lane is always allowed, even at the cap.
 */
export async function allocateLane(opts) {
    if (opts.appPortRange)
        validatePortRange(opts.appPortRange, "app");
    if (opts.chromeDebugRange)
        validatePortRange(opts.chromeDebugRange, "browser debug");
    const observationsProvided = opts.observations !== undefined;
    const scan = observationsProvided
        ? { observations: opts.observations, source: "provided", errors: [] }
        : await scanPorts();
    const observations = scan.observations;
    // Canonicalize the owner so the dashboard's AGENT column shows only the
    // LLM provider name (claude / codex / gemini / ...), never invented
    // strings like "agent-random-1" or "codex-test-alpha". The agent's custom
    // suffix is preserved by auto-promoting it to sessionId when the caller
    // didn't pass one explicitly — that way information isn't lost; it just
    // lands in the right column.
    const canon = canonicalizeOwner(opts.owner);
    const ownerCanonical = canon.canonical;
    const explicitSession = typeof opts.sessionId === "string" && opts.sessionId.trim().length > 0;
    const sessionRaw = explicitSession ? opts.sessionId : canon.custom;
    const sessionId = sessionSlug(sessionRaw);
    const config = await loadConfig();
    let alreadyExisted = false;
    let result;
    let warning;
    let activeLaneCount;
    await updateRegistry((lanes) => {
        // Auto-promote any lane whose lastSeen is too old to "stale" before
        // making any decisions. Without this, an agent that crashed or was
        // killed without calling release_lane leaves a lane sitting in
        // status="active" forever, eating a slot in the cap. After this pass
        // those zombies are correctly labeled "stale" — they don't count
        // toward the cap and they don't show in the live view.
        const now = Date.now();
        lanes = lanes.map((lane) => {
            if (lane.status !== "released" && lane.status !== "stale" && isStale(lane, now)) {
                return { ...lane, status: "stale" };
            }
            return lane;
        });
        // Browser resolution, in priority order:
        //   1. explicit opts.browser — the agent (or the user's instruction to
        //      it) said which browser; always wins.
        //   2. an existing lane for this (owner, cwd, session) — a reconnecting
        //      caller keeps its lane's browser, whatever the default says.
        //   3. config.defaultBrowser — the dashboard's "Default browser" picker.
        //   4. "chrome".
        // The config value is user-edited JSON, so validate before trusting it.
        const cfgDefault = normalizeBrowserKind(config.defaultBrowser);
        let browser;
        let existing;
        if (opts.browser) {
            browser = opts.browser;
            existing = findExistingLane(lanes, ownerCanonical, opts.cwd, sessionId, browser);
        }
        else {
            // Prefer the configured default when several lanes exist for this key;
            // with no default configured, prefer chrome (the historical behaviour)
            // so pre-existing chrome lanes keep winning ambiguous reconnects.
            existing = findExistingLaneAnyBrowser(lanes, ownerCanonical, opts.cwd, sessionId, cfgDefault ?? "chrome");
            browser = existing ? laneBrowser(existing) : (cfgDefault ?? "chrome");
        }
        if (existing) {
            alreadyExisted = true;
            // Re-activate stale lanes when the caller comes back. Same profile
            // (logins survive); usually the same ports too — but a lane that went
            // stale may have had its port reclaimed by another lane in the
            // meantime, so top up whatever this call needs and is missing.
            const reactivatedStatus = existing.status === "stale" ? "active" : existing.status;
            let appPort = existing.appPort;
            let chromeDebugPort = existing.chromeDebugPort;
            const needApp = appPort === undefined && opts.withAppPort !== false;
            const needChrome = chromeDebugPort === undefined && opts.withChromePort !== false;
            if (needApp || needChrome) {
                const ctx = buildContext(observations, lanes);
                if (needApp) {
                    const appRange = validatePortRange(opts.appPortRange ?? config.appPortRange ?? DEFAULT_APP_PORT_RANGE, "app");
                    appPort = pickPort(appRange, new Set([...ctx.occupied, ...ctx.reservedAppPorts]));
                    if (appPort === undefined)
                        throw new Error(`No free app port in range ${appRange.start}-${appRange.end}`);
                }
                if (needChrome) {
                    const chromeRange = validatePortRange(opts.chromeDebugRange ?? config.chromeDebugRange ?? DEFAULT_CHROME_DEBUG_RANGE, "browser debug");
                    chromeDebugPort = pickPort(chromeRange, new Set([...ctx.occupied, ...ctx.reservedChromePorts]));
                    if (chromeDebugPort === undefined)
                        throw new Error(`No free Chrome debug port in range ${chromeRange.start}-${chromeRange.end}`);
                }
            }
            result = {
                ...existing,
                sessionId,
                lastSeen: nowIso(),
                status: reactivatedStatus,
                ...(appPort !== undefined ? { appPort } : {}),
                ...(chromeDebugPort !== undefined ? { chromeDebugPort } : {}),
            };
            const updated = lanes.map((l) => (l.id === existing.id ? result : l));
            // Whether the ports are retained or freshly minted, no stale lane may
            // keep claiming them — that's the two-lanes-one-port conflict.
            return stripReclaimedPorts(updated, existing.id, appPort, chromeDebugPort);
        }
        // Capacity check — released AND stale lanes are paperwork, not
        // contested resources. They don't block new reservations.
        const activeLanes = lanes.filter((l) => l.status !== "released" && l.status !== "stale");
        if (typeof config.maxActiveLanes === "number" && activeLanes.length >= config.maxActiveLanes) {
            throw new CapacityError(`MAX_ACTIVE_LANES_REACHED: ${activeLanes.length} active lanes >= cap of ${config.maxActiveLanes}. ` +
                `Release a lane (portpilot release ...) or raise maxActiveLanes in config.json.`, "MAX_ACTIVE_LANES_REACHED");
        }
        const ctx = buildContext(observations, lanes);
        const appRange = validatePortRange(opts.appPortRange ?? config.appPortRange ?? DEFAULT_APP_PORT_RANGE, "app");
        const chromeRange = validatePortRange(opts.chromeDebugRange ?? config.chromeDebugRange ?? DEFAULT_CHROME_DEBUG_RANGE, "browser debug");
        const wantApp = opts.withAppPort !== false;
        const wantChrome = opts.withChromePort !== false;
        const appTaken = new Set([...ctx.occupied, ...ctx.reservedAppPorts]);
        const chromeTaken = new Set([...ctx.occupied, ...ctx.reservedChromePorts]);
        const appPort = wantApp ? pickPort(appRange, appTaken) : undefined;
        const chromeDebugPort = wantChrome ? pickPort(chromeRange, chromeTaken) : undefined;
        if (wantApp && appPort === undefined) {
            throw new Error(`No free app port in range ${appRange.start}-${appRange.end}`);
        }
        if (wantChrome && chromeDebugPort === undefined) {
            throw new Error(`No free Chrome debug port in range ${chromeRange.start}-${chromeRange.end}`);
        }
        const profileDir = buildProfileDir(ownerCanonical, opts.cwd, sessionId, takenProfileDirs(lanes), opts.profileDir, browser);
        const lane = {
            id: opts.id ?? newLaneId(),
            owner: ownerCanonical,
            project: projectSlug(opts.cwd),
            cwd: normalizeCwd(opts.cwd),
            sessionId,
            task: opts.task,
            appPort,
            chromeDebugPort,
            chromeProfileDir: profileDir,
            // Only persisted for non-chrome lanes: keeps every pre-0.3.7 registry
            // byte-compatible and "absent = chrome" unambiguous.
            ...(browser !== "chrome" ? { browser } : {}),
            browserScript: opts.browserScript,
            status: opts.status ?? "reserved",
            createdAt: nowIso(),
            lastSeen: nowIso(),
            pid: process.pid,
            notes: opts.notes,
        };
        result = lane;
        activeLaneCount = activeLanes.length + 1;
        if (typeof config.warnAtActiveLanes === "number" &&
            activeLaneCount >= config.warnAtActiveLanes &&
            (typeof config.maxActiveLanes !== "number" || activeLaneCount < config.maxActiveLanes)) {
            warning = `Approaching capacity: ${activeLaneCount} active lanes (warn at ${config.warnAtActiveLanes}, max ${config.maxActiveLanes ?? "unlimited"}).`;
        }
        return [...stripReclaimedPorts(lanes, lane.id, appPort, chromeDebugPort), lane];
    });
    if (!result)
        throw new Error("Allocation failed: no lane returned");
    const out = { lane: result, alreadyExisted, scanSource: scan.source };
    if (warning)
        out.warning = warning;
    if (typeof activeLaneCount === "number")
        out.activeLaneCount = activeLaneCount;
    return out;
}
export async function findFreePort(opts = {}) {
    const range = validatePortRange(opts.range ?? DEFAULT_CHROME_DEBUG_RANGE, "network");
    const observations = opts.observations ?? (await scanPorts()).observations;
    const lanes = await listLanes();
    const ctx = buildContext(observations, lanes);
    const taken = new Set([...ctx.occupied, ...ctx.reservedChromePorts, ...ctx.reservedAppPorts]);
    return pickPort(range, taken);
}
/**
 * Check whether a lane is safe to use right now. This is what an agent should
 * call before attaching its browser automation script. The return value is
 * structured for both human and agent consumption.
 */
export async function checkLane(lane) {
    const scan = await scanPorts();
    // Routed by the lane's browser: Firefox lanes are judged against Firefox
    // processes + -profile args, never mistaken for (or matched to) Chrome CDP.
    const verdict = evaluateBrowserAttach(lane, scan.observations);
    const appPortInUse = typeof lane.appPort === "number" ? isPortInUse(scan.observations, lane.appPort) : false;
    const appPortObservation = typeof lane.appPort === "number"
        ? scan.observations.find((o) => o.port === lane.appPort)
        : undefined;
    return {
        lane,
        verdict,
        appPortInUse,
        appPortObservation,
        scanSource: scan.source,
        scanErrors: scan.errors,
    };
}
