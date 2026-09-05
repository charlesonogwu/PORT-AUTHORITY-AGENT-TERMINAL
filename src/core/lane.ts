/**
 * Core domain types for portpilot.
 *
 * A "lane" is one agent's reserved working slot: an app port, a Chrome debug port,
 * a Chrome profile directory, and metadata identifying who owns it.
 */

export type LaneStatus = "reserved" | "active" | "stale" | "released";

/** Browser-process state, separate from the lane's allocation status. */
export type BrowserLifecycleState =
  | "starting"
  | "active"
  | "disconnected"
  | "recoverable"
  | "crashed"
  | "closed";

/**
 * Which browser backend a lane launches/coordinates.
 *
 *   - "chrome"  — Chromium family via CDP (--remote-debugging-port). Default.
 *   - "edge"    — Microsoft Edge. Also Chromium, so it speaks real CDP and
 *                 supports every Chrome launch mode; it only differs in binary
 *                 location and process identity.
 *   - "firefox" — Firefox with a dedicated -profile dir. Its debug port serves
 *                 WebDriver BiDi (ws://127.0.0.1:<port>/session), NOT Chrome
 *                 CDP — agents must use a BiDi-capable client (Playwright,
 *                 WebDriver). PortPilot launches + coordinates; it does not
 *                 drive any browser.
 */
export type BrowserKind = "chrome" | "firefox" | "edge";

/** Read a lane's browser defensively: lanes written before the field existed
 *  (or by older versions) are Chrome lanes. */
export function laneBrowser(lane: { browser?: string }): BrowserKind {
  if (lane.browser === "firefox") return "firefox";
  if (lane.browser === "edge") return "edge";
  return "chrome";
}

export interface Lane {
  id: string;
  owner: string;
  project: string;
  cwd: string;
  /**
   * Optional session identifier so the same agent can hold multiple
   * concurrent lanes in the same project (e.g. parallel tasks). Lanes are
   * keyed by (owner, cwd, sessionId); when omitted, the implicit value is
   * `DEFAULT_SESSION_ID` and the lane behaves the same as before.
   */
  sessionId: string;
  task?: string;
  /** Historical user confirmation only; never proof of current authentication. */
  savedLogins?: { website: string; confirmedAt: string; accountLabel?: string }[];
  /** User-facing name for the intended saved browser account/profile. */
  profileLabel?: string;
  /** Normalized purpose tags used to rediscover this PPID across agents. */
  profilePurposes?: string[];
  appPort?: number;
  /**
   * Remote-debugging port. For Chrome lanes this is the CDP port; for Firefox
   * lanes the same port serves WebDriver BiDi. Field name kept for
   * backwards compatibility with existing registries and callers.
   */
  chromeDebugPort?: number;
  /** Dedicated browser profile dir (--user-data-dir for Chrome, -profile for
   *  Firefox). Field name kept for backwards compatibility. */
  chromeProfileDir: string;
  /** Browser backend. Absent = "chrome" (pre-0.3.7 lanes). */
  browser?: BrowserKind;
  browserScript?: string;
  status: LaneStatus;
  createdAt: string;
  lastSeen: string;
  pid?: number;
  /** Verified browser root pid. `pid` remains for registry compatibility. */
  browserPid?: number;
  /** Supervisor instance that last verified or launched the browser. */
  supervisorId?: string;
  /** Browser process lifecycle, independent of lane reservation status. */
  browserState?: BrowserLifecycleState;
  /** Time the supervisor launched or first verified this browser identity. */
  browserStartedAt?: string;
  notes?: string;
}

/**
 * The implicit session id used when a caller does not supply one. Lanes
 * stored before sessionId existed are read back as if they had this id, so
 * the model is fully backwards compatible.
 */
export const DEFAULT_SESSION_ID = "default";

export interface RegistryFile {
  version: 1;
  lanes: Lane[];
}

export const REGISTRY_VERSION = 1 as const;

export interface PortRange {
  start: number;
  end: number;
}

export const DEFAULT_CHROME_DEBUG_RANGE: PortRange = { start: 9322, end: 9399 };
export const DEFAULT_APP_PORT_RANGE: PortRange = { start: 3000, end: 3099 };

/**
 * A lane is considered stale if it has not checked in within this window.
 * Stale lanes do not block port allocation, but they are still listed.
 */
export const STALE_AFTER_MS = 1000 * 60 * 30;

export function newLaneId(): string {
  return `lane_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function projectSlug(cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "project";
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "project";
}

export function ownerSlug(owner: string): string {
  return owner
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "agent";
}

/**
 * Canonical LLM provider names the dashboard shows in the AGENT column.
 *
 * Order matters: when an `owner` string contains multiple keywords (rare),
 * the earliest match wins. Keep more specific names first.
 */
export const KNOWN_LLM_OWNERS = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "windsurf",
  "openhands",
  "aider",
  "copilot",
  "chatgpt",
  "goose",
  "opencode",
] as const;

export interface CanonicalOwner {
  /** The agent name we'll show in the dashboard AGENT column. Always one
   *  of KNOWN_LLM_OWNERS, or the literal "agent" fallback. */
  canonical: string;
  /** Any custom suffix the agent typed (e.g. "test-alpha" from
   *  "codex-test-alpha"). Useful as an automatic sessionId. */
  custom?: string;
}

/**
 * Distill a free-form `owner` string down to a canonical LLM provider name.
 *
 * Examples:
 *   "codex-test-alpha"  → { canonical: "codex",  custom: "test-alpha" }
 *   "agent-random-1"    → { canonical: "agent",  custom: "agent-random-1" }
 *   "claude"            → { canonical: "claude" }
 *   "ClAude_v2"         → { canonical: "claude", custom: "v2" }
 *   "batch2-agent-3"    → { canonical: "agent",  custom: "batch2-agent-3" }
 *   ""                  → { canonical: "agent" }
 *
 * Anything we can't recognize as a known LLM falls back to the literal
 * "agent". The original user-supplied string is preserved in `custom` so
 * callers can promote it to `sessionId` automatically and not lose info.
 */
/**
 * Find `name` inside `haystack` at a WORD BOUNDARY: the characters on both
 * sides (when present) must be non-alphanumeric. This is what keeps short
 * agent names from false-matching inside unrelated words — "mongoose" must
 * not canonicalize to "goose", "opencoder" must not become "opencode".
 */
function findBoundaryMatch(haystack: string, name: string): number {
  let idx = haystack.indexOf(name);
  while (idx !== -1) {
    const beforeOk = idx === 0 || !/[a-z0-9]/.test(haystack[idx - 1]!);
    const afterOk = idx + name.length >= haystack.length || !/[a-z0-9]/.test(haystack[idx + name.length]!);
    if (beforeOk && afterOk) return idx;
    idx = haystack.indexOf(name, idx + 1);
  }
  return -1;
}

export function canonicalizeOwner(raw: string | undefined | null): CanonicalOwner {
  const lower = (raw ?? "").trim().toLowerCase();
  if (lower.length === 0) return { canonical: "agent" };
  for (const name of KNOWN_LLM_OWNERS) {
    const idx = findBoundaryMatch(lower, name);
    if (idx === -1) continue;
    // Strip the matched LLM name from the raw value to keep any suffix.
    const stripped = (lower.slice(0, idx) + lower.slice(idx + name.length))
      .replace(/^[-_\s]+|[-_\s]+$/g, "")
      .replace(/[-_\s]+/g, "-");
    const result: CanonicalOwner = { canonical: name };
    if (stripped.length > 0) result.custom = stripped;
    return result;
  }
  // No known LLM found — fall back to "agent" but preserve the original
  // string as `custom` so the caller can promote it to sessionId.
  if (lower === "agent") return { canonical: "agent" };
  return { canonical: "agent", custom: lower };
}

/**
 * Normalize and clamp a session id to safe filename characters. Empty or
 * missing input collapses to DEFAULT_SESSION_ID so storage is uniform.
 */
export function sessionSlug(sessionId: string | undefined | null): string {
  const raw = (sessionId ?? "").toString().trim();
  if (!raw) return DEFAULT_SESSION_ID;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || DEFAULT_SESSION_ID;
}

/**
 * Read sessionId off a lane defensively — older lanes from before the
 * field existed will not have it set, and we treat them as the default
 * session.
 */
export function laneSessionId(lane: { sessionId?: string }): string {
  const v = lane.sessionId;
  if (typeof v !== "string" || v.trim().length === 0) return DEFAULT_SESSION_ID;
  return v;
}

export function normalizeCwd(cwd: string): string {
  if (!cwd) return cwd;
  // Convert all separators to OS-native, drop trailing separators (except for root).
  let p = cwd.trim();
  // Normalize Windows drive letters to upper-case for stable comparison.
  if (/^[a-z]:[\\/]/.test(p)) p = p[0]!.toUpperCase() + p.slice(1);
  // Replace mixed separators consistently.
  if (process.platform === "win32") {
    p = p.replace(/\//g, "\\");
    p = p.replace(/\\+/g, "\\");
    if (!/^[A-Z]:\\?$/.test(p)) p = p.replace(/\\+$/, "");
  } else {
    p = p.replace(/\\+/g, "/");
    p = p.replace(/\/+/g, "/");
    if (p !== "/") p = p.replace(/\/+$/, "");
  }
  return p;
}

export function isStale(lane: Lane, now: number = Date.now()): boolean {
  if (lane.status === "released") return false;
  const last = Date.parse(lane.lastSeen);
  if (!Number.isFinite(last)) return true;
  return now - last > STALE_AFTER_MS;
}
