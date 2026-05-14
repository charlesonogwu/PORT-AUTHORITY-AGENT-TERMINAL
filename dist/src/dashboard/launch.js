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
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { portpilotHome } from "../core/paths.js";
/** Filename of the platform-specific Tauri binary inside <pkg>/bin/. */
export function bundledBinaryName() {
    if (process.platform === "win32")
        return "paat-dashboard.exe";
    if (process.platform === "darwin")
        return `paat-dashboard-darwin-${process.arch}`;
    return `paat-dashboard-linux-${process.arch}`;
}
/** Filename of the staged binary inside the user-data dir. We strip the
 *  per-platform suffix on Mac/Linux so the staged copy has a stable name
 *  that shortcut.ts / autostart.ts can point at. */
export function stagedBinaryName() {
    return process.platform === "win32" ? "paat-dashboard.exe" : "paat-dashboard";
}
/** Directory where the binary is staged for shortcuts to point at. */
export function stagedBinaryDir() {
    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData)
            return join(localAppData, "PAAT");
    }
    // macOS / Linux: ~/.portpilot/bin/ — same root the CLI already uses.
    return join(portpilotHome(), "bin");
}
/** Full path to the staged binary. */
export function stagedBinaryPath() {
    return join(stagedBinaryDir(), stagedBinaryName());
}
/** Locate the bundled binary inside the installed npm package. Tries
 *  dist-relative + src-relative paths so it works in both production
 *  (npm-global install) and dev (tsx running from src/). */
export async function resolveBundledBinary() {
    const here = fileURLToPath(import.meta.url);
    const binaryName = bundledBinaryName();
    const candidates = [
        // dist/src/dashboard/launch.js → ../../../bin/<binary>
        resolve(dirname(here), "..", "..", "..", "bin", binaryName),
        // src/dashboard/launch.ts → ../../bin/<binary>
        resolve(dirname(here), "..", "..", "bin", binaryName),
    ];
    for (const c of candidates) {
        try {
            await access(c);
            return c;
        }
        catch { /* try next */ }
    }
    return null;
}
/** Pick a binary to spawn. Prefers the staged copy (stable path, survives
 *  npm upgrades) over the bundled copy (which moves around). */
export async function resolveDashboardBinary() {
    const staged = stagedBinaryPath();
    try {
        await access(staged);
        return staged;
    }
    catch { /* fall through */ }
    return resolveBundledBinary();
}
/** Spawn the dashboard. Detaches the child so the CLI can exit immediately
 *  without killing the GUI. The Tauri binary's single-instance plugin
 *  handles the "already running" case by focusing the existing window. */
export async function launchDashboard() {
    const binary = await resolveDashboardBinary();
    if (!binary) {
        return {
            ok: false,
            binary: "",
            error: `paat-dashboard binary not found. ` +
                `Run \`npm install -g port-authority-agent-terminal-mcp\` (Windows) ` +
                `or build it via \`cargo tauri build\` in gui/ (macOS/Linux).`,
        };
    }
    try {
        const child = spawn(binary, [], {
            detached: true,
            stdio: "ignore",
            windowsHide: false,
        });
        child.unref();
        return { ok: true, binary, pid: child.pid };
    }
    catch (err) {
        return {
            ok: false,
            binary,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
