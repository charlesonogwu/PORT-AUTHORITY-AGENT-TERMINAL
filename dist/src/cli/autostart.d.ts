/**
 * Windows-login autostart for the portpilot dashboard.
 *
 * Mechanism: drop a `.lnk` shortcut into the per-user Startup folder
 * (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`). Windows runs
 * everything in there at login. The shortcut points DIRECTLY at the Tauri
 * paat-dashboard.exe (no PowerShell, no Express server, no localhost) so
 * the dashboard boots silently.
 *
 * Why a shortcut and not a Run-key registry entry:
 *   - Shortcuts are introspectable and easy to remove (drag to recycle bin).
 *   - The user sees them in Task Manager → Startup tab with a friendly name.
 *   - We avoid touching HKCU\...\Run, which AV vendors flag aggressively.
 *
 * The dashboard .exe is staged into %LOCALAPPDATA%\PAAT\ by
 * `paat shortcut install`. If it's missing when `installAutostart()` runs,
 * we delegate to `installShortcut()` first so the .exe gets staged.
 */
export declare const AUTOSTART_FILENAME = "Port Authority Agent Terminal.lnk";
export interface AutostartPaths {
    startup: string;
    shortcut: string;
    launcher: string;
}
/**
 * Install the autostart entry. Idempotent — re-run to refresh.
 *
 * If the dashboard .exe doesn't exist yet (i.e. `paat shortcut install`
 * hasn't been run), this calls `installShortcut()` first as a side-effect
 * so the .exe gets staged.
 */
export declare function installAutostart(): Promise<AutostartPaths>;
export declare function uninstallAutostart(): Promise<{
    removed: boolean;
    path: string;
}>;
export declare function autostartStatus(): Promise<{
    startup: string;
    shortcut: string;
    installed: boolean;
}>;
