/**
 * Spawn the Tauri-based paat-dashboard binary.
 *
 * Replaces the old Express + Chrome --app= server in src/dashboard/server.ts.
 * The Tauri binary IS the dashboard — it ships its own WebView2 (Windows) /
 * WKWebView (macOS) / WebKitGTK (Linux) and talks to the lane registry
 * directly via Tauri IPC. No HTTP server, no port binding, no localhost.
 *
 * Binary resolution order (per platform):
 *   1. %LOCALAPPDATA%\PAAT\paat-dashboard.exe  (Windows, staged by postinstall)
 *   2. ~/.portpilot/bin/paat-dashboard         (macOS/Linux, staged by postinstall)
 *   3. <pkg-root>/bin/<platform-binary>        (npm install location, fallback)
 *   4. throw — user needs to run `paat dashboard-install` or rebuild
 *
 * Naming conventions match scripts/build-dashboard-tauri.cjs:
 *   Windows: paat-dashboard.exe
 *   macOS:   paat-dashboard-darwin-<arch>
 *   Linux:   paat-dashboard-linux-<arch>
 *
 * Single-instance handling is done by the Tauri binary itself
 * (tauri-plugin-single-instance) — a second spawn brings the existing
 * window forward instead of opening a duplicate, so we can safely spawn
 * whenever the user runs `paat dashboard` without worrying about leaks.
 */
/** Filename of the platform-specific Tauri binary inside <pkg>/bin/. */
export declare function bundledBinaryName(): string;
/** Filename of the staged binary inside the user-data dir. We strip the
 *  per-platform suffix on Mac/Linux so the staged copy has a stable name
 *  that shortcut.ts / autostart.ts can point at. */
export declare function stagedBinaryName(): string;
/** Directory where the binary is staged for shortcuts to point at. */
export declare function stagedBinaryDir(): string;
/** Full path to the staged binary. */
export declare function stagedBinaryPath(): string;
/** Locate the bundled binary inside the installed npm package. Tries
 *  dist-relative + src-relative paths so it works in both production
 *  (npm-global install) and dev (tsx running from src/). */
export declare function resolveBundledBinary(): Promise<string | null>;
/** Pick a binary to spawn. Prefers the staged copy (stable path, survives
 *  npm upgrades) over the bundled copy (which moves around). */
export declare function resolveDashboardBinary(): Promise<string | null>;
export interface LaunchResult {
    ok: boolean;
    binary: string;
    pid?: number;
    error?: string;
}
/** Spawn the dashboard. Detaches the child so the CLI can exit immediately
 *  without killing the GUI. The Tauri binary's single-instance plugin
 *  handles the "already running" case by focusing the existing window. */
export declare function launchDashboard(): Promise<LaunchResult>;
