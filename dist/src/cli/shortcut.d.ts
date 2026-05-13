/**
 * Cross-platform desktop-shortcut installer for the portpilot dashboard.
 *
 * Today this only implements Windows (the only platform the user asked for).
 * macOS .app and Linux .desktop builds are pluggable behind the same CLI.
 *
 * v0.1.4 cutover: the shortcut now points DIRECTLY at a native Go-built
 * paat-launcher.exe (bundled in the package at bin/paat-launcher.exe) instead
 * of running a PowerShell script through powershell.exe. Single launcher,
 * real .exe, no PowerShell flash. The old launch-dashboard.ps1 is gone.
 */
export declare const DEFAULT_DASHBOARD_PORT = 7321;
export declare const SHORTCUT_FILENAME = "portpilot.lnk";
/**
 * Name of the legacy PowerShell launcher script created by versions ≤ 0.1.3.
 * We delete it on install/uninstall if found, so users upgrading from an
 * older version end up with a clean ~/.portpilot directory.
 */
export declare const LEGACY_LAUNCHER_FILENAME = "launch-dashboard.ps1";
/** Filename of the native Go-built launcher .exe bundled in bin/. */
export declare const LAUNCHER_EXE_FILENAME = "paat-launcher.exe";
export interface ShortcutPaths {
    shortcut: string;
    launcher: string;
    desktop: string;
    home: string;
}
/** Synchronous best-guess fallback. install() prefers the PowerShell-resolved
 *  path so it handles OneDrive-redirected Desktops correctly. */
export declare function shortcutPaths(): ShortcutPaths;
/**
 * Legacy PowerShell launcher script generator. Retained only as an exported
 * symbol so older test snapshots / external callers don't break, but no
 * production code path calls it anymore — the .lnk now points at the
 * native bin/paat-launcher.exe instead. This will be removed in v0.2.
 *
 * @deprecated Use the native Go launcher (bin/paat-launcher.exe). Do not
 *             generate, write, or rely on this PowerShell script.
 *
 * Historical context (kept for grep-ability):
 *  - Named mutex for single-instance behavior
 *  - healthz probe + orphan chrome kill
 *  - Find or spawn Chrome --app= window pointed at the dashboard
 * All of that lives in cmd/paat-launcher/main.go now.
 *    3. Detection only requires "any chrome.exe with our --user-data-dir";
 *       it doesn't require a main window yet. That handles the gap between
 *       chrome process start and first paint without false negatives.
 *
 *  Open behavior (after the mutex is held):
 *    1. ALWAYS probe http://127.0.0.1:<port>/healthz first. The presence of
 *       a chrome.exe with our profile is NOT proof the server is alive —
 *       a previous launch can leave the chrome window pointing at a now-dead
 *       server (e.g. node crashed at boot, or the baked path went stale).
 *    2. If healthz fails AND there are orphan chrome processes with our
 *       profile, kill them so we don't end up focusing a window that's
 *       sitting on a "127.0.0.1 refused to connect" error page.
 *    3. If healthz fails, start the server. Try the baked node + cliJs
 *       path first; if either is missing, fall back to `paat dashboard`
 *       resolved via Get-Command. Poll healthz (not a fixed sleep) until
 *       it answers 200 or we time out.
 *    4. Then either focus the existing chrome window, or spawn a new one.
 */
export declare function buildLauncherScript(opts: {
    node: string;
    cliJs: string;
    port: number;
}): string;
/** Install the desktop shortcut + native launcher .exe. Idempotent (overwrites). */
export declare function installShortcut(opts?: {
    port?: number;
    iconLocation?: string;
}): Promise<ShortcutPaths>;
/** Remove the desktop shortcut, native launcher .exe, the legacy .ps1, and Start Menu folder. */
export declare function uninstallShortcut(): Promise<{
    removedShortcut: boolean;
    removedLauncher: boolean;
}>;
/** Returns existence/health of the installed shortcut. */
export declare function shortcutStatus(): Promise<{
    shortcut: string;
    launcher: string;
    startMenu: string;
    shortcutExists: boolean;
    launcherExists: boolean;
    startMenuExists: boolean;
}>;
