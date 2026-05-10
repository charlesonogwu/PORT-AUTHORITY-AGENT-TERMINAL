/**
 * Core domain types for portpilot.
 *
 * A "lane" is one agent's reserved working slot: an app port, a Chrome debug port,
 * a Chrome profile directory, and metadata identifying who owns it.
 */
export type LaneStatus = "reserved" | "active" | "stale" | "released";
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
    chromeDebugPort?: number;
    chromeProfileDir: string;
    browserScript?: string;
    status: LaneStatus;
    createdAt: string;
    lastSeen: string;
    pid?: number;
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
export declare const KNOWN_LLM_OWNERS: readonly ["claude", "codex", "gemini", "cursor", "windsurf", "openhands", "aider", "copilot", "chatgpt"];
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
