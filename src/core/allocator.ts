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
import { profileDirFor, profilesDir } from "./paths.js";
import { PortObservation, isPortInUse, scanPorts } from "./scanner.js";
import { ChromeAttachVerdict } from "./chrome.js";
import { evaluateBrowserAttach, normalizeBrowserKind } from "./browsers.js";
import { listLanes, resolveLaneSelectorFrom, updateRegistry } from "./registry.js";
import { CapacityError, loadConfig } from "./config.js";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

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
  /** Browser backend for this lane. Omit to let the allocator resolve it:
   *  an existing lane for the same key keeps its browser, else the config's
   *  defaultBrowser, else "chrome". Non-chrome lanes get a distinct profile
   *  dir suffix (e.g. "-firefox") so backends can never share one. */
  browser?: BrowserKind;
  /** Reopen one exact immutable lane identity, preserving its profile. */
  laneId?: string;
}

export class LaneReopenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneReopenError";
  }
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
    // A STALE lane only holds its ports while something actually listens
    // there (the `occupied` set already blocks live ports). A stale lane
    // with a dead browser is a leftover, not a reservation — without this
    // rule abandoned lanes accumulate until they squat the entire range and
    // every allocation fails with "No free ... port" (observed live: 74
    // stale lanes holding all 78 debug ports while only 5 were listening).
    // If an agent later returns to a reclaimed port, check_lane's safety
    // verdict refuses the attach — a safe, loud failure for one lane
    // instead of a global allocation outage for everyone.
    if (lane.status === "stale") continue;
    if (typeof lane.appPort === "number") reservedAppPorts.add(lane.appPort);
    if (typeof lane.chromeDebugPort === "number") reservedChromePorts.add(lane.chromeDebugPort);
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
function stripReclaimedPorts(lanes: Lane[], claimantId: string, appPort?: number, chromeDebugPort?: number): Lane[] {
  if (appPort === undefined && chromeDebugPort === undefined) return lanes;
  return lanes.map((l) => {
    if (l.status !== "stale" || l.id === claimantId) return l;
    let out = l;
    if (chromeDebugPort !== undefined && out.chromeDebugPort === chromeDebugPort) {
      const { chromeDebugPort: _dropped, ...rest } = out;
      out = rest as Lane;
    }
    if (appPort !== undefined && out.appPort === appPort) {
      const { appPort: _dropped, ...rest } = out;
      out = rest as Lane;
    }
    return out;
  });
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

function sameBrowserProfile(a: Lane, b: Lane): boolean {
  if (laneBrowser(a) !== laneBrowser(b)) return false;
  const left = normalizeCwd(a.chromeProfileDir);
  const right = normalizeCwd(b.chromeProfileDir);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function retireProfileDuplicates(lanes: Lane[], keeper: Lane): Lane[] {
  return lanes.map((lane) => {
    if (lane.id === keeper.id || !sameBrowserProfile(lane, keeper)) return lane;
    const retired: Lane = {
      ...lane,
      status: "released",
      browserState: "closed",
      lastSeen: nowIso(),
      notes: [lane.notes, `duplicate profile identity consolidated into ${keeper.id}`].filter(Boolean).join("; "),
    };
    delete retired.appPort;
    delete retired.chromeDebugPort;
    delete retired.pid;
    delete retired.browserPid;
    delete retired.browserStartedAt;
    delete retired.supervisorId;
    return retired;
  });
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
    return laneMatchesKey(l, owner, target, sessionId);
  });
}

function laneMatchesKey(l: Lane, owner: string, normalizedCwd: string, sessionId: string): boolean {
  if (normalizeCwd(l.cwd) !== normalizedCwd) return false;
  if (laneSessionId(l) !== sessionId) return false;
  if (l.status === "released") return false;
  if (l.owner === owner) return true;
  return canonicalizeOwner(l.owner).canonical === owner;
}

/**
 * Find an existing lane for (owner, cwd, sessionId) regardless of browser.
 * Used when a caller does NOT specify a browser: reconnecting to whatever
 * lane it already has beats creating a second lane in the default browser.
 * When the key has lanes in several browsers (created explicitly), prefer
 * the `prefer` browser if one matches, else the most recently seen lane.
 */
export function findExistingLaneAnyBrowser(
  lanes: Lane[],
  owner: string,
  cwd: string,
  sessionId: string = DEFAULT_SESSION_ID,
  prefer?: BrowserKind,
): Lane | undefined {
  const target = normalizeCwd(cwd);
  const matches = lanes.filter((l) => laneMatchesKey(l, owner, target, sessionId));
  if (matches.length === 0) return undefined;
  if (prefer) {
    const preferred = resolveLaneSelectorFrom(matches, { owner, cwd: target, sessionId, browser: prefer });
    if (preferred) return preferred;
  }
  const latest = matches.reduce((a, b) => (a.lastSeen >= b.lastSeen ? a : b));
  return resolveLaneSelectorFrom(matches, {
    owner,
    cwd: target,
    sessionId,
    browser: laneBrowser(latest),
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
  let exactTarget: Lane | undefined;
  if (opts.laneId) {
    exactTarget = (await listLanes()).find((lane) => lane.id === opts.laneId);
    if (!exactTarget) throw new LaneReopenError(`lane ${opts.laneId} was not found`);
    const profile = await stat(exactTarget.chromeProfileDir).catch(() => undefined);
    if (!profile?.isDirectory()) {
      throw new LaneReopenError(
        `lane ${opts.laneId} cannot be reopened because its profile directory is missing: ${exactTarget.chromeProfileDir}`,
      );
    }
  }
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
  const canon = canonicalizeOwner(exactTarget?.owner ?? opts.owner);
  const ownerCanonical = canon.canonical;
  const explicitSession =
    typeof opts.sessionId === "string" && opts.sessionId.trim().length > 0;
  const sessionRaw = explicitSession ? opts.sessionId! : canon.custom;
  const sessionId = exactTarget ? laneSessionId(exactTarget) : sessionSlug(sessionRaw);

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

    // Browser resolution, in priority order:
    //   1. explicit opts.browser — the agent (or the user's instruction to
    //      it) said which browser; always wins.
    //   2. an existing lane for this (owner, cwd, session) — a reconnecting
    //      caller keeps its lane's browser, whatever the default says.
    //   3. config.defaultBrowser — the dashboard's "Default browser" picker.
    //   4. "chrome".
    // The config value is user-edited JSON, so validate before trusting it.
    const cfgDefault = normalizeBrowserKind(config.defaultBrowser);
    let browser: BrowserKind;
    let existing: Lane | undefined;
    if (opts.laneId) {
      existing = lanes.find((lane) => lane.id === opts.laneId);
      if (!existing) throw new LaneReopenError(`lane ${opts.laneId} disappeared during reopen`);
      browser = laneBrowser(existing);
    } else if (opts.browser) {
      browser = opts.browser;
      existing = resolveLaneSelectorFrom(lanes, {
        owner: ownerCanonical,
        cwd: opts.cwd,
        sessionId,
        browser,
      });
    } else {
      // Prefer the configured default when several lanes exist for this key;
      // with no default configured, prefer chrome (the historical behaviour)
      // so pre-existing chrome lanes keep winning ambiguous reconnects.
      existing = findExistingLaneAnyBrowser(
        lanes,
        ownerCanonical,
        opts.cwd,
        sessionId,
        cfgDefault ?? "chrome",
      );
      browser = existing ? laneBrowser(existing) : (cfgDefault ?? "chrome");
    }
    if (existing) {
      alreadyExisted = true;
      // Re-activate stale lanes when the caller comes back. Same profile
      // (logins survive); usually the same ports too — but a lane that went
      // stale may have had its port reclaimed by another lane in the
      // meantime, so top up whatever this call needs and is missing.
      const reactivatedStatus: LaneStatus =
        existing.status === "stale" || existing.status === "released" ? "active" : existing.status;
      let appPort = existing.appPort;
      let chromeDebugPort = existing.chromeDebugPort;
      if (opts.laneId) {
        const isHeldByOther = (field: "appPort" | "chromeDebugPort", port: number | undefined): boolean =>
          port !== undefined && lanes.some((lane) =>
            lane.id !== existing!.id &&
            lane.status !== "released" &&
            lane.status !== "stale" &&
            lane[field] === port,
          );
        if (isHeldByOther("appPort", appPort)) appPort = undefined;
        if (isHeldByOther("chromeDebugPort", chromeDebugPort)) chromeDebugPort = undefined;
        if (chromeDebugPort !== undefined) {
          const verdict = evaluateBrowserAttach(existing, observations);
          if (verdict.kind === "unsafe-foreign-chrome" || verdict.kind === "unsafe-unknown") {
            chromeDebugPort = undefined;
          }
        }
      }
      const needApp = appPort === undefined && opts.withAppPort !== false;
      const needChrome = chromeDebugPort === undefined && opts.withChromePort !== false;
      if (needApp || needChrome) {
        const ctx = buildContext(observations, lanes);
        if (needApp) {
          const appRange = opts.appPortRange ?? config.appPortRange ?? DEFAULT_APP_PORT_RANGE;
          appPort = pickPort(appRange, new Set<number>([...ctx.occupied, ...ctx.reservedAppPorts]));
          if (appPort === undefined) throw new Error(`No free app port in range ${appRange.start}-${appRange.end}`);
        }
        if (needChrome) {
          const chromeRange = opts.chromeDebugRange ?? config.chromeDebugRange ?? DEFAULT_CHROME_DEBUG_RANGE;
          chromeDebugPort = pickPort(chromeRange, new Set<number>([...ctx.occupied, ...ctx.reservedChromePorts]));
          if (chromeDebugPort === undefined) throw new Error(`No free Chrome debug port in range ${chromeRange.start}-${chromeRange.end}`);
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
      const updated = retireProfileDuplicates(
        lanes.map((l) => (l.id === existing.id ? result! : l)),
        result!,
      );
      // Whether the ports are retained or freshly minted, no stale lane may
      // keep claiming them — that's the two-lanes-one-port conflict.
      return stripReclaimedPorts(updated, existing.id, appPort, chromeDebugPort);
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
    return [...stripReclaimedPorts(lanes, lane.id, appPort, chromeDebugPort), lane];
  });

  if (!result) throw new Error("Allocation failed: no lane returned");
  const out: AllocateResult = { lane: result, alreadyExisted, scanSource: scan.source };
  if (warning) out.warning = warning;
  if (typeof activeLaneCount === "number") out.activeLaneCount = activeLaneCount;
  return out;
}

export interface AdoptProfileOptions extends Omit<AllocateOptions, "profileDir" | "laneId"> {
  profileDir: string;
}

/** Explicitly register an orphaned PortPilot-owned profile as one new lane. */
export async function adoptProfileLane(opts: AdoptProfileOptions): Promise<AllocateResult> {
  const root = resolve(profilesDir());
  const candidate = resolve(opts.profileDir);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new LaneReopenError(`profile must be inside PortPilot profiles directory: ${root}`);
  }
  const info = await stat(candidate).catch(() => undefined);
  if (!info?.isDirectory()) throw new LaneReopenError(`profile directory does not exist: ${candidate}`);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const realRel = relative(realRoot, realCandidate);
  if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new LaneReopenError(`profile must be inside PortPilot profiles directory: ${root}`);
  }
  const key = process.platform === "win32" ? realCandidate.toLowerCase() : realCandidate;
  const lanes = await listLanes();
  let owner: Lane | undefined;
  for (const lane of lanes) {
    const current = await realpath(lane.chromeProfileDir).catch(() => resolve(lane.chromeProfileDir));
    if ((process.platform === "win32" ? current.toLowerCase() : current) === key) {
      owner = lane;
      break;
    }
  }
  if (owner) throw new LaneReopenError(`profile is already registered to immutable PPID ${owner.id}`);
  return allocateLane({ ...opts, profileDir: candidate });
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
