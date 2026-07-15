import { Lane } from "./lane.js";
import { PortObservation } from "./scanner.js";
import { ChromeAttachVerdict, LaunchChromeOptions, LaunchPlan, LaunchResult } from "./chrome.js";
/** True iff `p` looks like an Edge-family binary by basename. Gates
 *  caller-supplied binaryPath values coming in via MCP/CLI. */
export declare function isEdgeBinaryPath(p: string | undefined): boolean;
export declare function macOsEdgeCandidates(home?: string): string[];
export declare function resolveEdgeBinary(explicit?: string): string;
export declare function isEdgeProcess(o: PortObservation): boolean;
/**
 * Edge flavour of the attach-safety verdict. Same shape and kinds as
 * evaluateChromeAttach so every consumer (check_lane, doctor, dashboard)
 * works unchanged, but the identity check requires an EDGE process:
 *
 *   - free port                            → safe-free
 *   - Edge with matching --user-data-dir   → safe-attach
 *   - Edge with different/unknown profile  → unsafe-foreign-chrome
 *   - non-Edge (including Chrome!)         → unsafe-unknown
 *
 * A Chrome on an Edge lane's port is deliberately unsafe-unknown: it may be
 * Chromium-family, but it is not the browser this lane reserved.
 */
export declare function evaluateEdgeAttach(lane: Lane, observations: PortObservation[]): ChromeAttachVerdict;
/** Build the Edge launch command: identical to Chrome's (Edge IS Chromium),
 *  just with the Edge binary resolved/validated first. */
export declare function buildEdgeLaunchPlan(lane: Lane, opts?: LaunchChromeOptions): LaunchPlan;
/** Launch Edge for the lane. Same contract as launchChromeForLane. */
export declare function launchEdgeForLane(lane: Lane, opts?: LaunchChromeOptions): Promise<LaunchResult>;
