/**
 * Windows-login autostart for the portpilot dashboard.
 *
 * Mechanism: drop a `.lnk` shortcut into the per-user Startup folder
 * (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`). Windows runs
 * everything in there at login. The shortcut points DIRECTLY at the native
 * paat-launcher.exe (no PowerShell, no script — same change as the desktop
 * shortcut in v0.1.4) so the dashboard boots silently and quickly.
 *
 * Why a shortcut and not a Run-key registry entry:
 *   - Shortcuts are introspectable and easy to remove (drag to recycle bin).
 *   - The user sees them in Task Manager → Startup tab with a friendly name.
 *   - We avoid touching HKCU\...\Run, which AV vendors flag aggressively.
 *
 * The launcher .exe is staged into %LOCALAPPDATA%\PAAT\ by
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
 * Install the autostart entry. Idempotent — re-run to refresh the launcher
 * path (e.g. after upgrading Node or moving the install).
 *
 * If the launcher script doesn't exist yet (i.e. `paat shortcut install`
 * hasn't been run), this calls `installShortcut()` first as a side-effect
 * so the launcher gets generated.
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
