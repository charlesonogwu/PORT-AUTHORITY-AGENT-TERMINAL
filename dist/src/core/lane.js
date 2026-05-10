/**
 * Core domain types for portpilot.
 *
 * A "lane" is one agent's reserved working slot: an app port, a Chrome debug port,
 * a Chrome profile directory, and metadata identifying who owns it.
 */
/**
 * The implicit session id used when a caller does not supply one. Lanes
 * stored before sessionId existed are read back as if they had this id, so
 * the model is fully backwards compatible.
 */
export const DEFAULT_SESSION_ID = "default";
export const REGISTRY_VERSION = 1;
export const DEFAULT_CHROME_DEBUG_RANGE = { start: 9322, end: 9399 };
export const DEFAULT_APP_PORT_RANGE = { start: 3000, end: 3099 };
/**
 * A lane is considered stale if it has not checked in within this window.
 * Stale lanes do not block port allocation, but they are still listed.
 */
export const STALE_AFTER_MS = 1000 * 60 * 30;
export function newLaneId() {
    return `lane_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
export function nowIso() {
    return new Date().toISOString();
}
export function projectSlug(cwd) {
    const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "project";
    return base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "project";
}
export function ownerSlug(owner) {
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
];
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
export function canonicalizeOwner(raw) {
    const lower = (raw ?? "").trim().toLowerCase();
    if (lower.length === 0)
        return { canonical: "agent" };
    for (const name of KNOWN_LLM_OWNERS) {
        const idx = lower.indexOf(name);
        if (idx === -1)
            continue;
        // Strip the matched LLM name from the raw value to keep any suffix.
        const stripped = (lower.slice(0, idx) + lower.slice(idx + name.length))
            .replace(/^[-_\s]+|[-_\s]+$/g, "")
            .replace(/[-_\s]+/g, "-");
        const result = { canonical: name };
        if (stripped.length > 0)
            result.custom = stripped;
        return result;
    }
    // No known LLM found — fall back to "agent" but preserve the original
    // string as `custom` so the caller can promote it to sessionId.
    if (lower === "agent")
        return { canonical: "agent" };
    return { canonical: "agent", custom: lower };
}
/**
 * Normalize and clamp a session id to safe filename characters. Empty or
 * missing input collapses to DEFAULT_SESSION_ID so storage is uniform.
 */
export function sessionSlug(sessionId) {
    const raw = (sessionId ?? "").toString().trim();
    if (!raw)
        return DEFAULT_SESSION_ID;
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
export function laneSessionId(lane) {
    const v = lane.sessionId;
    if (typeof v !== "string" || v.trim().length === 0)
        return DEFAULT_SESSION_ID;
    return v;
}
export function normalizeCwd(cwd) {
    if (!cwd)
        return cwd;
    // Convert all separators to OS-native, drop trailing separators (except for root).
    let p = cwd.trim();
    // Normalize Windows drive letters to upper-case for stable comparison.
    if (/^[a-z]:[\\/]/.test(p))
        p = p[0].toUpperCase() + p.slice(1);
    // Replace mixed separators consistently.
    if (process.platform === "win32") {
        p = p.replace(/\//g, "\\");
        p = p.replace(/\\+/g, "\\");
        if (!/^[A-Z]:\\?$/.test(p))
            p = p.replace(/\\+$/, "");
    }
    else {
        p = p.replace(/\\+/g, "/");
        p = p.replace(/\/+/g, "/");
        if (p !== "/")
            p = p.replace(/\/+$/, "");
    }
    return p;
}
export function isStale(lane, now = Date.now()) {
    if (lane.status === "released")
        return false;
    const last = Date.parse(lane.lastSeen);
    if (!Number.isFinite(last))
        return true;
    return now - last > STALE_AFTER_MS;
}
