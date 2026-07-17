import { access, lstat, realpath, readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isStale, normalizeCwd } from "./lane.js";
import { profilesDir } from "./paths.js";
import { listLanes, removeLane } from "./registry.js";
function samePath(a, b) {
    return normalizeCwd(a).toLowerCase() === normalizeCwd(b).toLowerCase();
}
const ALIVE_PRIORITY = {
    active: 0,
    reserved: 1,
    stale: 2,
    released: 3,
    orphaned: 4,
};
/** The status the dashboard/doctor would show after marking stale lanes: a
 *  lane stored "active"/"reserved" but not seen within the stale window reads
 *  as "stale". Released stays released. */
function effectiveStatus(lane, now) {
    if (lane.status === "released")
        return "released";
    if (isStale(lane, now))
        return "stale";
    return lane.status;
}
/**
 * Classify a single on-disk profile path against the registry's lanes. Pure
 * (no IO) so it is easy to test. When several lanes share a profile dir
 * (rare / legacy data), the most-alive one wins.
 */
export function classifyProfile(profilePath, lanes, now = Date.now()) {
    const matching = lanes.filter((l) => l.chromeProfileDir && samePath(l.chromeProfileDir, profilePath));
    if (matching.length === 0)
        return { status: "orphaned" };
    const ranked = matching
        .map((l) => ({ lane: l, status: effectiveStatus(l, now) }))
        .sort((a, b) => ALIVE_PRIORITY[a.status] - ALIVE_PRIORITY[b.status]);
    const top = ranked[0];
    return { lane: top.lane, status: top.status, lastSeen: top.lane.lastSeen };
}
/**
 * Recursively sum file sizes under `dir`. Resilient to locked / vanishing
 * files and never follows symlinks or junctions (only real subdirectories
 * recurse), so it can never wander out of the folder it was handed.
 */
export async function dirSizeBytes(dir) {
    let total = 0;
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            total += await dirSizeBytes(p);
        }
        else if (e.isFile()) {
            try {
                total += (await stat(p)).size;
            }
            catch {
                /* locked or removed mid-walk — skip */
            }
        }
    }
    return total;
}
/**
 * Inventory every Chrome profile folder PortPilot has created, classified
 * against the current lane registry and sized on disk. Read-only.
 */
export async function listProfiles(now = Date.now()) {
    const root = profilesDir();
    let dirents;
    try {
        dirents = await readdir(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const lanes = await listLanes();
    const dirs = dirents.filter((d) => d.isDirectory());
    const entries = await Promise.all(dirs.map(async (d) => {
        const path = join(root, d.name);
        const cls = classifyProfile(path, lanes, now);
        const sizeBytes = await dirSizeBytes(path);
        return {
            name: d.name,
            path,
            sizeBytes,
            status: cls.status,
            ...(cls.lane ? { lane: cls.lane } : {}),
            ...(cls.lastSeen ? { lastSeen: cls.lastSeen } : {}),
        };
    }));
    return entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function matchesAnyName(name, patterns) {
    return patterns.some((pat) => {
        if (pat === name)
            return true;
        if (!pat.includes("*"))
            return false;
        const re = new RegExp("^" + pat.split("*").map(escapeRegex).join(".*") + "$", "i");
        return re.test(name);
    });
}
/** Rooms an agent is using right now — NEVER eligible for pruning. */
const PROTECTED = new Set(["active", "reserved"]);
/**
 * Select which profiles a prune would remove. ALWAYS excludes active/reserved
 * profiles. Pure (no IO) so the policy is fully unit-tested.
 *
 * - With `names`: target exactly those (still never active/reserved).
 * - Otherwise: include the status buckets that are switched on, optionally
 *   gated by `olderThanMs`.
 */
export function selectPruneCandidates(profiles, opts, now = Date.now()) {
    const byName = !!(opts.names && opts.names.length > 0);
    return profiles.filter((p) => {
        if (PROTECTED.has(p.status))
            return false; // never touch live rooms
        if (byName)
            return matchesAnyName(p.name, opts.names);
        const statusIncluded = (p.status === "orphaned" && opts.includeOrphaned) ||
            (p.status === "released" && opts.includeReleased) ||
            (p.status === "stale" && opts.includeStale);
        if (!statusIncluded)
            return false;
        if (opts.olderThanMs !== undefined) {
            const last = p.lastSeen ? Date.parse(p.lastSeen) : NaN;
            // Profiles with no timestamp (orphaned) are treated as old enough.
            if (Number.isFinite(last) && now - last <= opts.olderThanMs)
                return false;
        }
        return true;
    });
}
/**
 * Guard: refuse to operate on any path that is not strictly inside the
 * PortPilot profiles directory. This is the hard boundary that keeps the
 * cleaner away from the user's real Chrome profile and everything else on disk.
 */
export function assertWithinProfilesRoot(target) {
    const root = resolve(profilesDir());
    const t = resolve(target);
    if (t === root) {
        throw new Error(`refusing to delete the profiles root itself: ${t}`);
    }
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (!t.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
        throw new Error(`refusing to delete a path outside ${root}: ${t}`);
    }
}
/** Filesystem-aware deletion guard. It rejects a symlink target and resolves
 * every parent component before proving the profile remains under the active
 * PortPilot profiles root. */
export async function assertSafeProfileDeletion(target) {
    assertWithinProfilesRoot(target);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
        throw new Error(`refusing to delete a symbolic-link profile: ${target}`);
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
        realpath(profilesDir()),
        realpath(target),
    ]);
    const rootWithSep = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
    if (!canonicalTarget.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
        throw new Error(`refusing to delete a profile that resolves outside ${canonicalRoot}`);
    }
}
/** Delete one profile directory, after verifying it is inside the profiles
 *  root. The guard makes it impossible to remove anything outside
 *  ~/.portpilot/profiles. */
export async function deleteProfileDir(path) {
    await assertSafeProfileDeletion(path);
    await rm(path, { recursive: true, force: true });
}
/**
 * Cheap check: does this profile already hold a real browser session — a
 * cookie store, a localStorage DB, or saved credentials? Used by the dashboard
 * to show a "saved data" marker per row WITHOUT walking the whole (possibly
 * multi-GB) profile on every 2-second poll. A few `access()` calls, no walk.
 */
export async function profileHasSavedData(profileDir) {
    const markers = [
        join(profileDir, "Default", "Network", "Cookies"),
        join(profileDir, "Default", "Local Storage", "leveldb"),
        join(profileDir, "Default", "Login Data"),
    ];
    for (const m of markers) {
        try {
            await access(m);
            return true;
        }
        catch {
            /* not present — try the next marker */
        }
    }
    return false;
}
/**
 * "Forget" a lane's saved browser data: delete its profile directory (guarded
 * to ~/.portpilot/profiles) and drop the lane from the registry so its
 * dashboard row disappears and its ports free up.
 *
 * The caller MUST have already closed the Chrome that owns the profile — a
 * running Chrome holds file locks and the delete will throw (which is the safe
 * outcome: the lane is left intact so the user can retry). The profile is
 * deleted first; the lane is only dropped once the delete succeeds.
 */
export async function forgetProfile(opts) {
    await deleteProfileDir(opts.profileDir);
    let removedLane = false;
    if (opts.laneId)
        removedLane = await removeLane(opts.laneId);
    return { removedProfile: true, removedLane };
}
