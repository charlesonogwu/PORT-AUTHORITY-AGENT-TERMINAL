import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { totalmem } from "node:os";
import { DEFAULT_APP_PORT_RANGE, DEFAULT_CHROME_DEBUG_RANGE, validatePortRange, } from "./lane.js";
import { atomicWriteJson } from "./lockfile.js";
import { portpilotHome } from "./paths.js";
export const CONFIG_VERSION = 1;
export const DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    chromeDebugRange: DEFAULT_CHROME_DEBUG_RANGE,
    appPortRange: DEFAULT_APP_PORT_RANGE,
};
export function configPath() {
    return join(portpilotHome(), "config.json");
}
function validateConfig(cfg) {
    if (cfg.chromeDebugRange)
        validatePortRange(cfg.chromeDebugRange, "browser debug");
    if (cfg.appPortRange)
        validatePortRange(cfg.appPortRange, "app");
    return cfg;
}
export async function loadConfig() {
    try {
        const raw = await readFile(configPath(), "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== CONFIG_VERSION) {
            return { ...DEFAULT_CONFIG };
        }
        return validateConfig({ ...DEFAULT_CONFIG, ...parsed, version: CONFIG_VERSION });
    }
    catch (err) {
        if (err.code === "ENOENT")
            return { ...DEFAULT_CONFIG };
        throw err;
    }
}
export async function saveConfig(cfg) {
    await atomicWriteJson(configPath(), validateConfig({ ...cfg, version: CONFIG_VERSION }));
    // touch a noop just to keep API symmetric with future writes
    void writeFile;
}
/**
 * Heuristic that turns a host's total RAM into a sensible ceiling for the
 * number of simultaneous Chrome lanes it can handle without thrashing.
 *
 * Assumptions per Chrome instance: ~350 MB headless / ~700 MB headed.
 * We pick a midway 500 MB, then reserve 35% of total RAM for the OS,
 * background apps, and the agent desktop apps themselves.
 */
export function recommendForMachine(totalRamBytesArg = totalmem()) {
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
        reasoning: `total ${Math.round(totalGb)}GB - ${Math.round(reservedGb)}GB reserved (OS + agent apps) ` +
            `= ${Math.round(availableGb)}GB / 0.5GB-per-chrome ≈ ${raw}, clamped to [2, 78]`,
    };
}
/**
 * Build a config object based on the host machine's RAM. Existing values
 * in `current` are preserved; only the missing knobs are filled in.
 */
export function configForMachine(current = { ...DEFAULT_CONFIG }) {
    const rec = recommendForMachine();
    const config = {
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
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "CapacityError";
    }
}
