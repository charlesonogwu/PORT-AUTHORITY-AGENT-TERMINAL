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

export interface HideResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

/** Polled every 2s by the main dashboard loop. */
export async function getSnapshot(): Promise<DashboardSnapshot> {
  return await invoke<DashboardSnapshot>("get_snapshot");
}

/** Bring a Chrome window owned by a known PID to the foreground. */
export async function focusChrome(pid: number): Promise<FocusResult> {
  return await invoke<FocusResult>("focus_chrome", { pid });
}

/** Minimize / hide a Chrome window owned by a known PID. */
export async function hideChrome(pid: number): Promise<HideResult> {
  return await invoke<HideResult>("hide_chrome", { pid });
}

/** Terminate a Chrome process by PID (only allowed if it has our user-data-dir). */
export async function killChrome(pid: number): Promise<KillResult> {
  return await invoke<KillResult>("kill_chrome", { pid });
}
