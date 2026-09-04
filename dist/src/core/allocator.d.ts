import { BrowserKind, Lane, LaneStatus, PortRange } from "./lane.js";
import { PortObservation } from "./scanner.js";
import { ChromeAttachVerdict } from "./chrome.js";
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
export declare class LaneReopenError extends Error {
    constructor(message: string);
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
export declare function findExistingLane(lanes: Lane[], owner: string, cwd: string, sessionId?: string, browser?: BrowserKind): Lane | undefined;
/**
 * Find an existing lane for (owner, cwd, sessionId) regardless of browser.
 * Used when a caller does NOT specify a browser: reconnecting to whatever
 * lane it already has beats creating a second lane in the default browser.
 * When the key has lanes in several browsers (created explicitly), prefer
 * the `prefer` browser if one matches, else the most recently seen lane.
 */
export declare function findExistingLaneAnyBrowser(lanes: Lane[], owner: string, cwd: string, sessionId?: string, prefer?: BrowserKind): Lane | undefined;
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
export declare function allocateLane(opts: AllocateOptions): Promise<AllocateResult>;
export interface AdoptProfileOptions extends Omit<AllocateOptions, "profileDir" | "laneId"> {
    profileDir: string;
}
/** Explicitly register an orphaned PortPilot-owned profile as one new lane. */
export declare function adoptProfileLane(opts: AdoptProfileOptions): Promise<AllocateResult>;
export interface FindFreePortOptions {
    range?: PortRange;
    observations?: PortObservation[];
}
export declare function findFreePort(opts?: FindFreePortOptions): Promise<number | undefined>;
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
export declare function checkLane(lane: Lane): Promise<CheckResult>;
