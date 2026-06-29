import { Lane, LaneStatus } from "./lane.js";
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
/**
 * Classify a single on-disk profile path against the registry's lanes. Pure
 * (no IO) so it is easy to test. When several lanes share a profile dir
 * (rare / legacy data), the most-alive one wins.
 */
export declare function classifyProfile(profilePath: string, lanes: Lane[], now?: number): {
    lane?: Lane;
    status: ProfileStatus;
    lastSeen?: string;
};
/**
 * Recursively sum file sizes under `dir`. Resilient to locked / vanishing
 * files and never follows symlinks or junctions (only real subdirectories
 * recurse), so it can never wander out of the folder it was handed.
 */
export declare function dirSizeBytes(dir: string): Promise<number>;
/**
 * Inventory every Chrome profile folder PortPilot has created, classified
 * against the current lane registry and sized on disk. Read-only.
 */
export declare function listProfiles(now?: number): Promise<ProfileEntry[]>;
export interface ProfilePruneOptions {
    includeOrphaned?: boolean;
    includeReleased?: boolean;
    includeStale?: boolean;
    /** Only include profiles whose lane lastSeen is older than this many ms. */
    olderThanMs?: number;
    /** Restrict to profiles whose name matches one of these (exact or glob). */
    names?: string[];
}
/**
 * Select which profiles a prune would remove. ALWAYS excludes active/reserved
 * profiles. Pure (no IO) so the policy is fully unit-tested.
 *
 * - With `names`: target exactly those (still never active/reserved).
 * - Otherwise: include the status buckets that are switched on, optionally
 *   gated by `olderThanMs`.
 */
export declare function selectPruneCandidates(profiles: ProfileEntry[], opts: ProfilePruneOptions, now?: number): ProfileEntry[];
/**
 * Guard: refuse to operate on any path that is not strictly inside the
 * PortPilot profiles directory. This is the hard boundary that keeps the
 * cleaner away from the user's real Chrome profile and everything else on disk.
 */
export declare function assertWithinProfilesRoot(target: string): void;
/** Delete one profile directory, after verifying it is inside the profiles
 *  root. The guard makes it impossible to remove anything outside
 *  ~/.portpilot/profiles. */
export declare function deleteProfileDir(path: string): Promise<void>;
