/**
 * Dashboard snapshot — live-first data model.
 *
 * The PRIMARY entity is a "live session" — a real Chrome process listening
 * with --remote-debugging-port that we can talk to via CDP. That's the
 * ground truth.
 *
 * portpilot's registry is SECONDARY — it describes what agents *intended*
 * to do. The dashboard surfaces it as `registryHealth` summary and
 * `conflicts` warnings; we never let stale registry rows pollute the live
 * view.
 */
import { EntrySource } from "./sources.js";
export interface CdpTab {
    id: string;
    type: string;
    title?: string;
    url?: string;
}
/**
 * Identity columns for a session — owner/project/cwd.
 *
 * Each field carries an explicit `confidence` so the UI can show honestly
 * whether the value came from a real lane or was inferred from the profile
 * path.
 *
 *   "registered" — the live Chrome's profile dir matches a registered lane;
 *                  the value came from that lane's metadata.
 *   "inferred"   — no registry match; we guessed from the profile path or
 *                  the cwd structure.
 *   "unknown"    — neither registered nor inferable.
 */
export type Confidence = "registered" | "inferred" | "unknown";
export interface LiveSession {
    /** Stable id for UI keying. Composed from pid+port+profile so it survives
     * registry mutations. */
    key: string;
    /** Best-effort name of the agent driving this Chrome. */
    agent: string;
    agentConfidence: Confidence;
    /** Best-effort project name (cwd basename, or profile leaf). */
    project: string;
    projectConfidence: Confidence;
    /** Working directory (absolute) when known. */
    cwd?: string;
    cwdConfidence: Confidence;
    task?: string;
    pid: number;
    chromeDebugPort: number;
    /**
     * How the agent talks to Chrome's DevTools Protocol:
     *   "port" — TCP socket on chromeDebugPort (we can read tabs)
     *   "pipe" — stdio pipe owned by the launcher (we can see the
     *            session exists but cannot enumerate tabs)
     */
    debugMode: "port" | "pipe";
    appPort?: number;
    chromeProfileDir: string;
    /** True when the profile already holds a login/cookie/localStorage store —
     *  i.e. there is saved browser data the user could choose to erase. The
     *  dashboard shows a "saved" marker for these rows. Cheap to compute (a few
     *  stat calls), unlike a full size walk. */
    hasSavedData: boolean;
    browserVersion?: string;
    /** All non-internal CDP targets we found. Empty for pipe-mode Chromes. */
    tabs: CdpTab[];
    /** Tabs after filtering out chrome:// internal targets — what the user cares about. */
    primaryTabs: CdpTab[];
    /** Whether portpilot adopted this Chrome (lane match by port + profile). */
    registeredBy: EntrySource | null;
    /** Lane id from portpilot when registered. */
    laneId?: string;
    cdpError?: string;
    /**
     * For sessions NOT registered via portpilot, what we inferred about the
     * agent driving Chrome (process ancestry, CDP peer, profile keyword).
     * "high" / "medium" / "low" / "none". Absent for portpilot-managed sessions.
     */
    agentInferenceConfidence?: "high" | "medium" | "low" | "none";
    /** Human-readable evidence strings — surfaced on hover in the dashboard. */
    agentInferenceEvidence?: string[];
}
export interface RegistryStatus {
    found: boolean;
    total: number;
    /** Reservations whose chromeDebugPort matches a live Chrome with the matching profile. */
    live: number;
    /** Reservations marked stale (lastSeen too old) OR whose profile mismatches the actual Chrome on the port. */
    stale: number;
    /** Reservations with no Chrome on their port at all. */
    empty: number;
    staleEntries: {
        laneId: string;
        agent: string;
        project: string;
        reason: string;
    }[];
}
export type ConflictKind = "registry-mismatch-with-live" | "duplicate-port-within-tool";
export interface Conflict {
    kind: ConflictKind;
    port: number;
    message: string;
    involvedLaneIds: string[];
}
export interface DashboardSnapshot {
    ok: boolean;
    generatedAt: string;
    scanSource: "sonar" | "native" | "empty";
    scanErrors: string[];
    home: string;
    registryPath: string;
    config: {
        maxActiveLanes?: number;
        warnAtActiveLanes?: number;
        chromeDebugRange?: {
            start: number;
            end: number;
        };
        appPortRange?: {
            start: number;
            end: number;
        };
    };
    /** Top-line numbers — the only thing the header shows. */
    summary: {
        liveSessions: number;
        distinctAgents: number;
        conflicts: number;
    };
    liveSessions: LiveSession[];
    registryHealth: {
        portpilot: RegistryStatus;
    };
    conflicts: Conflict[];
}
export declare function buildSnapshot(opts?: {
    cdpTimeoutMs?: number;
}): Promise<DashboardSnapshot>;
