import type { Lane } from "../core/lane.js";
import { type ScanResult } from "../core/scanner.js";
export interface CloseBrowserDependencies {
    scan?: () => Promise<ScanResult>;
    terminate?: (pid: number) => Promise<void>;
}
/** Explicitly close one lane browser after a fresh browser/port/profile check. */
export declare function closeBrowserForLane(lane: Lane, deps?: CloseBrowserDependencies): Promise<boolean>;
