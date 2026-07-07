import {
  BrowserKind,
  laneBrowser,
  DEFAULT_APP_PORT_RANGE,
  DEFAULT_CHROME_DEBUG_RANGE,
  DEFAULT_SESSION_ID,
  Lane,
  LaneStatus,
  PortRange,
  canonicalizeOwner,
  isStale,
  laneSessionId,
  newLaneId,
  normalizeCwd,
  nowIso,
  ownerSlug,
  projectSlug,
  sessionSlug,
} from "./lane.js";
import { profileDirFor } from "./paths.js";
import { PortObservation, isPortInUse, scanPorts } from "./scanner.js";
import { ChromeAttachVerdict } from "./chrome.js";
import { evaluateBrowserAttach } from "./browsers.js";
import { listLanes, updateRegistry } from "./registry.js";
import { CapacityError, loadConfig } from "./config.js";

export interface AllocateOptions {
  owner: string;
  cwd: string;
  /**
   * Optional session id so the same agent can hold multiple parallel lanes
   * in one project. Lanes are keyed by (owner, cwd, sessionId). If omitted,
   * "default" is used and the lane behaves like a single-session lane.
   */
  sessionId?: string;
  task?: string;
  notes?: string;
  appPortRange?: PortRange;
  chromeDebugRange?: PortRange;
  /** When false, do not allocate an app port. Default true. */
  withAppPort?: boolean;
  /** When false, do not allocate a Chrome debug port. Default true. */
  withChromePort?: boolean;
  /** Optional explicit profile directory override. */
  profileDir?: string;
  /** Optional pre-fetched scan to avoid re-running the scanner. */
  observations?: PortObservation[];
  /** Optional explicit lane id (used by tests). */
  id?: string;
  /** Optional initial status. Defaults to "reserved". */
  status?: LaneStatus;
  /** Optional browser script path the agent will use to talk to Chrome. */
  browserScript?: string;
  /** Browser backend for this lane. Default "chrome". Firefox lanes get a
   *  distinct profile dir (suffix "-firefox") so the two backends can never
   *  share one. */
  browser?: BrowserKind;
}

export interface AllocateResult {
  lane: Lane;
  alreadyExisted: boolean;
  scanSource: "sonar" | "native" | "empty" | "provided";
  /** Soft warning (e.g. capacity threshold reached). Not an error. */
  warning?: string;
  /** Number of active lanes after this allocation, when a cap is configured. */
  activeLaneCount?: number;
}

function rangeIter(range: PortRange): number[] {
  const out: number[] = [];
  for (let p = range.start; p <= range.end; p++) out.push(p);
  return out;
}

interface PortPickContext {
  occupied: Set<number>;
  reservedAppPorts: Set<number>;
  reservedChromePorts: Set<number>;
}

function pickPort(range: PortRange, taken: Set<number>): number | undefined {
  for (const p of rangeIter(range)) {
    if (!taken.has(p)) return p;
  }
  return undefined;
}

function buildContext(observations: PortObservation[], lanes: Lane[]): PortPickContext {
  const occupied = new Set<number>();
  for (const o of observations) occupied.add(o.port);
  const reservedAppPorts = new Set<number>();
  const reservedChromePorts = new Set<number>();
  for (const lane of lanes) {
    if (lane.status === "released") continue;
    if (typeof lane.appPort === "number") reservedAppPorts.add(lane.appPort);
    if (typeof lane.chromeDebugPort === "number") reservedChromePorts.add(lane.chromeDebugPort);
  }
  return { occupied, reservedAppPorts, reservedChromePorts };
}

function buildProfileDir(
  owner: string,
  project: string,
  sessionId: string,
  taken: Set<string>,
  override?: string,
  browser?: BrowserKind,
): string {
  if (override) return override;
  const o = ownerSlug(owner);
  const p = projectSlug(project);
  const s = sessionId === DEFAULT_SESSION_ID ? undefined : sessionId;
  const base = profileDirFor(o, p, { sessionId: s, browser });
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (true) {
    const candidate = profileDirFor(o, p, { sessionId: s, browser, dedupeSuffix: String(suffix) });
    if (!taken.has(candidate.toLowerCase())) return candidate;
    suffix++;
  }
}

function takenProfileDirs(lanes: Lane[]): Set<string> {
  const out = new Set<string>();
  for (const lane of lanes) {
    if (lane.status === "released") continue;
    out.add(lane.chromeProfileDir.toLowerCase());
  }
  return out;
}

export function findExistingLane(
  lanes: Lane[],
  owner: string,
  cwd: string,
  sessionId: string = DEFAULT_SESSION_ID,
  browser: BrowserKind = "chrome",
): Lane | undefined {
  const target = normalizeCwd(cwd);
  // Match canonical-against-canonical so a registry that still contains
  // pre-canonicalization owners (e.g. "codex-test-alpha" written before
  // canonicalizeOwner shipped) can still satisfy idempotency for new
  // callers passing the same raw inputs. Without this, allocateLane would
  // create a duplicate lane on every retry, eating ports + profile dirs.
  // Browser must match too: a Chrome lane and a Firefox lane for the same
  // (owner, cwd, session) are DIFFERENT lanes — reusing one for the other
  // would hand a Firefox caller a Chrome profile dir.
  return lanes.find((l) => {
    if (laneBrowser(l) !== browser) return false;
    if (normalizeCwd(l.cwd) !== target) return false;
    if (laneSessionId(l) !== sessionId) return false;
    if (l.status === "released") return false;
    if (l.owner === owner) return true;
    return canonicalizeOwner(l.owner).canonical === owner;
  });
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
export async function allocateLane(opts: AllocateOptions): Promise<AllocateResult> {
  const observationsProvided = opts.observations !== undefined;
  const scan = observationsProvided
    ? { observations: opts.observations!, source: "provided" as const, errors: [] as string[] }
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
  const explicitSession =
    typeof opts.sessionId === "string" && opts.sessionId.trim().length > 0;
  const sessionRaw = explicitSession ? opts.sessionId! : canon.custom;
  const sessionId = sessionSlug(sessionRaw);

  const config = await loadConfig();
  let alreadyExisted = false;
  let result: Lane | undefined;
  let warning: string | undefined;
  let activeLaneCount: number | undefined;

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
        return { ...lane, status: "stale" as LaneStatus };
      }
      return lane;
    });

    const browser: BrowserKind = opts.browser ?? "chrome";
    const existing = findExistingLane(lanes, ownerCanonical, opts.cwd, sessionId, browser);
    if (existing) {
      alreadyExisted = true;
      // Re-activate stale lanes when the caller comes back. This is what
      // "I'm reconnecting to my project" should do — same port, same
      // profile, status flips back to active.
      const reactivatedStatus: LaneStatus = existing.status === "stale" ? "active" : existing.status;
      result = { ...existing, sessionId, lastSeen: nowIso(), status: reactivatedStatus };
      return lanes.map((l) => (l.id === existing.id ? result! : l));
    }
    // Capacity check — released AND stale lanes are paperwork, not
    // contested resources. They don't block new reservations.
    const activeLanes = lanes.filter((l) => l.status !== "released" && l.status !== "stale");
    if (typeof config.maxActiveLanes === "number" && activeLanes.length >= config.maxActiveLanes) {
      throw new CapacityError(
        `MAX_ACTIVE_LANES_REACHED: ${activeLanes.length} active lanes >= cap of ${config.maxActiveLanes}. ` +
          `Release a lane (portpilot release ...) or raise maxActiveLanes in config.json.`,
        "MAX_ACTIVE_LANES_REACHED",
      );
    }
    const ctx = buildContext(observations, lanes);
    const appRange = opts.appPortRange ?? config.appPortRange ?? DEFAULT_APP_PORT_RANGE;
    const chromeRange = opts.chromeDebugRange ?? config.chromeDebugRange ?? DEFAULT_CHROME_DEBUG_RANGE;
    const wantApp = opts.withAppPort !== false;
    const wantChrome = opts.withChromePort !== false;
    const appTaken = new Set<number>([...ctx.occupied, ...ctx.reservedAppPorts]);
    const chromeTaken = new Set<number>([...ctx.occupied, ...ctx.reservedChromePorts]);
    const appPort = wantApp ? pickPort(appRange, appTaken) : undefined;
    const chromeDebugPort = wantChrome ? pickPort(chromeRange, chromeTaken) : undefined;
    if (wantApp && appPort === undefined) {
      throw new Error(`No free app port in range ${appRange.start}-${appRange.end}`);
    }
    if (wantChrome && chromeDebugPort === undefined) {
      throw new Error(`No free Chrome debug port in range ${chromeRange.start}-${chromeRange.end}`);
    }
    const profileDir = buildProfileDir(ownerCanonical, opts.cwd, sessionId, takenProfileDirs(lanes), opts.profileDir, browser);
    const lane: Lane = {
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
    if (
      typeof config.warnAtActiveLanes === "number" &&
      activeLaneCount >= config.warnAtActiveLanes &&
      (typeof config.maxActiveLanes !== "number" || activeLaneCount < config.maxActiveLanes)
    ) {
      warning = `Approaching capacity: ${activeLaneCount} active lanes (warn at ${config.warnAtActiveLanes}, max ${config.maxActiveLanes ?? "unlimited"}).`;
    }
    return [...lanes, lane];
  });

  if (!result) throw new Error("Allocation failed: no lane returned");
  const out: AllocateResult = { lane: result, alreadyExisted, scanSource: scan.source };
  if (warning) out.warning = warning;
  if (typeof activeLaneCount === "number") out.activeLaneCount = activeLaneCount;
  return out;
}

export interface FindFreePortOptions {
  range?: PortRange;
  observations?: PortObservation[];
}

export async function findFreePort(opts: FindFreePortOptions = {}): Promise<number | undefined> {
  const range = opts.range ?? DEFAULT_CHROME_DEBUG_RANGE;
  const observations = opts.observations ?? (await scanPorts()).observations;
  const lanes = await listLanes();
  const ctx = buildContext(observations, lanes);
  const taken = new Set<number>([...ctx.occupied, ...ctx.reservedChromePorts, ...ctx.reservedAppPorts]);
  return pickPort(range, taken);
}

export interface CheckResult {
  lane: Lane;
  verdict: ChromeAttachVerdict;
  appPortInUse: boolean;
  appPortObservation?: PortObservation;
  scanSource: "sonar" | "native" | "empty";
  scanErrors: string[];
}

/**
 * Check whether a lane is safe to use right now. This is what an agent should
 * call before attaching its browser automation script. The return value is
 * structured for both human and agent consumption.
 */
export async function checkLane(lane: Lane): Promise<CheckResult> {
  const scan = await scanPorts();
  // Routed by the lane's browser: Firefox lanes are judged against Firefox
  // processes + -profile args, never mistaken for (or matched to) Chrome CDP.
  const verdict = evaluateBrowserAttach(lane, scan.observations);
  const appPortInUse = typeof lane.appPort === "number" ? isPortInUse(scan.observations, lane.appPort) : false;
  const appPortObservation =
    typeof lane.appPort === "number"
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
