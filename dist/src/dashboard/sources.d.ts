import { BrowserKind, LaneStatus } from "../core/lane.js";
import { PortObservation } from "../core/scanner.js";
/**
 * Where the dashboard sourced this entry. portpilot is the canonical
 * registry; "external" covers any live Chrome process with
 * --remote-debugging-port that didn't go through portpilot's reservation
 * flow (e.g., manually launched, or launched by some other tool we don't
 * know about). Owner for external entries is inferred from the profile
 * path when possible.
 */
export type EntrySource = "portpilot" | "external";
/**
 * Minimal schema we read out of the portpilot registry. Older lanes from
 * before sessionId existed are treated as "default".
 */
export interface UnifiedLane {
    source: "portpilot";
    id: string;
    owner: string;
    project: string;
    cwd: string;
    sessionId: string;
    task?: string;
    appPort?: number;
    chromeDebugPort?: number;
    chromeProfileDir: string;
    browser: BrowserKind;
    browserScript?: string;
    status: LaneStatus;
    createdAt: string;
    lastSeen: string;
    pid?: number;
    notes?: string;
}
export declare function readPortpilotLanes(): Promise<UnifiedLane[]>;
export type ChromeDebugMode = "port" | "pipe";
export interface LiveChrome {
    /** The --remote-debugging-port number, or 0 when debugMode === "pipe". */
    port: number;
    pid?: number;
    command?: string;
    commandLine?: string;
    profileDir?: string;
    /** Which browser this live process is. Absent = "chrome". Edge processes
     *  (msedge) are tagged "edge" — still Chromium/CDP, but tagged so they match
     *  Edge lanes. Firefox live processes are found by findAllAgentFirefoxes and
     *  tagged "firefox"; their port is a WebDriver BiDi endpoint, not CDP. */
    browser?: BrowserKind;
    /**
     * How the agent is talking to Chrome's DevTools Protocol:
     *   "port" — TCP listener on `port`, reachable from the dashboard for
     *            tab enumeration (legacy default).
     *   "pipe" — stdio pipe inherited from the launching process. Used by
     *            modern Playwright / Puppeteer by default. We can SEE the
     *            Chrome instance and infer the agent, but we can't read
     *            its tab list — only the launcher can talk to it.
     */
    debugMode: ChromeDebugMode;
}
/**
 * Pick out every Chromium-family parent process listening with
 * --remote-debugging-port from the scanner's observations. Each one is a
 * candidate for a dashboard entry, regardless of whether portpilot claims it.
 *
 * This is the LEGACY path — only finds Chromes with a TCP debug port.
 * For the broader enumeration that also catches `--remote-debugging-pipe`
 * Chromes (Playwright / Puppeteer default), use `findAllAgentChromes`.
 */
export declare function findLiveChromes(observations: PortObservation[]): LiveChrome[];
/**
 * Discover isolated Firefox parent processes from the native TCP scanner.
 * This is the macOS/Linux counterpart to findAllAgentFirefoxes: those
 * platforms do not currently provide the Windows process snapshot, so the
 * lsof observation enriched with ps is the authoritative source.
 *
 * Fail closed. A listener is dashboard-safe only when its complete command
 * line proves both an explicit profile and -no-remote. This prevents a normal
 * Firefox instance, an unverifiable process, or a content helper from being
 * mistaken for a PortPilot lane.
 */
export declare function findLiveFirefoxes(observations: PortObservation[]): LiveChrome[];
/**
 * Enumerate every Chromium-family PARENT process on the box and return one
 * LiveChrome for each that's clearly being driven via CDP — whether by TCP
 * port or stdio pipe.
 *
 * Why this exists: many agents (Playwright, Puppeteer, anything calling
 * `chromium.launch()`) start Chrome with `--remote-debugging-pipe` instead
 * of `--remote-debugging-port`. Pipe-mode Chrome opens NO listening port,
 * so the legacy port-scan path above can't see them at all. They're the
 * single biggest blind spot in dashboard coverage.
 *
 * We deliberately filter to "looks driven by an agent":
 *   - Has --remote-debugging-port=N, OR
 *   - Has --remote-debugging-pipe
 * That keeps the user's regular browsing Chrome out of the dashboard.
 *
 * On non-Windows or when the process snapshot is empty, returns []. The
 * caller is expected to fall back to `findLiveChromes` in that case.
 */
export declare function findAllAgentChromes(snap: {
    processes: Map<number, {
        pid: number;
        ppid: number;
        name: string;
        commandLine: string;
    }>;
}): LiveChrome[];
/**
 * Enumerate agent-launched Firefox parent processes (ones carrying a
 * `-profile` dir — i.e. a PortPilot lane, never the user's default Firefox).
 * Firefox's `-contentproc` child processes are skipped. The debug port (if
 * present) is a WebDriver BiDi endpoint, so we tag debugMode "port" but the
 * snapshot deliberately does NOT try Chrome CDP against it.
 */
export declare function findAllAgentFirefoxes(snap: {
    processes: Map<number, {
        pid: number;
        ppid: number;
        name: string;
        commandLine: string;
    }>;
}): LiveChrome[];
/**
 * Heuristically guess the agent owner from a Chrome profile directory.
 * Pure best-effort — used when an external Chrome (one not registered in
 * portpilot) shows up. Returns the literal "external" if no known agent
 * name is recognizable. Uses the same canonical list as the allocator so
 * both surfaces stay in sync.
 */
export declare function inferOwnerFromProfile(profileDir: string | undefined): string;
/**
 * Heuristically pick a project slug from a Chrome profile directory.
 */
export declare function inferProjectFromProfile(profileDir: string | undefined): string;
/**
 * Tries to infer the project working directory from a Chrome profile path.
 * Heuristics:
 *   1. Profile is INSIDE the project (e.g. "<cwd>/.automation/chrome-profile-codex")
 *      → return the cwd by walking up until we leave the .automation segment.
 *   2. Otherwise we have no way to know — return undefined.
 */
export declare function inferCwdFromProfile(profileDir: string | undefined): string | undefined;
export interface MergedEntryInput {
    lane?: UnifiedLane;
    live?: LiveChrome;
    source: EntrySource;
}
/**
 * Build the merged list of entries the dashboard will render. Each entry is
 * either:
 *   • a portpilot-registered lane with optional live Chrome
 *   • an external live Chrome with no portpilot registration (owner inferred)
 *
 * Live Chromes are matched to lanes by debug port + profile path.
 */
export declare function mergeSources(portpilotLanes: UnifiedLane[], liveChromes: LiveChrome[]): MergedEntryInput[];
