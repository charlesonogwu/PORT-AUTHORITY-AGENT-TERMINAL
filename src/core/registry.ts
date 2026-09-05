import { readFile } from "node:fs/promises";
import {
  Lane,
  LaneStatus,
  REGISTRY_VERSION,
  RegistryFile,
  isStale,
  laneSessionId,
  canonicalizeOwner,
  normalizeCwd,
  nowIso,
  laneBrowser,
} from "./lane.js";
import { lockPath, registryPath } from "./paths.js";
import { atomicWriteJson, withLock } from "./lockfile.js";

const EMPTY: RegistryFile = { version: REGISTRY_VERSION, lanes: [] };

async function readRegistryRaw(): Promise<RegistryFile> {
  try {
    const raw = await readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RegistryFile>;
    if (!parsed || parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.lanes)) {
      return { version: REGISTRY_VERSION, lanes: [] };
    }
    return { version: REGISTRY_VERSION, lanes: parsed.lanes };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    throw err;
  }
}

export async function readRegistry(): Promise<RegistryFile> {
  return readRegistryRaw();
}

export async function listLanes(): Promise<Lane[]> {
  const reg = await readRegistry();
  return reg.lanes;
}

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
  purpose?: string;
}

export function normalizeProfilePurpose(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function filterLanes(lanes: Lane[], filter: LaneFilter): Lane[] {
  const wantStatuses = Array.isArray(filter.status)
    ? filter.status
    : filter.status
    ? [filter.status]
    : null;
  const cwd = filter.cwd ? normalizeCwd(filter.cwd) : null;
  const wantSession = typeof filter.sessionId === "string" ? filter.sessionId : null;
  const owner = filter.owner ? canonicalizeOwner(filter.owner).canonical : null;
  return lanes.filter((lane) => {
    if (owner && canonicalizeOwner(lane.owner).canonical !== owner) return false;
    if (cwd && normalizeCwd(lane.cwd) !== cwd) return false;
    if (wantSession !== null && laneSessionId(lane) !== wantSession) return false;
    if (filter.browser && laneBrowser(lane) !== filter.browser) return false;
    if (filter.purpose) {
      const purpose = normalizeProfilePurpose(filter.purpose);
      if (!purpose || !(lane.profilePurposes ?? []).some((item) => normalizeProfilePurpose(item) === purpose)) return false;
    }
    if (wantStatuses && !wantStatuses.includes(lane.status)) return false;
    if (!filter.includeReleased && !wantStatuses && lane.status === "released") return false;
    return true;
  });
}

export async function rememberLaneProfile(
  laneId: string,
  input: { label?: string; purposes?: string[] },
): Promise<Lane | undefined> {
  let updated: Lane | undefined;
  const label = input.label?.trim().slice(0, 80);
  const purposes = [...new Set((input.purposes ?? []).map(normalizeProfilePurpose).filter(Boolean))].sort();
  await updateRegistry((lanes) => lanes.map((lane) => {
    if (lane.id !== laneId) return lane;
    updated = {
      ...lane,
      ...(label ? { profileLabel: label } : {}),
      ...(purposes.length ? { profilePurposes: purposes } : {}),
      lastSeen: nowIso(),
    };
    return updated;
  }));
  return updated;
}

export async function findLane(filter: LaneFilter): Promise<Lane | undefined> {
  const lanes = await listLanes();
  return filterLanes(lanes, filter)[0];
}

export interface LaneSelector extends LaneFilter {
  /** Immutable PortPilot lane identity (called PPID in user-facing flows). */
  laneId?: string;
}

export class AmbiguousLaneError extends Error {
  readonly candidateIds: string[];
  readonly candidates: Array<{ id: string; profileDir: string }>;

  constructor(candidates: Lane[]) {
    const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
    const details = ordered.map((lane) => `${lane.id} (${lane.chromeProfileDir})`).join(", ");
    super(`ambiguous lane selector; use --lane-id with one of: ${details}`);
    this.name = "AmbiguousLaneError";
    this.candidateIds = ordered.map((lane) => lane.id);
    this.candidates = ordered.map((lane) => ({ id: lane.id, profileDir: lane.chromeProfileDir }));
  }
}

function stableLaneOrder(a: Lane, b: Lane): number {
  const created = a.createdAt.localeCompare(b.createdAt);
  return created !== 0 ? created : a.id.localeCompare(b.id);
}

/**
 * Resolve either one immutable lane id or the legacy owner/cwd/session tuple.
 * Tuple lookup never guesses across distinct browser-profile identities.
 */
export function resolveLaneSelectorFrom(lanes: Lane[], selector: LaneSelector): Lane | undefined {
  if (selector.laneId) {
    const exact = lanes.find((lane) => lane.id === selector.laneId);
    if (!exact) return undefined;
    if (!selector.includeReleased && exact.status === "released") return undefined;
    return exact;
  }

  const matches = filterLanes(lanes, selector);
  if (matches.length <= 1) return matches[0];
  const identities = new Set(
    matches.map((lane) => `${laneBrowser(lane)}\0${normalizeCwd(lane.chromeProfileDir)}`),
  );
  if (identities.size > 1) throw new AmbiguousLaneError(matches);
  return [...matches].sort(stableLaneOrder)[0];
}

export async function resolveLaneSelector(selector: LaneSelector): Promise<Lane | undefined> {
  return resolveLaneSelectorFrom(await listLanes(), selector);
}

export type RegistryUpdater = (lanes: Lane[]) => Lane[] | Promise<Lane[]>;

/**
 * Read-modify-write the registry while holding the lockfile. The updater
 * receives a defensive copy of the lanes array and must return the next
 * lanes array.
 */
export async function updateRegistry(updater: RegistryUpdater): Promise<Lane[]> {
  return withLock(lockPath(), async () => {
    const reg = await readRegistryRaw();
    const next = await updater(reg.lanes.map((l) => ({ ...l })));
    const file: RegistryFile = { version: REGISTRY_VERSION, lanes: next };
    await atomicWriteJson(registryPath(), file);
    return next;
  });
}

export async function upsertLane(lane: Lane): Promise<Lane> {
  await updateRegistry((lanes) => {
    const idx = lanes.findIndex((l) => l.id === lane.id);
    if (idx === -1) lanes.push(lane);
    else lanes[idx] = lane;
    return lanes;
  });
  return lane;
}

export async function removeLane(id: string): Promise<boolean> {
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

export async function markStaleLanes(now: number = Date.now()): Promise<number> {
  // Read-only pre-check: avoid acquiring the lock + rewriting the file
  // when there's nothing to flip. The dashboard calls this every ~2 seconds
  // so the no-op path needs to be cheap.
  const reg = await readRegistry();
  const needsWork = reg.lanes.some(
    (l) => l.status !== "released" && l.status !== "stale" && isStale(l, now),
  );
  if (!needsWork) return 0;

  let count = 0;
  await updateRegistry((lanes) => {
    return lanes.map((lane) => {
      if (lane.status !== "released" && lane.status !== "stale" && isStale(lane, now)) {
        count++;
        return { ...lane, status: "stale" as LaneStatus };
      }
      return lane;
    });
  });
  return count;
}

export async function touchLane(id: string): Promise<Lane | undefined> {
  let updated: Lane | undefined;
  await updateRegistry((lanes) => {
    return lanes.map((lane) => {
      if (lane.id !== id) return lane;
      updated = { ...lane, lastSeen: nowIso() };
      return updated;
    });
  });
  return updated;
}

export async function setLaneStatus(id: string, status: LaneStatus): Promise<Lane | undefined> {
  let updated: Lane | undefined;
  await updateRegistry((lanes) => {
    return lanes.map((lane) => {
      if (lane.id !== id) return lane;
      updated = { ...lane, status, lastSeen: nowIso() };
      return updated;
    });
  });
  return updated;
}

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
export async function pruneReleasedLanes(opts: PruneOptions = {}): Promise<PruneResult> {
  const cutoff = opts.all ? Number.POSITIVE_INFINITY : (opts.olderThanMs ?? DEFAULT_PRUNE_AGE_MS);
  const now = Date.now();

  const isCandidate = (lane: Lane): boolean => {
    if (lane.status !== "released") return false;
    if (opts.all) return true;
    const last = Date.parse(lane.lastSeen);
    if (!Number.isFinite(last)) return true; // unparseable timestamp → consider stale
    return now - last > cutoff;
  };

  if (opts.dryRun) {
    const lanes = await listLanes();
    return { candidates: lanes.filter(isCandidate), pruned: [] };
  }

  const candidates: Lane[] = [];
  const pruned: Lane[] = [];
  await updateRegistry((lanes) => {
    const next: Lane[] = [];
    for (const lane of lanes) {
      if (isCandidate(lane)) {
        candidates.push(lane);
        pruned.push(lane);
      } else {
        next.push(lane);
      }
    }
    return next;
  });
  return { candidates, pruned };
}
