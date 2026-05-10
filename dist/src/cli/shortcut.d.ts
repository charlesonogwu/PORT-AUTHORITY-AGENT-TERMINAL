/**
 * Cross-platform desktop-shortcut installer for the portpilot dashboard.
 *
 * Today this only implements Windows (the only platform the user asked for).
 * macOS .app and Linux .desktop builds are pluggable behind the same CLI.
 */
export declare const DEFAULT_DASHBOARD_PORT = 7321;
export declare const SHORTCUT_FILENAME = "portpilot.lnk";
export declare const LAUNCHER_FILENAME = "launch-dashboard.ps1";
export interface ShortcutPaths {
    shortcut: string;
    launcher: string;
    desktop: string;
    home: string;
}
/** Synchronous best-guess fallback. install() prefers the PowerShell-resolved
 *  path so it handles OneDrive-redirected Desktops correctly. */
export declare function shortcutPaths(): ShortcutPaths;
/** Generates the launch-dashboard.ps1 contents, baking in absolute paths so
 *  the user's PATH does not matter at click-time.
 *
 *  Single-instance guarantees this script enforces:
 *    1. Named mutex around the whole launch flow. Concurrent shortcut
 *       clicks block until the first finishes, so two fast clicks can't
 *       both decide "no chrome yet, spawn one" and double-up.
 *    2. After spawning chrome, we hold the mutex until chrome's main
 *       window handle becomes observable (or 8s timeout). The next click
 *       then sees the just-opened window and focuses it instead of
 *       spawning another.
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
/** Install the desktop shortcut + launcher script. Idempotent (overwrites). */
export declare function installShortcut(opts?: {
    port?: number;
    iconLocation?: string;
}): Promise<ShortcutPaths>;
/** Remove the desktop shortcut + launcher script + Start Menu folder. */
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
