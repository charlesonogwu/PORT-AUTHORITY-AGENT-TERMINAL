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
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagedBinaryPath } from "../dashboard/launch.js";
import { installShortcut } from "./shortcut.js";
export const AUTOSTART_FILENAME = "Port Authority Agent Terminal.lnk";
function psSingle(s) {
    return `'${s.replace(/'/g, "''")}'`;
}
function runPowerShell(script) {
    return new Promise((resolve) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
        child.on("error", () => resolve({ ok: false, stderr: "spawn failed" }));
        child.on("close", (code) => resolve({ ok: code === 0, stderr }));
    });
}
/** Resolve `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`. */
async function resolveStartupFolder() {
    if (process.platform !== "win32")
        return "";
    return new Promise((resolve) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Startup')"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        child.stdout.on("data", (b) => { out += b.toString("utf8"); });
        child.on("error", () => resolve(""));
        child.on("close", () => resolve(out.trim()));
    });
}
async function autostartPaths() {
    const startup = await resolveStartupFolder();
    return {
        startup,
        shortcut: startup ? join(startup, AUTOSTART_FILENAME) : "",
        launcher: stagedBinaryPath(),
    };
}
/**
 * Resolve the icon for the autostart .lnk.
 *
 * Priority:
 *  (a) %LOCALAPPDATA%\PAAT\paat.ico — staged by installShortcut() before us.
 *      This path is stable; it survives npm cleaning up its temp clone dir.
 *  (b) <package-root>/assets/paat.ico — direct from the npm install location.
 *      Only reliable in dev mode (local checkout); for npm-from-github
 *      installs this lives under npm-cache/_cacache/tmp/git-cloneXXXX/ and
 *      gets deleted right after the install finishes. (This was the 0.2.0
 *      bug.)
 *  (c) Windows globe glyph fallback.
 *
 * installAutostart() already calls installShortcut() first when the binary
 * isn't staged, so by the time we get here option (a) almost always exists.
 * Options (b) and (c) are defense-in-depth.
 */
async function resolveBundledIcon() {
    // (a) Staged-next-to-binary path — stable across npm reinstalls.
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
        const staged = join(process.env.LOCALAPPDATA, "PAAT", "paat.ico");
        try {
            await access(staged);
            return staged;
        }
        catch { /* fall through */ }
    }
    // (b) In-package candidates (dev-checkout fallback).
    const here = fileURLToPath(import.meta.url);
    const candidates = [
        join(dirname(here), "..", "..", "..", "assets", "paat.ico"),
        join(dirname(here), "..", "..", "assets", "paat.ico"),
    ];
    for (const c of candidates) {
        try {
            await access(c);
            return c;
        }
        catch { /* try next */ }
    }
    // (c) Last-resort generic icon.
    return "C:\\Windows\\System32\\imageres.dll,109";
}
/**
 * Install the autostart entry. Idempotent — re-run to refresh.
 *
 * If the dashboard .exe doesn't exist yet (i.e. `paat shortcut install`
 * hasn't been run), this calls `installShortcut()` first as a side-effect
 * so the .exe gets staged.
 */
export async function installAutostart() {
    if (process.platform !== "win32") {
        throw new Error("paat autostart is currently Windows-only. " +
            "On macOS, add the dashboard to System Settings → General → Login Items, " +
            "or invoke `paat dashboard` from your shell's startup script.");
    }
    const paths = await autostartPaths();
    if (!paths.startup) {
        throw new Error("could not resolve %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup");
    }
    let launcherExists = false;
    try {
        await access(paths.launcher);
        launcherExists = true;
    }
    catch { /* missing */ }
    if (!launcherExists) {
        await installShortcut();
    }
    const iconLocation = await resolveBundledIcon();
    // .lnk points DIRECTLY at the Tauri paat-dashboard.exe. The .exe is built
    // with windows_subsystem = "windows", so it never flashes a console.
    const psScript = [
        `$WshShell = New-Object -ComObject WScript.Shell`,
        `$Shortcut = $WshShell.CreateShortcut(${psSingle(paths.shortcut)})`,
        `$Shortcut.TargetPath = ${psSingle(paths.launcher)}`,
        `$Shortcut.Arguments = ''`,
        `$Shortcut.WorkingDirectory = ${psSingle(dirname(paths.launcher))}`,
        `$Shortcut.IconLocation = ${psSingle(iconLocation)}`,
        `$Shortcut.Description = 'Auto-start the Port Authority Agent Terminal dashboard at login (paat autostart)'`,
        // 7 = "minimized" — back-compat noise since the .exe is GUI-subsystem.
        `$Shortcut.WindowStyle = 7`,
        `$Shortcut.Save()`,
    ].join("\n");
    const res = await runPowerShell(psScript);
    if (!res.ok) {
        throw new Error(`failed to install autostart entry: ${res.stderr.trim() || "(no stderr)"}`);
    }
    return paths;
}
export async function uninstallAutostart() {
    const paths = await autostartPaths();
    if (!paths.shortcut)
        return { removed: false, path: "" };
    let removed = false;
    try {
        await rm(paths.shortcut, { force: true });
        removed = true;
    }
    catch { /* ignore */ }
    return { removed, path: paths.shortcut };
}
export async function autostartStatus() {
    const paths = await autostartPaths();
    let installed = false;
    if (paths.shortcut) {
        try {
            await access(paths.shortcut);
            installed = true;
        }
        catch { /* not installed */ }
    }
    return { startup: paths.startup, shortcut: paths.shortcut, installed };
}
