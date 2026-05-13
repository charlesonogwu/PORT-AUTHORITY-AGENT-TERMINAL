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
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portpilotHome } from "../core/paths.js";
import { installShortcut, LAUNCHER_EXE_FILENAME } from "./shortcut.js";
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
    // The launcher lives at %LOCALAPPDATA%\PAAT\paat-launcher.exe — same
    // location shortcut.ts stages it to. Fall back to portpilotHome() when
    // LOCALAPPDATA isn't set (e.g. on macOS / non-Windows for type-checking).
    const launcherDir = process.env.LOCALAPPDATA ?? portpilotHome();
    return {
        startup,
        shortcut: startup ? join(startup, AUTOSTART_FILENAME) : "",
        launcher: join(launcherDir, "PAAT", LAUNCHER_EXE_FILENAME),
    };
}
/**
 * Locate the bundled `assets/paat.ico` — same lookup pattern shortcut.ts
 * uses, kept local so we don't add a new export there.
 */
async function resolveBundledIcon() {
    const here = fileURLToPath(import.meta.url);
    const candidates = [
        // dist/src/cli/autostart.js → ../../../assets/paat.ico (when running from dist)
        join(dirname(here), "..", "..", "..", "assets", "paat.ico"),
        // src/cli/autostart.ts → ../../assets/paat.ico (dev / tsx)
        join(dirname(here), "..", "..", "assets", "paat.ico"),
    ];
    for (const c of candidates) {
        try {
            await access(c);
            return c;
        }
        catch { /* try next */ }
    }
    return "C:\\Windows\\System32\\imageres.dll,109";
}
/**
 * Install the autostart entry. Idempotent — re-run to refresh the launcher
 * path (e.g. after upgrading Node or moving the install).
 *
 * If the launcher script doesn't exist yet (i.e. `paat shortcut install`
 * hasn't been run), this calls `installShortcut()` first as a side-effect
 * so the launcher gets generated.
 */
export async function installAutostart() {
    if (process.platform !== "win32") {
        throw new Error("paat autostart is currently Windows-only.");
    }
    const paths = await autostartPaths();
    if (!paths.startup) {
        throw new Error("could not resolve %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup");
    }
    // Ensure the launcher .exe has been staged to %LOCALAPPDATA%\PAAT\ by
    // calling installShortcut() — it copies the bundled bin/paat-launcher.exe
    // into place AND creates the desktop shortcut as a side effect (idempotent).
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
    // .lnk now points DIRECTLY at the native paat-launcher.exe. The .exe is
    // a GUI-subsystem build, so it never flashes a console window. No more
    // PowerShell middleman.
    const psScript = [
        `$WshShell = New-Object -ComObject WScript.Shell`,
        `$Shortcut = $WshShell.CreateShortcut(${psSingle(paths.shortcut)})`,
        `$Shortcut.TargetPath = ${psSingle(paths.launcher)}`,
        `$Shortcut.Arguments = ''`,
        `$Shortcut.WorkingDirectory = ${psSingle(dirname(paths.launcher))}`,
        `$Shortcut.IconLocation = ${psSingle(iconLocation)}`,
        `$Shortcut.Description = 'Auto-start the Port Authority Agent Terminal dashboard at login (paat autostart)'`,
        // 7 = "minimized" — kept for back-compat; the .exe doesn't show a
        // window anyway since it's compiled with -H windowsgui.
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
