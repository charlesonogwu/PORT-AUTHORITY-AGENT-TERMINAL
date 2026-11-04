// Tauri IPC wrappers replacing the old HTTP API calls.
//
// We mirror the existing TypeScript API response shapes (DashboardSnapshot,
// KillResult, FocusResult, HideResult) so React components don't need to
// change their consumption pattern — only the call sites flip from
// `fetch('/api/...').then(r => r.json())` to `invoke('command_name', args)`.

import { invoke } from "@tauri-apps/api/core";

import type { DashboardSnapshot, LiveSession } from "../types";

export interface LaneTarget {
  pid: number;
  laneId?: string;
  browser: "chrome" | "edge" | "firefox";
  chromeDebugPort: number;
  profileDir: string;
}

export function laneTarget(session: LiveSession): LaneTarget {
  return {
    pid: session.pid,
    laneId: session.laneId,
    browser: session.browser ?? "chrome",
    chromeDebugPort: session.chromeDebugPort,
    profileDir: session.chromeProfileDir,
  };
}

export interface KillResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export interface FocusResult {
  ok: boolean;
  pid?: number;
  error?: string;
  warning?: string;
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
  warning?: string;
}

/** Polled every 2s by the main dashboard loop. */
export async function getSnapshot(): Promise<DashboardSnapshot> {
  return await invoke<DashboardSnapshot>("get_snapshot");
}

export interface RuntimeStatus {
  ok: boolean;
  provider: "installed" | "unavailable" | "cli";
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

/** Send only the displayed lane identity, optional exact tab, and Mac start hint. */
function actionArgs(session: LiveSession) {
  return { target: laneTarget(session), processStart: session.processStart ?? null };
}
export async function focusChrome(session: LiveSession, tabId?: string): Promise<FocusResult> {
  return invoke("focus_chrome", { ...actionArgs(session), tabId: tabId ?? null });
}
export async function hideChrome(session: LiveSession): Promise<HideResult> {
  return invoke("hide_chrome", actionArgs(session));
}
export async function unhideChrome(session: LiveSession, placement?: WindowPlacement | null, tabId?: string): Promise<UnhideResult> {
  return invoke("unhide_chrome", { ...actionArgs(session), placement: placement ?? { showCmd: 1, left: 80, top: 80, right: 1360, bottom: 1080 }, tabId: tabId ?? null });
}
export async function setHiddenTargets(sessions: LiveSession[]): Promise<void> {
  await invoke("set_hidden_targets", { targets: sessions.map(laneTarget) });
}
export async function killChrome(session: LiveSession): Promise<KillResult> {
  return invoke("kill_chrome", actionArgs(session));
}
export interface EraseResult { ok: boolean; removedProfile?: boolean; removedLane?: boolean; error?: string; }
export async function eraseChrome(session: LiveSession): Promise<EraseResult> {
  return invoke("erase_chrome", actionArgs(session));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
