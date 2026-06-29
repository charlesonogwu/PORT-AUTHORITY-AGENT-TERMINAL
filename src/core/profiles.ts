import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Lane, LaneStatus, isStale, normalizeCwd } from "./lane.js";
import { profilesDir } from "./paths.js";
import { listLanes } from "./registry.js";

/**
 * Lifecycle tooling for the per-lane Chrome profiles PortPilot stores under
 * ~/.portpilot/profiles. Every lane gets a dedicated `--user-data-dir`; those
 * folders persist logins across sessions but are never reclaimed, so they pile
 * up. This module inventories them, classifies each against the lane registry,
 * and prunes — always strictly inside the profiles root, never the user's real
 * Chrome, never active/reserved lanes.
 */

/** Effective status of a profile folder relative to the lane registry. */
export type ProfileStatus = LaneStatus | "orphaned";

export interface ProfileEntry {
  /** Directory basename, e.g. "codex-mattress-hunting". */
  name: string;
  /** Absolute path to the profile directory. */
  path: string;
  /** Total size on disk in bytes. */
  sizeBytes: number;
  /** The lane that owns this profile, if any is still in the registry. */
  lane?: Lane;
  /** Effective status: the owning lane's status (with time-staleness applied),
   *  or "orphaned" when no lane references the folder. */
  status: ProfileStatus;
  /** lastSeen of the owning lane, if any. */
  lastSeen?: string;
}

function samePath(a: string, b: string): boolean {
  return normalizeCwd(a).toLowerCase() === normalizeCwd(b).toLowerCase();
}

const ALIVE_PRIORITY: Record<ProfileStatus, number> = {
  active: 0,
  reserved: 1,
  stale: 2,
  released: 3,
  orphaned: 4,
};

/** The status the dashboard/doctor would show after marking stale lanes: a
 *  lane stored "active"/"reserved" but not seen within the stale window reads
 *  as "stale". Released stays released. */
function effectiveStatus(lane: Lane, now: number): LaneStatus {
  if (lane.status === "released") return "released";
  if (isStale(lane, now)) return "stale";
  return lane.status;
}

/**
 * Classify a single on-disk profile path against the registry's lanes. Pure
 * (no IO) so it is easy to test. When several lanes share a profile dir
 * (rare / legacy data), the most-alive one wins.
 */
export function classifyProfile(
  profilePath: string,
  lanes: Lane[],
  now: number = Date.now(),
): { lane?: Lane; status: ProfileStatus; lastSeen?: string } {
  const matching = lanes.filter((l) => l.chromeProfileDir && samePath(l.chromeProfileDir, profilePath));
  if (matching.length === 0) return { status: "orphaned" };
  const ranked = matching
    .map((l) => ({ lane: l, status: effectiveStatus(l, now) as ProfileStatus }))
    .sort((a, b) => ALIVE_PRIORITY[a.status] - ALIVE_PRIORITY[b.status]);
  const top = ranked[0]!;
  return { lane: top.lane, status: top.status, lastSeen: top.lane.lastSeen };
}

/**
 * Recursively sum file sizes under `dir`. Resilient to locked / vanishing
 * files and never follows symlinks or junctions (only real subdirectories
 * recurse), so it can never wander out of the folder it was handed.
 */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSizeBytes(p);
    } else if (e.isFile()) {
      try {
        total += (await stat(p)).size;
      } catch {
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
export async function listProfiles(now: number = Date.now()): Promise<ProfileEntry[]> {
  const root = profilesDir();
  let dirents: Dirent<string>[];
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const lanes = await listLanes();
  const dirs = dirents.filter((d) => d.isDirectory());
  const entries = await Promise.all(
    dirs.map(async (d): Promise<ProfileEntry> => {
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
    }),
  );
  return entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export interface ProfilePruneOptions {
  includeOrphaned?: boolean;
  includeReleased?: boolean;
  includeStale?: boolean;
  /** Only include profiles whose lane lastSeen is older than this many ms. */
  olderThanMs?: number;
  /** Restrict to profiles whose name matches one of these (exact or glob). */
  names?: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAnyName(name: string, patterns: string[]): boolean {
  return patterns.some((pat) => {
    if (pat === name) return true;
    if (!pat.includes("*")) return false;
    const re = new RegExp("^" + pat.split("*").map(escapeRegex).join(".*") + "$", "i");
    return re.test(name);
  });
}

/** Rooms an agent is using right now — NEVER eligible for pruning. */
const PROTECTED: ReadonlySet<ProfileStatus> = new Set<ProfileStatus>(["active", "reserved"]);

/**
 * Select which profiles a prune would remove. ALWAYS excludes active/reserved
 * profiles. Pure (no IO) so the policy is fully unit-tested.
 *
 * - With `names`: target exactly those (still never active/reserved).
 * - Otherwise: include the status buckets that are switched on, optionally
 *   gated by `olderThanMs`.
 */
export function selectPruneCandidates(
  profiles: ProfileEntry[],
  opts: ProfilePruneOptions,
  now: number = Date.now(),
): ProfileEntry[] {
  const byName = !!(opts.names && opts.names.length > 0);
  return profiles.filter((p) => {
    if (PROTECTED.has(p.status)) return false; // never touch live rooms
    if (byName) return matchesAnyName(p.name, opts.names!);
    const statusIncluded =
      (p.status === "orphaned" && opts.includeOrphaned) ||
      (p.status === "released" && opts.includeReleased) ||
      (p.status === "stale" && opts.includeStale);
    if (!statusIncluded) return false;
    if (opts.olderThanMs !== undefined) {
      const last = p.lastSeen ? Date.parse(p.lastSeen) : NaN;
      // Profiles with no timestamp (orphaned) are treated as old enough.
      if (Number.isFinite(last) && now - last <= opts.olderThanMs) return false;
    }
    return true;
  });
}

/**
 * Guard: refuse to operate on any path that is not strictly inside the
 * PortPilot profiles directory. This is the hard boundary that keeps the
 * cleaner away from the user's real Chrome profile and everything else on disk.
 */
export function assertWithinProfilesRoot(target: string): void {
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
export async function deleteProfileDir(path: string): Promise<void> {
  assertWithinProfilesRoot(path);
  await rm(path, { recursive: true, force: true });
}
