import type { Lane } from "../core/lane.js";
import type { PortObservation } from "../core/scanner.js";
/** Reconcile persisted lifecycle state from one fresh process/port snapshot. */
export declare function reconcileBrowserLanes(lanes: Lane[], observations: PortObservation[], supervisorId: string, at?: string): Lane[];
export declare function markSupervisorDisconnected(lanes: Lane[], supervisorId: string, at?: string): Lane[];
