import type { Lane } from "./lane.js";
import type { PortObservation } from "./scanner.js";
export interface ValidatedLaneAction {
    lane: Lane;
    pid: number;
    observation: PortObservation;
}
/**
 * Final fail-closed gate immediately before a dashboard process/window action.
 * The caller must supply the freshly reloaded lane and freshly scanned process
 * observations; this function never trusts a PID cached in the React view.
 */
export declare function evaluateLaneAction(lane: Lane, requestedPid: number, observations: PortObservation[]): ValidatedLaneAction;
