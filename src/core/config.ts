import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { totalmem } from "node:os";
import { DEFAULT_APP_PORT_RANGE, DEFAULT_CHROME_DEBUG_RANGE, PortRange } from "./lane.js";
import { atomicWriteJson } from "./lockfile.js";
import { portpilotHome } from "./paths.js";
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

export const CONFIG_VERSION = 1 as const;

export const DEFAULT_CONFIG: PortpilotConfig = {
  version: CONFIG_VERSION,
  chromeDebugRange: DEFAULT_CHROME_DEBUG_RANGE,
  appPortRange: DEFAULT_APP_PORT_RANGE,
};

export function configPath(): string {
  return join(portpilotHome(), "config.json");
}

export async function loadConfig(): Promise<PortpilotConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PortpilotConfig>;
    if (!parsed || parsed.version !== CONFIG_VERSION) {
      return { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG, ...parsed, version: CONFIG_VERSION };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
}

export async function saveConfig(cfg: PortpilotConfig): Promise<void> {
  await atomicWriteJson(configPath(), { ...cfg, version: CONFIG_VERSION });
  // touch a noop just to keep API symmetric with future writes
  void writeFile;
}

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
export function recommendForMachine(totalRamBytesArg: number = totalmem()): MachineSizeInfo {
  const totalGb = totalRamBytesArg / 1024 ** 3;
  // Reserve a baseline that scales with size: smaller machines need a bigger
  // proportional reserve to stay responsive.
  const reservedGb = totalGb < 16 ? Math.max(4, totalGb * 0.45) : totalGb * 0.35;
  const availableGb = Math.max(0, totalGb - reservedGb);
  const perChromeGb = 0.5;
  const raw = Math.floor(availableGb / perChromeGb);
  // Clamp into a sensible band: never less than 2, never more than 78
  // (the default Chrome port range).
  const cap = Math.max(2, Math.min(78, raw));
  const warn = Math.max(1, Math.floor(cap * 0.75));
  return {
    totalRamBytes: totalRamBytesArg,
    totalRamGb: Math.round(totalGb * 10) / 10,
    recommendedMaxActiveLanes: cap,
    recommendedWarnAtActiveLanes: warn,
    reasoning:
      `total ${Math.round(totalGb)}GB - ${Math.round(reservedGb)}GB reserved (OS + agent apps) ` +
      `= ${Math.round(availableGb)}GB / 0.5GB-per-chrome ≈ ${raw}, clamped to [2, 78]`,
  };
}

/**
 * Build a config object based on the host machine's RAM. Existing values
 * in `current` are preserved; only the missing knobs are filled in.
 */
export function configForMachine(current: PortpilotConfig = { ...DEFAULT_CONFIG }): {
  config: PortpilotConfig;
  recommendation: MachineSizeInfo;
} {
  const rec = recommendForMachine();
  const config: PortpilotConfig = {
    ...current,
    version: CONFIG_VERSION,
    chromeDebugRange: current.chromeDebugRange ?? DEFAULT_CHROME_DEBUG_RANGE,
    appPortRange: current.appPortRange ?? DEFAULT_APP_PORT_RANGE,
    maxActiveLanes: current.maxActiveLanes ?? rec.recommendedMaxActiveLanes,
    warnAtActiveLanes: current.warnAtActiveLanes ?? rec.recommendedWarnAtActiveLanes,
  };
  return { config, recommendation: rec };
}

export class CapacityError extends Error {
  constructor(message: string, public readonly code: "MAX_ACTIVE_LANES_REACHED") {
    super(message);
    this.name = "CapacityError";
  }
}
