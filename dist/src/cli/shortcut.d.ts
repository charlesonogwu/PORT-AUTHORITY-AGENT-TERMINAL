/**
 * Cross-platform desktop-shortcut installer for the portpilot dashboard.
 *
 * v0.2.0 cutover: shortcut points DIRECTLY at the Tauri-built paat-dashboard
 * binary (bundled at bin/paat-dashboard.exe on Windows). No PowerShell
 * middleman, no Express server, no localhost. Tauri's single-instance
 * plugin handles the "already running" case server-side.
 *
 * Today this only implements Windows. macOS users get a `paat dashboard`
 * CLI command (via the `bin` entries in package.json) that spawns the
 * binary directly — no .app installer yet because shipping .app bundles
 * via npm is messy. Linux is in the same boat as macOS.
 */
export declare const DEFAULT_DASHBOARD_PORT = 7321;
export declare const SHORTCUT_FILENAME = "portpilot.lnk";
/**
 * Legacy launcher filenames cleaned up on (un)install. Versions ≤0.1.3 used
 * a PowerShell .ps1; 0.1.4 used a Go-built paat-launcher.exe. Both are gone
 * now — the shortcut targets the Tauri paat-dashboard.exe directly.
 */
export declare const LEGACY_LAUNCHER_FILENAME = "launch-dashboard.ps1";
export declare const LEGACY_GO_LAUNCHER_FILENAME = "paat-launcher.exe";
/** Filename of the bundled dashboard binary (re-export for callers that
 *  used to import LAUNCHER_EXE_FILENAME from this module). */
export declare const LAUNCHER_EXE_FILENAME: string;
export declare const DASHBOARD_EXE_FILENAME: string;
export interface ShortcutPaths {
    shortcut: string;
    launcher: string;
    desktop: string;
    home: string;
}
/** Synchronous best-guess fallback. install() prefers the PowerShell-resolved
 *  path so it handles OneDrive-redirected Desktops correctly. */
export declare function shortcutPaths(): ShortcutPaths;
/** Install the desktop shortcut + stage the bundled dashboard binary.
 *  Idempotent (overwrites). Windows-only currently. */
export declare function installShortcut(opts?: {
    port?: number;
    iconLocation?: string;
}): Promise<ShortcutPaths>;
/** Remove the desktop shortcut, staged dashboard .exe, legacy artifacts, and Start Menu folder. */
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
