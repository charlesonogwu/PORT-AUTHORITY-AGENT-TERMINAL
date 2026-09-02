/**
 * Core domain types for portpilot.
 *
 * A "lane" is one agent's reserved working slot: an app port, a Chrome debug port,
 * a Chrome profile directory, and metadata identifying who owns it.
 */
export type LaneStatus = "reserved" | "active" | "stale" | "released";
/** Browser-process state, separate from the lane's allocation status. */
export type BrowserLifecycleState = "starting" | "active" | "disconnected" | "recoverable" | "crashed" | "closed";
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
export declare function laneBrowser(lane: {
    browser?: string;
}): BrowserKind;
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
export declare const DEFAULT_SESSION_ID = "default";
export interface RegistryFile {
    version: 1;
    lanes: Lane[];
}
export declare const REGISTRY_VERSION: 1;
export interface PortRange {
    start: number;
    end: number;
}
export declare const DEFAULT_CHROME_DEBUG_RANGE: PortRange;
export declare const DEFAULT_APP_PORT_RANGE: PortRange;
/**
 * A lane is considered stale if it has not checked in within this window.
 * Stale lanes do not block port allocation, but they are still listed.
 */
export declare const STALE_AFTER_MS: number;
export declare function newLaneId(): string;
export declare function nowIso(): string;
export declare function projectSlug(cwd: string): string;
export declare function ownerSlug(owner: string): string;
/**
 * Canonical LLM provider names the dashboard shows in the AGENT column.
 *
 * Order matters: when an `owner` string contains multiple keywords (rare),
 * the earliest match wins. Keep more specific names first.
 */
export declare const KNOWN_LLM_OWNERS: readonly ["claude", "codex", "gemini", "cursor", "windsurf", "openhands", "aider", "copilot", "chatgpt", "goose", "opencode"];
export interface CanonicalOwner {
    /** The agent name we'll show in the dashboard AGENT column. Always one
     *  of KNOWN_LLM_OWNERS, or the literal "agent" fallback. */
    canonical: string;
    /** Any custom suffix the agent typed (e.g. "test-alpha" from
     *  "codex-test-alpha"). Useful as an automatic sessionId. */
    custom?: string;
}
export declare function canonicalizeOwner(raw: string | undefined | null): CanonicalOwner;
/**
 * Normalize and clamp a session id to safe filename characters. Empty or
 * missing input collapses to DEFAULT_SESSION_ID so storage is uniform.
 */
export declare function sessionSlug(sessionId: string | undefined | null): string;
/**
 * Read sessionId off a lane defensively — older lanes from before the
 * field existed will not have it set, and we treat them as the default
 * session.
 */
export declare function laneSessionId(lane: {
    sessionId?: string;
}): string;
export declare function normalizeCwd(cwd: string): string;
export declare function isStale(lane: Lane, now?: number): boolean;
