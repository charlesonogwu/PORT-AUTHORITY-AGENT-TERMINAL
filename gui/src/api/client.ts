// Tauri IPC wrappers replacing the old HTTP API calls.
//
// We mirror the existing TypeScript API response shapes (DashboardSnapshot,
// KillResult, FocusResult, HideResult) so React components don't need to
// change their consumption pattern — only the call sites flip from
// `fetch('/api/...').then(r => r.json())` to `invoke('command_name', args)`.

import { invoke } from "@tauri-apps/api/core";

import type { DashboardSnapshot } from "../types";

export interface KillResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export interface FocusResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

/**
 * A window's saved Win32 placement, captured by `hide_chrome` so `unhide_chrome`
 * can restore it to exactly where it was. `showCmd` is the SW_* show-state the
 * window had before hiding (3 = maximized); the rect is the normal on-screen
 * rectangle in virtual-desktop coordinates.
 */
export interface WindowsWindowPlacement {
  showCmd: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MacWindowPlacement {
  platform: "macos";
  applicationHidden: true;
}

export type WindowPlacement = WindowsWindowPlacement | MacWindowPlacement;

export interface HideResult {
  ok: boolean;
  pid?: number;
  /** Native restore state returned by Hide and passed back to Unhide. */
  placement?: WindowPlacement | null;
  error?: string;
}

export interface UnhideResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

/** Polled every 2s by the main dashboard loop. */
export async function getSnapshot(): Promise<DashboardSnapshot> {
  return await invoke<DashboardSnapshot>("get_snapshot");
}

export interface RuntimeStatus {
  ok: boolean;
  provider: "installed" | "unavailable";
  error?: string;
  handshake?: {
    portpilotVersion: string;
    platform: string;
    architecture: string;
  };
}

/** Report whether the native shell accepted its explicitly configured runtime. */
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return await invoke<RuntimeStatus>("get_runtime_status");
}

/** Activate the displayed lane tab, then bring its verified browser PID forward. */
export async function focusChrome(
  laneId: string | undefined,
  pid: number,
  processStart = "",
  debugPort?: number,
  browser = "chrome",
  tabId?: string,
): Promise<FocusResult> {
  return await invoke<FocusResult>("focus_chrome", {
    laneId: laneId ?? "",
    pid,
    processStart,
    tab: tabId && debugPort ? { debugPort, browser, tabId } : null,
  });
}

/**
 * Persistently hide a browser with the platform's native implementation.
 * Returns any captured placement plus the platform's restore mode so a later
 * `unhideChrome` can safely reverse the same operation.
 */
export async function hideChrome(laneId: string | undefined, pid: number, processStart = ""): Promise<HideResult> {
  return await invoke<HideResult>("hide_chrome", { laneId: laneId ?? "", pid, processStart });
}

/** A sensible on-screen box used when no saved placement is available. */
const FALLBACK_PLACEMENT: WindowsWindowPlacement = {
  showCmd: 1,
  left: 80,
  top: 80,
  right: 80 + 1280,
  bottom: 80 + 1000,
};

/**
 * Bring a previously-hidden browser back on-screen, restoring the saved native
 * placement when available. Windows uses a fallback on-screen box when no
 * saved placement is known; macOS returns its explicit restore mode from Hide.
 */
export async function unhideChrome(
  laneId: string | undefined,
  pid: number,
  processStart: string,
  placement?: WindowPlacement | null,
  debugPort?: number,
  browser = "chrome",
  tabId?: string,
): Promise<UnhideResult> {
  return await invoke<UnhideResult>("unhide_chrome", {
    laneId: laneId ?? "",
    pid,
    processStart,
    placement: placement ?? FALLBACK_PLACEMENT,
    tab: tabId && debugPort ? { debugPort, browser, tabId } : null,
  });
}

/**
 * Tell the native hide watcher which exact browser processes must remain
 * hidden. The frontend recomputes this set whenever a hidden lane restarts.
 */
export async function setHiddenProcesses(targets: Array<{ pid: number; processStart: string }>): Promise<void> {
  await invoke("set_hidden_processes", { targets });
}

/** Terminate a Chrome process by PID (only allowed if it has our user-data-dir). */
export async function killChrome(laneId: string | undefined, pid: number, processStart = ""): Promise<KillResult> {
  return await invoke<KillResult>("kill_chrome", { laneId: laneId ?? "", pid, processStart });
}

export interface EraseResult {
  ok: boolean;
  removedProfile?: boolean;
  removedLane?: boolean;
  error?: string;
}

/**
 * Erase a lane's saved browser data: closes the Chrome pid, then deletes its
 * profile directory (logins, cookies, history) and drops the lane. Unlike
 * `killChrome`, this does NOT preserve the login — the next open is a fresh,
 * logged-out browser. Irreversible; the UI must confirm before calling it.
 */
export async function eraseChrome(
  pid: number,
  processStart: string,
  profileDir: string,
  laneId?: string,
): Promise<EraseResult> {
  return await invoke<EraseResult>("erase_chrome", { pid, processStart, profileDir, laneId });
}

export type DefaultBrowser = "chrome" | "edge" | "firefox"

export interface GetConfigResult {
  ok: boolean
  config: { version?: number; defaultBrowser?: DefaultBrowser } & Record<string, unknown>
}

/** Read ~/.portpilot/config.json (defaults when absent). */
export async function getConfig(): Promise<GetConfigResult> {
  return await invoke<GetConfigResult>("get_config")
}

/**
 * Persist the "Default browser" pick. Applies to NEW lanes created by agent
 * calls that don't name a browser; an explicit per-call browser always wins,
 * and existing lanes keep the browser they were created with.
 */
export async function setDefaultBrowser(
  browser: DefaultBrowser,
): Promise<{ ok: boolean; defaultBrowser: DefaultBrowser }> {
  return await invoke("set_default_browser", { browser })
}
