import { access, readdir, rm, stat, rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isStale, normalizeCwd } from "./lane.js";
import { profilesDir, lockPath } from "./paths.js";
import { withLock } from "./lockfile.js";
import { listLanes, updateRegistry } from "./registry.js";
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
            hasSavedLogins: lanes.some(l => samePath(l.chromeProfileDir, path) && !!l.savedLogins?.length),
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
        if (p.path.endsWith(".portpilot-deleting"))
            return false;
        if (PROTECTED.has(p.status))
            return false; // never touch live rooms
        if (p.hasSavedLogins || p.lane?.savedLogins?.length)
            return false; // all associations protect a shared profile
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
/** Delete one profile directory, after verifying it is inside the profiles
 *  root. The guard makes it impossible to remove anything outside
 *  ~/.portpilot/profiles. */
export async function deleteProfileDir(path) {
    return deleteProfile(path, false);
}
async function deleteProfile(path, explicitErase) {
    assertWithinProfilesRoot(path);
    if (path.endsWith(".portpilot-deleting"))
        throw new Error("profile deletion pending; refusing cleanup of in-progress data");
    const tombstone = `${resolve(path)}.portpilot-deleting`;
    assertWithinProfilesRoot(tombstone);
    let moved = false;
    // Confirmation holds this same lock while verifying the profile. Moving the
    // directory under the lock makes subsequent confirmations fail closed, while
    // slow recursive deletion happens outside the expiring registry lock lease.
    await withLock(lockPath(), async () => {
        let pending = false;
        try {
            await access(tombstone);
            pending = true;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (pending)
            throw new Error("profile deletion already in progress; saved login records preserved");
        if (!explicitErase && (await listLanes()).some(l => samePath(l.chromeProfileDir, path) && l.savedLogins?.length)) {
            throw new Error("profile has saved login records; use explicit Erase");
        }
        try {
            await rename(path, tombstone);
            moved = true;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    });
    if (!moved)
        return;
    try {
        await rm(tombstone, { recursive: true, force: true });
    }
    catch (error) {
        // Preserve the original identity when deletion fails; never overwrite a
        // replacement directory created meanwhile.
        await withLock(lockPath(), async () => {
            try {
                await access(path);
            }
            catch (missing) {
                if (missing.code === "ENOENT")
                    await rename(tombstone, path);
            }
        });
        throw error;
    }
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
    let removedLane = false;
    const selected = opts.laneId ? (await listLanes()).find(l => l.id === opts.laneId) : undefined;
    if (opts.laneId && !selected)
        throw new Error("unknown immutable PPID; refusing Erase");
    if (selected && !samePath(selected.chromeProfileDir, opts.profileDir))
        throw new Error("PPID does not match profile to erase");
    // Recursive deletion may outlast the registry lock lease. Read fresh state
    // under the lock only after successful deletion, preserving concurrent writes.
    await deleteProfile(opts.profileDir, true);
    await updateRegistry(lanes => {
        return lanes.filter(l => {
            if (!samePath(l.chromeProfileDir, opts.profileDir))
                return true;
            removedLane = true;
            return false;
        });
    });
    return { removedProfile: true, removedLane };
}
