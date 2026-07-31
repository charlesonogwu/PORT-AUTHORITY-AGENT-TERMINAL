import { type ChildProcess } from "node:child_process";
import { Lane } from "./lane.js";
import { PortObservation } from "./scanner.js";
/**
 * Decision returned by the Chrome safety check.
 *
 * - `safe-free`           — port is free; lane may launch its own Chrome.
 * - `safe-attach`         — port is occupied by Chrome whose --user-data-dir
 *                           matches the lane's profile, so the lane may attach.
 * - `unsafe-foreign-chrome` — port is occupied by Chrome but the profile does
 *                           not match this lane.
 * - `unsafe-unknown`      — port is occupied by a non-Chrome process, or by a
 *                           process we cannot identify.
 */
export type ChromeAttachVerdict = {
    kind: "safe-free";
    port: number;
} | {
    kind: "safe-attach";
    port: number;
    observation: PortObservation;
} | {
    kind: "unsafe-foreign-chrome";
    port: number;
    observation: PortObservation;
    foundProfile?: string;
} | {
    kind: "unsafe-unknown";
    port: number;
    observation: PortObservation;
};
export declare function isChromeProcess(o: PortObservation): boolean;
/**
 * Extract --user-data-dir from a process command line. Supports
 *   --user-data-dir=value
 *   --user-data-dir="value with spaces"
 *   --user-data-dir value
 */
export declare function extractUserDataDir(commandLine: string | undefined): string | undefined;
/**
 * Decide whether `lane` may safely attach to its Chrome debug port given the
 * current set of port observations. The rule mirrors the safety contract:
 *
 *   - free port                              → safe-free
 *   - Chrome with matching --user-data-dir   → safe-attach
 *   - Chrome with different --user-data-dir  → unsafe-foreign-chrome
 *   - non-Chrome / unidentifiable owner      → unsafe-unknown
 *
 * If the lane has no Chrome debug port assigned, it is treated as safe-free
 * for port `0` so callers can branch cleanly.
 */
export declare function evaluateChromeAttach(lane: Lane, observations: PortObservation[]): ChromeAttachVerdict;
/**
 * Chrome launch visibility mode.
 *
 *   - "visible"    — normal headed Chrome on the active desktop (default;
 *                    unchanged historical behaviour). Use for tasks that need
 *                    a human (login, captcha).
 *   - "background" — a REAL headed Chrome that renders fully off-screen and
 *                    never appears on the visible desktop. Cookies, extensions
 *                    and anti-bot fingerprint stay identical to a normal
 *                    browser (unlike headless, which many sites block), but no
 *                    window disturbs the user. Ideal for non-interactive CDP
 *                    automation.
 *   - "headless"   — `--headless=new`; no window at all. Lowest footprint, but
 *                    many sites (eBay, etc.) detect and block headless Chrome.
 */
export type ChromeLaunchMode = "visible" | "background" | "headless";
export declare const DEFAULT_CHROME_MODE: ChromeLaunchMode;
/**
 * Flags that push a headed Chrome window fully off the visible desktop.
 * -32000 is the position Windows itself parks minimized windows at, so it is
 * guaranteed to sit outside every real monitor on any multi-monitor layout.
 * The explicit size keeps the off-screen viewport big enough that responsive
 * layouts and lazy-loaded content render as they would on a normal display.
 */
export declare const OFFSCREEN_WINDOW_ARGS: readonly string[];
/**
 * Flags that harden a lane against Windows shell "URL-hijack" scenarios where
 * a URL the user clicks in an external app (Terminal, chat window, PDF) could
 * be routed to a PortPilot lane instead of a fresh default-profile browser.
 *
 * A dedicated --user-data-dir already gives per-profile isolation (Chromium's
 * process singleton is a file lock inside the user-data-dir), and in every
 * scenario we reproduced on Windows 11 with Edge 150 an external URL correctly
 * spawned a fresh default-profile browser rather than joining a PortPilot
 * lane. These flags are belt-and-suspenders on top of that:
 *
 *   --no-default-browser-check          (already set) suppresses the "make me
 *                                       default" prompt on first run.
 *   --disable-default-apps              stops Chrome/Edge from auto-installing
 *                                       the built-in "default web apps" pack
 *                                       (Adblock Plus in Edge, Docs offline in
 *                                       Chrome, etc.) into the lane's profile
 *                                       — those install pages showing up in
 *                                       the CDP tab list is the visible
 *                                       symptom that looks like a "URL joined
 *                                       my lane" report.
 *   --no-service-autorun                opts out of Windows Service Autorun
 *                                       registration (Chromium may otherwise
 *                                       register a background updater/handler
 *                                       under the running profile).
 *   --disable-background-networking     stops the Google Update / Edge
 *                                       Autofill background pings that also
 *                                       touch the profile's cookie jar.
 *
 * We do NOT touch tools/probes (--enable-automation stays off; agents may
 * want it and can pass it via extraArgs).
 */
export declare const HARDENING_ARGS: readonly string[];
/** Coerce an arbitrary value into a ChromeLaunchMode, or undefined if it is
 *  not one of the three recognised modes (case-insensitive, trimmed). */
export declare function normalizeChromeMode(value: unknown): ChromeLaunchMode | undefined;
/**
 * Resolve the effective launch mode using the precedence:
 *
 *   per-call argument  >  PORTPILOT_CHROME_MODE env var  >  config  >  visible
 *
 * The env var lets a user flip every launch on a machine to background mode
 * without touching config, and a per-call `mode` always wins so an agent can
 * still force a visible window for a login step even when the global default
 * is background. `envMode` is injectable for tests.
 */
export declare function resolveChromeMode(perCall?: unknown, configMode?: unknown, envMode?: string | undefined): ChromeLaunchMode;
/** The extra Chrome flags implied by a launch mode. */
export declare function modeLaunchArgs(mode: ChromeLaunchMode): string[];
export interface LaunchChromeOptions {
    detached?: boolean;
    extraArgs?: string[];
    binaryPath?: string;
    /** When true, skip launching and just return the resolved command + args. */
    dryRun?: boolean;
    /**
     * Launch visibility. Defaults to "visible". See ChromeLaunchMode. The mode's
     * flags are injected ahead of `extraArgs` (and always before `initialUrl`).
     */
    mode?: ChromeLaunchMode;
    /**
     * Optional URL to open as the first tab. Passed as the trailing positional
     * argument to chrome.exe so Chrome navigates immediately on startup —
     * avoiding a separate CDP round-trip.
     */
    initialUrl?: string;
}
export interface LaunchPlan {
    binary: string;
    args: string[];
    profileDir: string;
    port: number;
}
/** Candidate Chrome-family binaries on macOS. Kept pure so discovery can be
 * tested without inspecting a developer's actual Applications folders. */
export declare function macOsChromeCandidates(home?: string): string[];
/**
 * Returns true iff `p` looks like a Chromium-family browser binary by its
 * basename (case-insensitive). Used to gate caller-supplied `binaryPath`
 * values that come in via the MCP `launch_chrome_lane` / `open` tools.
 */
export declare function isChromeBinaryPath(p: string | undefined): boolean;
/**
 * Returns true iff `url` is a value safe to pass as Chrome's startup URL
 * positional argument. Refuses anything starting with `-` (Chrome treats
 * `-flag` and `--flag` as flags regardless of argv position) or any scheme
 * not in the explicit allowlist. This blocks injection like
 *   url = "--load-extension=C:\evil"
 *   url = "--proxy-server=http://attacker"
 *   url = "--disable-web-security"
 * which a malicious MCP agent could otherwise smuggle through the `open`
 * tool to subvert the launched Chrome.
 */
export declare function isSafeInitialUrl(url: string | undefined): boolean;
export declare class UnsafeChromeArgError extends Error {
    constructor(message: string);
}
export declare class BrowserBinaryNotFoundError extends Error {
    constructor(browser: string, candidates: string[]);
}
export declare function assertBrowserBinaryAvailable(binary: string, browser: string): void;
export declare function resolveChromeBinary(explicit?: string): string;
/**
 * Build the Chrome launch command for a lane. We always pass:
 *   --remote-debugging-port=<port>
 *   --user-data-dir=<profile>
 *   --no-first-run --no-default-browser-check
 * which together guarantee an isolated, attachable browser instance.
 *
 * If `initialUrl` is supplied it MUST pass `isSafeInitialUrl`, otherwise we
 * throw `UnsafeChromeArgError`. This is what stops an MCP agent from
 * smuggling `--load-extension=...` into the launch by labelling it as a
 * URL.
 */
export declare function buildLaunchPlan(lane: Lane, opts?: LaunchChromeOptions): LaunchPlan;
export interface LaunchResult {
    pid?: number;
    binary: string;
    args: string[];
    spawned: boolean;
    /** The visibility mode the lane was launched with. */
    mode: ChromeLaunchMode;
}
export declare class BrowserLaunchError extends Error {
    constructor(browser: string, binary: string, cause: unknown);
}
export declare function waitForChildSpawn(child: ChildProcess, browser: string, binary: string): Promise<void>;
/**
 * Launch Chrome for the lane. Caller must ensure `evaluateChromeAttach`
 * returned `safe-free` first. We do not enforce that here because callers may
 * have already decided to attach to a `safe-attach` instance instead.
 *
 * Hybrid background strategy: we spawn Chrome directly (so the returned pid is
 * the real Chrome pid the dashboard + kill button can use) and rely on the
 * off-screen `--window-position` flags plus Windows' foreground lock to keep
 * the window invisible and non-activating. No `cmd /c start /min` shim — that
 * would hand us the shim's short-lived pid instead of Chrome's.
 */
export declare function launchChromeForLane(lane: Lane, opts?: LaunchChromeOptions): Promise<LaunchResult>;
