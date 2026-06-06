import { PortRange } from "./lane.js";
import type { ChromeLaunchMode } from "./chrome.js";
/**
 * Optional, machine-local configuration. When the file is absent, callers
 * fall back to built-in defaults — all behaviour is unchanged.
 *
 *   ~/.portpilot/config.json
 *   {
 *     "version": 1,
 *     "chromeDebugRange": { "start": 9322, "end": 9399 },
 *     "appPortRange":     { "start": 3000, "end": 3099 },
 *     "maxActiveLanes":      20,
 *     "warnAtActiveLanes":   15
 *   }
 */
export interface PortpilotConfig {
    version: 1;
    chromeDebugRange?: PortRange;
    appPortRange?: PortRange;
    /**
     * Hard cap on the number of non-released lanes that may exist at once.
     * Once reached, allocateLane throws with `MAX_ACTIVE_LANES_REACHED` until
     * one is released. Intended to model the RAM ceiling of the host machine.
     */
    maxActiveLanes?: number;
    /**
     * Soft warning threshold. When reached, allocateLane returns an additional
     * `warning` field describing the situation but still allocates.
     */
    warnAtActiveLanes?: number;
    /**
     * Default Chrome launch visibility for every lane on this machine
     * ("visible" | "background" | "headless"). A per-call `mode` and the
     * PORTPILOT_CHROME_MODE env var both override this. Omit (or "visible") to
     * keep the historical headed-on-the-active-desktop behaviour.
     */
    chromeMode?: ChromeLaunchMode;
}
export declare const CONFIG_VERSION: 1;
export declare const DEFAULT_CONFIG: PortpilotConfig;
export declare function configPath(): string;
export declare function loadConfig(): Promise<PortpilotConfig>;
export declare function saveConfig(cfg: PortpilotConfig): Promise<void>;
export interface MachineSizeInfo {
    totalRamBytes: number;
    totalRamGb: number;
    recommendedMaxActiveLanes: number;
    recommendedWarnAtActiveLanes: number;
    reasoning: string;
}
/**
 * Heuristic that turns a host's total RAM into a sensible ceiling for the
 * number of simultaneous Chrome lanes it can handle without thrashing.
 *
 * Assumptions per Chrome instance: ~350 MB headless / ~700 MB headed.
 * We pick a midway 500 MB, then reserve 35% of total RAM for the OS,
 * background apps, and the agent desktop apps themselves.
 */
export declare function recommendForMachine(totalRamBytesArg?: number): MachineSizeInfo;
/**
 * Build a config object based on the host machine's RAM. Existing values
 * in `current` are preserved; only the missing knobs are filled in.
 */
export declare function configForMachine(current?: PortpilotConfig): {
    config: PortpilotConfig;
    recommendation: MachineSizeInfo;
};
export declare class CapacityError extends Error {
    readonly code: "MAX_ACTIVE_LANES_REACHED";
    constructor(message: string, code: "MAX_ACTIVE_LANES_REACHED");
}
