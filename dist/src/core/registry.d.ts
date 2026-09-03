import { Lane, LaneStatus, RegistryFile } from "./lane.js";
export declare function readRegistry(): Promise<RegistryFile>;
export declare function listLanes(): Promise<Lane[]>;
export interface LaneFilter {
    owner?: string;
    cwd?: string;
    /**
     * Optional session id filter. If omitted, lanes from any session match.
     * If supplied (including the literal "default"), only lanes with that
     * exact session id match.
     */
    sessionId?: string;
    status?: LaneStatus | LaneStatus[];
    includeReleased?: boolean;
    browser?: import("./lane.js").BrowserKind;
}
export declare function filterLanes(lanes: Lane[], filter: LaneFilter): Lane[];
export declare function findLane(filter: LaneFilter): Promise<Lane | undefined>;
export interface LaneSelector extends LaneFilter {
    /** Immutable PortPilot lane identity (called PPID in user-facing flows). */
    laneId?: string;
}
export declare class AmbiguousLaneError extends Error {
    readonly candidateIds: string[];
    readonly candidates: Array<{
        id: string;
        profileDir: string;
    }>;
    constructor(candidates: Lane[]);
}
/**
 * Resolve either one immutable lane id or the legacy owner/cwd/session tuple.
 * Tuple lookup never guesses across distinct browser-profile identities.
 */
export declare function resolveLaneSelectorFrom(lanes: Lane[], selector: LaneSelector): Lane | undefined;
export declare function resolveLaneSelector(selector: LaneSelector): Promise<Lane | undefined>;
export type RegistryUpdater = (lanes: Lane[]) => Lane[] | Promise<Lane[]>;
/**
 * Read-modify-write the registry while holding the lockfile. The updater
 * receives a defensive copy of the lanes array and must return the next
 * lanes array.
 */
export declare function updateRegistry(updater: RegistryUpdater): Promise<Lane[]>;
export declare function upsertLane(lane: Lane): Promise<Lane>;
export declare function removeLane(id: string): Promise<boolean>;
export declare function markStaleLanes(now?: number): Promise<number>;
export declare function touchLane(id: string): Promise<Lane | undefined>;
export declare function setLaneStatus(id: string, status: LaneStatus): Promise<Lane | undefined>;
export interface PruneOptions {
    /** Only prune released lanes whose lastSeen is older than this many ms.
     *  Default 24 hours. Ignored when `all` is true. */
    olderThanMs?: number;
    /** Prune all released lanes regardless of age. */
    all?: boolean;
    /** Compute the candidate list without writing to the registry. */
    dryRun?: boolean;
}
export interface PruneResult {
    /** Lanes that match the prune criteria. With dryRun, this is the set
     *  that would have been removed; otherwise this equals `pruned`. */
    candidates: Lane[];
    /** Lanes actually removed from the registry. Empty when dryRun. */
    pruned: Lane[];
}
export declare const DEFAULT_PRUNE_AGE_MS: number;
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
export declare function pruneReleasedLanes(opts?: PruneOptions): Promise<PruneResult>;
