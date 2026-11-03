import type { Lane } from "../core/lane.js";
import { type PortTruthDependencies } from "../core/port-truth.js";
import { type ScanResult } from "../core/scanner.js";
export interface CloseBrowserDependencies {
    scan?: () => Promise<ScanResult>;
    terminate?: (pid: number) => Promise<void>;
    /** Kernel checks over the scan. On for the real scan; an injected scan is trusted unless this is given. */
    portTruth?: PortTruthDependencies;
}
/** Explicitly close one lane browser after a fresh browser/port/profile check. */
export declare function closeBrowserForLane(lane: Lane, deps?: CloseBrowserDependencies): Promise<boolean>;
