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
}

/**
 * A window's saved Win32 placement, captured by `hide_chrome` so `unhide_chrome`
 * can restore it to exactly where it was. `showCmd` is the SW_* show-state the
 * window had before hiding (3 = maximized); the rect is the normal on-screen
 * rectangle in virtual-desktop coordinates.
 */
export interface WindowPlacement {
  showCmd: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface HideResult {
  ok: boolean;
  pid?: number;
  /** Present on Windows: the placement to pass back to `unhideChrome`. */
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

/** Bring a Chrome window owned by a known PID to the foreground. */
export async function focusChrome(session: LiveSession): Promise<FocusResult> {
  return await invoke<FocusResult>("focus_chrome", { target: laneTarget(session) });
}

/**
 * Persistently hide a Chrome window: move it fully off-screen and leave it
 * there (it stays invisible even when the driving agent keeps raising it).
 * Returns the window's original placement so a later `unhideChrome` can put it
 * back exactly where it was.
 */
export async function hideChrome(session: LiveSession): Promise<HideResult> {
  return await invoke<HideResult>("hide_chrome", { target: laneTarget(session) });
}

/** A sensible on-screen box used when no saved placement is available. */
const FALLBACK_PLACEMENT: WindowPlacement = {
  showCmd: 1,
  left: 80,
  top: 80,
  right: 80 + 1280,
  bottom: 80 + 1000,
};

/**
 * Bring a previously-hidden Chrome window back on-screen, restoring the saved
 * placement (position + maximized/normal state) captured at hide time. When no
 * placement is known (lost state), a fallback on-screen box is used so the
 * window can never come back invisibly off-screen.
 */
export async function unhideChrome(
  session: LiveSession,
  placement?: WindowPlacement | null,
): Promise<UnhideResult> {
  return await invoke<UnhideResult>("unhide_chrome", {
    target: laneTarget(session),
    placement: placement ?? FALLBACK_PLACEMENT,
  });
}

/**
 * Tell the native hide-watcher which pids must be kept off-screen. The watcher
 * thread (in the Rust shell) then shoves any on-screen window of these pids
 * off-screen within ~150ms of it appearing — catching sign-in popups and
 * restarted Chromes with no flash. The frontend recomputes + pushes this set
 * whenever the hidden lanes or their live pids change.
 */
export async function setHiddenTargets(sessions: LiveSession[]): Promise<void> {
  await invoke("set_hidden_targets", { targets: sessions.map(laneTarget) });
}

/** Terminate a browser only after its complete PortPilot lane identity is reverified. */
export async function killChrome(session: LiveSession): Promise<KillResult> {
  return await invoke<KillResult>("kill_chrome", { target: laneTarget(session) });
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
export async function eraseChrome(session: LiveSession): Promise<EraseResult> {
  return await invoke<EraseResult>("erase_chrome", { target: laneTarget(session) });
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
