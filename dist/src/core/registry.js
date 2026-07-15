import { readFile } from "node:fs/promises";
import { REGISTRY_VERSION, isStale, laneSessionId, canonicalizeOwner, normalizeCwd, nowIso, } from "./lane.js";
import { lockPath, registryPath } from "./paths.js";
import { atomicWriteJson, withLock } from "./lockfile.js";
const EMPTY = { version: REGISTRY_VERSION, lanes: [] };
async function readRegistryRaw() {
    try {
        const raw = await readFile(registryPath(), "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.lanes)) {
            return { version: REGISTRY_VERSION, lanes: [] };
        }
        return { version: REGISTRY_VERSION, lanes: parsed.lanes };
    }
    catch (err) {
        if (err.code === "ENOENT")
            return { ...EMPTY };
        throw err;
    }
}
export async function readRegistry() {
    return readRegistryRaw();
}
export async function listLanes() {
    const reg = await readRegistry();
    return reg.lanes;
}
export function filterLanes(lanes, filter) {
    const wantStatuses = Array.isArray(filter.status)
        ? filter.status
        : filter.status
            ? [filter.status]
            : null;
    const cwd = filter.cwd ? normalizeCwd(filter.cwd) : null;
    const wantSession = typeof filter.sessionId === "string" ? filter.sessionId : null;
    const owner = filter.owner ? canonicalizeOwner(filter.owner).canonical : null;
    return lanes.filter((lane) => {
        if (owner && canonicalizeOwner(lane.owner).canonical !== owner)
            return false;
        if (cwd && normalizeCwd(lane.cwd) !== cwd)
            return false;
        if (wantSession !== null && laneSessionId(lane) !== wantSession)
            return false;
        if (wantStatuses && !wantStatuses.includes(lane.status))
            return false;
        if (!filter.includeReleased && !wantStatuses && lane.status === "released")
            return false;
        return true;
    });
}
export async function findLane(filter) {
    const lanes = await listLanes();
    return filterLanes(lanes, filter)[0];
}
/**
 * Read-modify-write the registry while holding the lockfile. The updater
 * receives a defensive copy of the lanes array and must return the next
 * lanes array.
 */
export async function updateRegistry(updater) {
    return withLock(lockPath(), async () => {
        const reg = await readRegistryRaw();
        const next = await updater(reg.lanes.map((l) => ({ ...l })));
        const file = { version: REGISTRY_VERSION, lanes: next };
        await atomicWriteJson(registryPath(), file);
        return next;
    });
}
export async function upsertLane(lane) {
    await updateRegistry((lanes) => {
        const idx = lanes.findIndex((l) => l.id === lane.id);
        if (idx === -1)
            lanes.push(lane);
        else
            lanes[idx] = lane;
        return lanes;
    });
    return lane;
}
export async function removeLane(id) {
    let removed = false;
    await updateRegistry((lanes) => {
        const next = lanes.filter((l) => {
            if (l.id === id) {
                removed = true;
                return false;
            }
            return true;
        });
        return next;
    });
    return removed;
}
export async function markStaleLanes(now = Date.now()) {
    // Read-only pre-check: avoid acquiring the lock + rewriting the file
    // when there's nothing to flip. The dashboard calls this every ~2 seconds
    // so the no-op path needs to be cheap.
    const reg = await readRegistry();
    const needsWork = reg.lanes.some((l) => l.status !== "released" && l.status !== "stale" && isStale(l, now));
    if (!needsWork)
        return 0;
    let count = 0;
    await updateRegistry((lanes) => {
        return lanes.map((lane) => {
            if (lane.status !== "released" && lane.status !== "stale" && isStale(lane, now)) {
                count++;
                return { ...lane, status: "stale" };
            }
            return lane;
        });
    });
    return count;
}
export async function touchLane(id) {
    let updated;
    await updateRegistry((lanes) => {
        return lanes.map((lane) => {
            if (lane.id !== id)
                return lane;
            updated = { ...lane, lastSeen: nowIso() };
            return updated;
        });
    });
    return updated;
}
export async function setLaneStatus(id, status) {
    let updated;
    await updateRegistry((lanes) => {
        return lanes.map((lane) => {
            if (lane.id !== id)
                return lane;
            updated = { ...lane, status, lastSeen: nowIso() };
            return updated;
        });
    });
    return updated;
}
export const DEFAULT_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Garbage-collect released lanes from the registry.
 *
 * Default behaviour: removes released lanes whose lastSeen is older than 24h.
 * Pass `all: true` to remove every released lane regardless of age.
 * Pass `dryRun: true` to preview without writing.
 *
 * Never touches non-released lanes. Active / reserved / stale lanes are
 * always preserved — pruning is strictly historical cleanup.
 */
export async function pruneReleasedLanes(opts = {}) {
    const cutoff = opts.all ? Number.POSITIVE_INFINITY : (opts.olderThanMs ?? DEFAULT_PRUNE_AGE_MS);
    const now = Date.now();
    const isCandidate = (lane) => {
        if (lane.status !== "released")
            return false;
        if (opts.all)
            return true;
        const last = Date.parse(lane.lastSeen);
        if (!Number.isFinite(last))
            return true; // unparseable timestamp → consider stale
        return now - last > cutoff;
    };
    if (opts.dryRun) {
        const lanes = await listLanes();
        return { candidates: lanes.filter(isCandidate), pruned: [] };
    }
    const candidates = [];
    const pruned = [];
    await updateRegistry((lanes) => {
        const next = [];
        for (const lane of lanes) {
            if (isCandidate(lane)) {
                candidates.push(lane);
                pruned.push(lane);
            }
            else {
                next.push(lane);
            }
        }
        return next;
    });
    return { candidates, pruned };
}
