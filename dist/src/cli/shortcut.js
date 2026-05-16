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
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bundledBinaryName, resolveBundledBinary, stagedBinaryDir, stagedBinaryName, stagedBinaryPath, } from "../dashboard/launch.js";
import { portpilotHome } from "../core/paths.js";
export const DEFAULT_DASHBOARD_PORT = 7321; // legacy export; unused since 0.2.0
export const SHORTCUT_FILENAME = "portpilot.lnk";
/**
 * Legacy launcher filenames cleaned up on (un)install. Versions ≤0.1.3 used
 * a PowerShell .ps1; 0.1.4 used a Go-built paat-launcher.exe. Both are gone
 * now — the shortcut targets the Tauri paat-dashboard.exe directly.
 */
export const LEGACY_LAUNCHER_FILENAME = "launch-dashboard.ps1";
export const LEGACY_GO_LAUNCHER_FILENAME = "paat-launcher.exe";
/** Filename of the bundled dashboard binary (re-export for callers that
 *  used to import LAUNCHER_EXE_FILENAME from this module). */
export const LAUNCHER_EXE_FILENAME = stagedBinaryName();
export const DASHBOARD_EXE_FILENAME = stagedBinaryName();
/** Synchronous best-guess fallback. install() prefers the PowerShell-resolved
 *  path so it handles OneDrive-redirected Desktops correctly. */
export function shortcutPaths() {
    const desktop = process.env.USERPROFILE
        ? join(process.env.USERPROFILE, "Desktop")
        : join(homedir(), "Desktop");
    return {
        desktop,
        shortcut: join(desktop, SHORTCUT_FILENAME),
        launcher: stagedBinaryPath(),
        home: portpilotHome(),
    };
}
/** Asks Windows for the canonical Desktop folder, which on most modern
 *  installs is redirected to OneDrive. Falls back to USERPROFILE\Desktop. */
async function resolveDesktopFolder() {
    if (process.platform !== "win32") {
        return shortcutPaths().desktop;
    }
    return new Promise((resolve) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Desktop')"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
        child.on("error", () => resolve(shortcutPaths().desktop));
        child.on("close", () => {
            const trimmed = stdout.trim();
            resolve(trimmed.length > 0 ? trimmed : shortcutPaths().desktop);
        });
    });
}
/** PowerShell single-quote: escapes embedded single quotes by doubling them. */
function psSingle(s) {
    return `'${s.replace(/'/g, "''")}'`;
}
/**
 * Stage the bundled paat-dashboard binary into a stable per-user location
 * (Windows: %LOCALAPPDATA%\PAAT\, macOS/Linux: ~/.portpilot/bin/) so the
 * shortcut has a target path that survives npm reinstalls and upgrades.
 *
 * If a previous copy is locked (the dashboard is currently running), we
 * keep the previously-installed copy instead of failing — the old version
 * works fine, the upgrade just lags until the user closes + reopens.
 */
async function stageDashboardBinary() {
    const source = await resolveBundledBinary();
    if (!source) {
        throw new Error(`bundled ${bundledBinaryName()} not found in package. ` +
            `Reinstall via npm, or rebuild via \`npm run build:dashboard\` in a local dev checkout.`);
    }
    const destDir = stagedBinaryDir();
    const destPath = stagedBinaryPath();
    await mkdir(destDir, { recursive: true });
    try {
        await rm(destPath, { force: true });
    }
    catch { /* ignore */ }
    try {
        await copyFile(source, destPath);
    }
    catch (err) {
        const code = err.code;
        if (code === "EBUSY")
            return destPath; // existing copy still works
        throw err;
    }
    // chmod +x on Unix so the launcher can spawn it.
    if (process.platform !== "win32") {
        const { chmod } = await import("node:fs/promises");
        try {
            await chmod(destPath, 0o755);
        }
        catch { /* ignore */ }
    }
    return destPath;
}
/**
 * Stage the bundled paat.ico next to the dashboard binary so the shortcut's
 * IconLocation has a stable path that survives npm's cleanup of its temp
 * git-clone directory.
 *
 * 0.2.0 BUG (fixed here in 0.2.1): the previous code pointed the .lnk's
 * IconLocation at `<package-root>/assets/paat.ico`. During a github install,
 * <package-root> is `%LOCALAPPDATA%\npm-cache\_cacache\tmp\git-cloneXXXX\`,
 * which npm DELETES after install finishes. Result: Windows can't find the
 * icon → falls back to the generic blank-document icon on the shortcut.
 *
 * Returns the staged path on success, or null if the source .ico couldn't be
 * located. The fallback case is handled by the caller, which uses
 * imageres.dll as a last-resort generic icon.
 */
async function stageIcon() {
    const source = await resolveBundledIcon();
    if (!source)
        return null;
    const destDir = stagedBinaryDir();
    const destPath = join(destDir, "paat.ico");
    await mkdir(destDir, { recursive: true });
    try {
        await rm(destPath, { force: true });
    }
    catch { /* ignore */ }
    try {
        await copyFile(source, destPath);
    }
    catch {
        // Best-effort: if we can't copy (e.g. EBUSY because it's in use), and
        // a previous copy still exists, use that. Otherwise fall back to the
        // source path even though it may go stale.
        if (await fileExists(destPath))
            return destPath;
        return source;
    }
    return destPath;
}
/** Helper: returns true iff path exists and is accessible. */
async function fileExists(p) {
    try {
        await access(p);
        return true;
    }
    catch {
        return false;
    }
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
/** Install the desktop shortcut + stage the bundled dashboard binary.
 *  Idempotent (overwrites). Windows-only currently. */
export async function installShortcut(opts = {}) {
    if (process.platform !== "win32") {
        throw new Error(`portpilot shortcut is currently Windows-only. ` +
            `On macOS/Linux, use \`paat dashboard\` to launch the Tauri app from your terminal, ` +
            `or pin its binary to your dock manually (${stagedBinaryPath()}).`);
    }
    // `port` is no longer consumed — Tauri doesn't use ports — but we keep the
    // option in the API for back-compat with callers built against 0.1.x.
    void (opts.port ?? DEFAULT_DASHBOARD_PORT);
    const desktop = await resolveDesktopFolder();
    const paths = {
        desktop,
        shortcut: join(desktop, SHORTCUT_FILENAME),
        launcher: stagedBinaryPath(),
        home: portpilotHome(),
    };
    // 1. Stage the bundled dashboard binary into %LOCALAPPDATA%\PAAT\. This
    //    is what the .lnk will point at, so it has to exist before we create
    //    the shortcut.
    const dashboardExe = await stageDashboardBinary();
    paths.launcher = dashboardExe;
    // 1b. Clean up legacy launcher artifacts (PowerShell ps1 + Go .exe) so
    //     the user's ~/.portpilot directory is tidy after upgrading.
    try {
        await rm(join(portpilotHome(), LEGACY_LAUNCHER_FILENAME), { force: true });
    }
    catch { /* ignore */ }
    try {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData) {
            await rm(join(localAppData, "PAAT", LEGACY_GO_LAUNCHER_FILENAME), { force: true });
        }
    }
    catch { /* ignore — may be locked */ }
    // 1c. Resolve the icon. Priority:
    //   (a) caller override
    //   (b) the bundled paat.ico, COPIED into %LOCALAPPDATA%\PAAT\ so the path
    //       baked into the .lnk survives npm cleaning up its temp clone dir
    //       (0.2.0 bug: shortcut icon path pointed at npm-cache/_cacache/tmp/)
    //   (c) Windows globe glyph fallback
    const iconLocation = opts.iconLocation ?? (await stageIcon()) ?? "C:\\Windows\\System32\\imageres.dll,109";
    // 2. Create the .lnk via WScript.Shell COM, pointing DIRECTLY at the
    //    Tauri .exe. No PowerShell middleman, no execution-policy dance,
    //    no console window flash.
    const psScript = [
        `$WshShell = New-Object -ComObject WScript.Shell`,
        `$Shortcut = $WshShell.CreateShortcut(${psSingle(paths.shortcut)})`,
        `$Shortcut.TargetPath = ${psSingle(dashboardExe)}`,
        `$Shortcut.Arguments = ''`,
        `$Shortcut.WorkingDirectory = ${psSingle(dirname(dashboardExe))}`,
        `$Shortcut.IconLocation = ${psSingle(iconLocation)}`,
        `$Shortcut.Description = 'Open the Port Authority Agent Terminal dashboard'`,
        `$Shortcut.Save()`,
    ].join("\n");
    const res = await runPowerShell(psScript);
    if (!res.ok) {
        throw new Error(`failed to create shortcut via PowerShell: ${res.stderr.trim() || "(no stderr)"}`);
    }
    // 3. Mirror into Start Menu so Windows Search indexes it.
    await installStartMenuShortcut({ paths, iconLocation, launcherExe: dashboardExe });
    return paths;
}
/** Locate the bundled paat.ico shipped with the package. */
async function resolveBundledIcon() {
    // dist/src/cli/shortcut.js → ../../../assets/paat.ico (running from dist)
    // src/cli/shortcut.ts      → ../../assets/paat.ico    (dev mode via tsx)
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(import.meta.url);
    const candidates = [
        here.replace(/[\\/]dist[\\/]src[\\/]cli[\\/]shortcut\.(?:js|ts)$/, "/assets/paat.ico"),
        here.replace(/[\\/]src[\\/]cli[\\/]shortcut\.(?:js|ts)$/, "/assets/paat.ico"),
    ];
    for (const c of candidates) {
        try {
            await access(c);
            return c;
        }
        catch { /* ignore */ }
    }
    return null;
}
/** Returns `%APPDATA%\Microsoft\Windows\Start Menu\Programs`. */
async function startMenuFolder() {
    if (process.platform !== "win32")
        return "";
    return new Promise((resolve) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('Programs')"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
        child.on("error", () => resolve(""));
        child.on("close", () => resolve(stdout.trim()));
    });
}
/** Place a copy of the shortcut into the Start Menu folder so Windows
 *  Search indexes it. The Start Menu folder is auto-indexed; the Desktop
 *  is not, on most installs. */
async function installStartMenuShortcut(args) {
    const programs = await startMenuFolder();
    if (!programs)
        return;
    const subfolder = join(programs, "Port Authority Agent Terminal");
    await mkdir(subfolder, { recursive: true });
    const startMenuLnk = join(subfolder, "Port Authority Agent Terminal.lnk");
    const psScript = [
        `$WshShell = New-Object -ComObject WScript.Shell`,
        `$Shortcut = $WshShell.CreateShortcut(${psSingle(startMenuLnk)})`,
        `$Shortcut.TargetPath = ${psSingle(args.launcherExe)}`,
        `$Shortcut.Arguments = ''`,
        `$Shortcut.WorkingDirectory = ${psSingle(dirname(args.launcherExe))}`,
        `$Shortcut.IconLocation = ${psSingle(args.iconLocation)}`,
        `$Shortcut.Description = 'Open the Port Authority Agent Terminal dashboard'`,
        `$Shortcut.Save()`,
    ].join("\n");
    await runPowerShell(psScript);
}
/** Remove the desktop shortcut, staged dashboard .exe, legacy artifacts, and Start Menu folder. */
export async function uninstallShortcut() {
    const desktop = await resolveDesktopFolder();
    const shortcut = join(desktop, SHORTCUT_FILENAME);
    const dashboardExe = stagedBinaryPath();
    const legacyPs1 = join(portpilotHome(), LEGACY_LAUNCHER_FILENAME);
    const legacyGoExe = process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "PAAT", LEGACY_GO_LAUNCHER_FILENAME)
        : "";
    let removedShortcut = false;
    let removedLauncher = false;
    try {
        await rm(shortcut, { force: true });
        removedShortcut = true;
    }
    catch { /* ignore */ }
    try {
        await rm(dashboardExe, { force: true });
        removedLauncher = true;
    }
    catch { /* may be in use */ }
    try {
        await rm(legacyPs1, { force: true });
    }
    catch { /* ignore */ }
    if (legacyGoExe)
        try {
            await rm(legacyGoExe, { force: true });
        }
        catch { /* ignore */ }
    try {
        await rm(shortcutPaths().shortcut, { force: true });
    }
    catch { /* ignore */ }
    try {
        const programs = await startMenuFolder();
        if (programs) {
            await rm(join(programs, "Port Authority Agent Terminal"), { recursive: true, force: true });
        }
    }
    catch { /* ignore */ }
    return { removedShortcut, removedLauncher };
}
/** Returns existence/health of the installed shortcut. */
export async function shortcutStatus() {
    const desktop = await resolveDesktopFolder();
    const shortcut = join(desktop, SHORTCUT_FILENAME);
    const launcher = stagedBinaryPath();
    const programs = await startMenuFolder();
    const startMenu = programs
        ? join(programs, "Port Authority Agent Terminal", "Port Authority Agent Terminal.lnk")
        : "";
    let shortcutExists = false;
    let launcherExists = false;
    let startMenuExists = false;
    try {
        await access(shortcut);
        shortcutExists = true;
    }
    catch { /* ignore */ }
    try {
        await access(launcher);
        launcherExists = true;
    }
    catch { /* ignore */ }
    if (startMenu) {
        try {
            await access(startMenu);
            startMenuExists = true;
        }
        catch { /* ignore */ }
    }
    return { shortcut, launcher, startMenu, shortcutExists, launcherExists, startMenuExists };
}
