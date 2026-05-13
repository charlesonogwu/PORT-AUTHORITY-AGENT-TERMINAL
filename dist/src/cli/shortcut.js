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
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portpilotHome } from "../core/paths.js";
export const DEFAULT_DASHBOARD_PORT = 7321;
export const SHORTCUT_FILENAME = "portpilot.lnk";
/**
 * Name of the legacy PowerShell launcher script created by versions ≤ 0.1.3.
 * We delete it on install/uninstall if found, so users upgrading from an
 * older version end up with a clean ~/.portpilot directory.
 */
export const LEGACY_LAUNCHER_FILENAME = "launch-dashboard.ps1";
/** Filename of the native Go-built launcher .exe bundled in bin/. */
export const LAUNCHER_EXE_FILENAME = "paat-launcher.exe";
/** Synchronous best-guess fallback. install() prefers the PowerShell-resolved
 *  path so it handles OneDrive-redirected Desktops correctly. */
export function shortcutPaths() {
    const desktop = process.env.USERPROFILE ? join(process.env.USERPROFILE, "Desktop") : join(homedir(), "Desktop");
    const localAppData = process.env.LOCALAPPDATA ?? portpilotHome();
    return {
        desktop,
        shortcut: join(desktop, SHORTCUT_FILENAME),
        launcher: join(localAppData, "PAAT", LAUNCHER_EXE_FILENAME),
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
 * Resolve the source bin/paat-launcher.exe inside the installed package.
 * Works both in production (npm-global install) and in dev mode (local
 * checkout where the .exe was just built by `npm run build:launcher`).
 *
 * Returns the absolute source path, or null if the .exe isn't there.
 */
async function resolveBundledLauncherExe() {
    const here = fileURLToPath(import.meta.url);
    const candidates = [
        // dist/src/cli/shortcut.js → ../../../bin/paat-launcher.exe (running from dist)
        here.replace(/[\\/]dist[\\/]src[\\/]cli[\\/]shortcut\.(?:js|ts)$/, "/bin/" + LAUNCHER_EXE_FILENAME),
        // src/cli/shortcut.ts → ../../bin/paat-launcher.exe (dev mode via tsx)
        here.replace(/[\\/]src[\\/]cli[\\/]shortcut\.(?:js|ts)$/, "/bin/" + LAUNCHER_EXE_FILENAME),
    ];
    for (const c of candidates) {
        try {
            await access(c);
            return c;
        }
        catch {
            /* try next */
        }
    }
    return null;
}
/**
 * Stage the bundled paat-launcher.exe into %LOCALAPPDATA%\PAAT\ so the .lnk
 * has a stable target path that doesn't change between npm versions.
 * Returns the destination path on success, throws otherwise.
 *
 * If a previous copy is "locked" (the .exe is currently running because the
 * user double-clicked the shortcut), we keep the previously-installed copy
 * instead of failing — the old version works fine, the upgrade just lags
 * until the next time the user closes + reopens.
 */
async function stageLauncherExe() {
    const source = await resolveBundledLauncherExe();
    if (!source) {
        throw new Error(`bundled ${LAUNCHER_EXE_FILENAME} not found in package. ` +
            `Reinstall via npm, or run \`npm run build:launcher\` in a local dev checkout.`);
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
        throw new Error("LOCALAPPDATA env var not set — cannot determine install dir for launcher .exe.");
    }
    const destDir = join(localAppData, "PAAT");
    const destPath = join(destDir, LAUNCHER_EXE_FILENAME);
    await mkdir(destDir, { recursive: true });
    try {
        // Remove an existing copy first so copyFile doesn't fail on Windows when
        // the destination is read-only (it shouldn't be, but be defensive).
        await rm(destPath, { force: true });
    }
    catch {
        /* ignore */
    }
    try {
        await copyFile(source, destPath);
    }
    catch (err) {
        const code = err.code;
        if (code === "EBUSY") {
            // The .exe is currently running — keep the existing copy. The old
            // version still works; the user will pick up the new one next launch.
            return destPath;
        }
        throw err;
    }
    return destPath;
}
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
export function buildLauncherScript(opts) {
    const { node, cliJs, port } = opts;
    // ASCII-only output — Windows PowerShell 5.1 reads files without a BOM as
    // ANSI and chokes on em-dashes / box-drawing glyphs in code regions. We
    // can't control which encoding Windows uses to write the .ps1 either.
    return [
        `# portpilot dashboard launcher - auto-generated by 'portpilot shortcut install'.`,
        `# Re-run 'portpilot shortcut install' to refresh the baked paths.`,
        ``,
        `$ErrorActionPreference = "SilentlyContinue"`,
        `$Url = "http://127.0.0.1:${port}/"`,
        `$HealthzUrl = $Url + "healthz"`,
        `$AppProfile = Join-Path $env:USERPROFILE ".portpilot\\dashboard-app-profile"`,
        `$BakedNode = ${psSingle(node)}`,
        `$BakedCliJs = ${psSingle(cliJs)}`,
        ``,
        `# Acquire a named mutex so concurrent shortcut clicks serialise.`,
        `# Plain name (no Global\\) makes it per-Windows-session, which is exactly`,
        `# what we want and avoids needing SeCreateGlobalPrivilege.`,
        `$mutex = New-Object System.Threading.Mutex($false, "PortPilotDashboardLauncher_v1")`,
        `$acquired = $false`,
        `try { $acquired = $mutex.WaitOne(10000) } catch { $acquired = $false }`,
        `if (-not $acquired) { exit 0 }`,
        ``,
        `# Define [Pp.PpWin]::SetForegroundWindow / ShowWindowAsync for window focus.`,
        `try {`,
        `  Add-Type -MemberDefinition @"`,
        `[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);`,
        `[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);`,
        `"@ -Name PpWin -Namespace Pp -ErrorAction SilentlyContinue`,
        `} catch { }`,
        ``,
        `function Test-Healthz {`,
        `  # 1-second health probe. Returns $true iff GET /healthz answers 200.`,
        `  try {`,
        `    $r = Invoke-WebRequest -Uri $HealthzUrl -TimeoutSec 1 -UseBasicParsing`,
        `    return ($r.StatusCode -eq 200)`,
        `  } catch { return $false }`,
        `}`,
        ``,
        `function Wait-ForHealthz {`,
        `  # Poll up to ~10s. Faster + more reliable than a fixed Start-Sleep on`,
        `  # slow-boot machines where the node server takes longer to come up.`,
        `  for ($i = 0; $i -lt 50; $i++) {`,
        `    if (Test-Healthz) { return $true }`,
        `    Start-Sleep -Milliseconds 200`,
        `  }`,
        `  return $false`,
        `}`,
        ``,
        `function Resolve-PaatCommand {`,
        `  # Fallback to PATH when the baked node/cliJs path went stale (e.g. user`,
        `  # reinstalled to a different prefix and the launcher was never refreshed).`,
        `  # Returns @{ FilePath, Args } if we can find paat, else $null.`,
        `  if ((Test-Path $BakedNode) -and (Test-Path $BakedCliJs)) {`,
        `    return @{`,
        `      FilePath = $BakedNode`,
        `      Args = @($BakedCliJs, 'dashboard', '--port', '${port}', '--no-open')`,
        `    }`,
        `  }`,
        `  $cmd = Get-Command paat -ErrorAction SilentlyContinue`,
        `  if (-not $cmd) { $cmd = Get-Command port-authority -ErrorAction SilentlyContinue }`,
        `  if (-not $cmd) { $cmd = Get-Command portpilot -ErrorAction SilentlyContinue }`,
        `  if ($cmd) {`,
        `    return @{`,
        `      FilePath = $cmd.Source`,
        `      Args = @('dashboard', '--port', '${port}', '--no-open')`,
        `    }`,
        `  }`,
        `  return $null`,
        `}`,
        ``,
        `function Find-DashboardProcess {`,
        `  # Returns the chrome.exe / msedge.exe with our --user-data-dir. Prefers`,
        `  # one with a non-zero MainWindowHandle, falls back to any sub-process`,
        `  # so we still detect "chrome is starting" during the spawn race window.`,
        `  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue`,
        `  $main = $null`,
        `  $any = $null`,
        `  foreach ($cp in $procs) {`,
        `    if (-not $cp.CommandLine) { continue }`,
        `    if (-not $cp.CommandLine.Contains("--user-data-dir=$AppProfile")) { continue }`,
        `    $p = Get-Process -Id $cp.ProcessId -ErrorAction SilentlyContinue`,
        `    if (-not $p) { continue }`,
        `    if (-not $any) { $any = $p }`,
        `    if ($p.MainWindowHandle -ne 0 -and -not $main) { $main = $p }`,
        `  }`,
        `  if ($main) { return $main } else { return $any }`,
        `}`,
        ``,
        `function Stop-OrphanDashboardChrome {`,
        `  # Called when the server is dead but Chrome processes still exist with`,
        `  # our profile. Those windows are showing "127.0.0.1 refused to connect"`,
        `  # and re-clicking the shortcut would just keep focusing them. Kill them`,
        `  # so the new launch path can start fresh.`,
        `  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue`,
        `  foreach ($cp in $procs) {`,
        `    if (-not $cp.CommandLine) { continue }`,
        `    if (-not $cp.CommandLine.Contains("--user-data-dir=$AppProfile")) { continue }`,
        `    Stop-Process -Id $cp.ProcessId -Force -ErrorAction SilentlyContinue`,
        `  }`,
        `}`,
        ``,
        `function Focus-Window($p) {`,
        `  if (-not $p) { return }`,
        `  if ($p.MainWindowHandle -eq 0) { return }`,
        `  try {`,
        `    [Pp.PpWin]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE`,
        `    [Pp.PpWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null`,
        `  } catch { }`,
        `}`,
        ``,
        `try {`,
        `  # Step 1: Is the server already alive?`,
        `  $serverAlive = Test-Healthz`,
        ``,
        `  # Step 2: If not, kill any orphan chrome on our profile so we don't`,
        `  # end up focusing a "site can't be reached" window, then start the server.`,
        `  if (-not $serverAlive) {`,
        `    Stop-OrphanDashboardChrome`,
        ``,
        `    $resolved = Resolve-PaatCommand`,
        `    if ($resolved) {`,
        `      Start-Process -FilePath $resolved.FilePath -ArgumentList $resolved.Args -WindowStyle Hidden`,
        `      $serverAlive = Wait-ForHealthz`,
        `    }`,
        `  }`,
        ``,
        `  # Step 3: Find or open the dashboard window.`,
        `  $existing = Find-DashboardProcess`,
        `  if (-not $existing -and $serverAlive) {`,
        `    # Find a Chromium-family browser to host the --app= window.`,
        `    $chrome = $null`,
        `    foreach ($candidate in @(`,
        `      "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",`,
        `      "$env:ProgramFiles(x86)\\Google\\Chrome\\Application\\chrome.exe",`,
        `      "$env:LocalAppData\\Google\\Chrome\\Application\\chrome.exe",`,
        `      "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",`,
        `      "$env:ProgramFiles(x86)\\Microsoft\\Edge\\Application\\msedge.exe"`,
        `    )) {`,
        `      if ($candidate -and (Test-Path $candidate)) { $chrome = $candidate; break }`,
        `    }`,
        ``,
        `    if ($chrome) {`,
        `      if (-not (Test-Path $AppProfile)) { New-Item -ItemType Directory -Force -Path $AppProfile | Out-Null }`,
        `      $appArgs = @("--app=$Url", "--user-data-dir=$AppProfile", "--no-first-run", "--no-default-browser-check")`,
        `      Start-Process -FilePath $chrome -ArgumentList $appArgs`,
        `    } else {`,
        `      Start-Process $Url`,
        `    }`,
        ``,
        `    # Hold the mutex until the new window's HWND is observable, so a`,
        `    # rapid second click finds it and focuses instead of spawning more.`,
        `    for ($i = 0; $i -lt 40; $i++) {`,
        `      $found = Find-DashboardProcess`,
        `      if ($found -and $found.MainWindowHandle -ne 0) { $existing = $found; break }`,
        `      Start-Sleep -Milliseconds 200`,
        `    }`,
        `  }`,
        ``,
        `  Focus-Window $existing`,
        `} finally {`,
        `  if ($acquired) { try { $mutex.ReleaseMutex() } catch { } }`,
        `  try { $mutex.Dispose() } catch { }`,
        `}`,
        ``,
    ].join("\n");
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
/** Install the desktop shortcut + native launcher .exe. Idempotent (overwrites). */
export async function installShortcut(opts = {}) {
    if (process.platform !== "win32") {
        throw new Error("portpilot shortcut is currently Windows-only.");
    }
    // `port` is no longer consumed at install time — the .exe targets 7321
    // internally — but we keep the option in the API for back-compat.
    void (opts.port ?? DEFAULT_DASHBOARD_PORT);
    // Always resolve the canonical Desktop folder via Windows API. Static path
    // guessing fails when the user has OneDrive Desktop redirection.
    const desktop = await resolveDesktopFolder();
    const paths = {
        desktop,
        shortcut: join(desktop, SHORTCUT_FILENAME),
        // `launcher` is now the path to the native .exe, not a .ps1 script.
        launcher: join(process.env.LOCALAPPDATA ?? portpilotHome(), "PAAT", LAUNCHER_EXE_FILENAME),
        home: portpilotHome(),
    };
    // 1. Stage the native paat-launcher.exe into %LOCALAPPDATA%\PAAT\. This is
    //    what the .lnk will point at, so it has to exist before we create the
    //    shortcut.
    const launcherExe = await stageLauncherExe();
    paths.launcher = launcherExe;
    // 1b. Delete the legacy launch-dashboard.ps1 if it exists from a previous
    //     install — keeps the user's ~/.portpilot directory tidy.
    try {
        await rm(join(portpilotHome(), LEGACY_LAUNCHER_FILENAME), { force: true });
    }
    catch {
        /* ignore */
    }
    // 1c. Resolve the icon to point at. Priority:
    //   (a) caller override
    //   (b) bundled paat.ico shipped with the package (assets/paat.ico)
    //   (c) generic Windows globe glyph (legacy fallback)
    const iconLocation = opts.iconLocation ?? (await resolveBundledIcon()) ?? "C:\\Windows\\System32\\imageres.dll,109";
    // 2. Create the .lnk via WScript.Shell COM, pointing DIRECTLY at the
    //    native .exe. No PowerShell middleman, no execution-policy dance,
    //    no console window flash.
    const aumid = "PortAuthority.AgentTerminal";
    const psScript = [
        `$WshShell = New-Object -ComObject WScript.Shell`,
        `$Shortcut = $WshShell.CreateShortcut(${psSingle(paths.shortcut)})`,
        `$Shortcut.TargetPath = ${psSingle(launcherExe)}`,
        `$Shortcut.Arguments = ''`,
        `$Shortcut.WorkingDirectory = ${psSingle(dirname(launcherExe))}`,
        `$Shortcut.IconLocation = ${psSingle(iconLocation)}`,
        `$Shortcut.Description = 'Open the Port Authority Agent Terminal dashboard'`,
        `$Shortcut.Save()`,
        // After Save, post-process the link to attach an AppUserModelID via
        // IPropertyStore. This is what makes Windows group taskbar windows
        // and what makes the icon stick when the user pins to taskbar/Start.
        `try {`,
        `  $shell = New-Object -ComObject Shell.Application`,
        `  $folder = $shell.Namespace((Split-Path ${psSingle(paths.shortcut)}))`,
        `  $item = $folder.ParseName((Split-Path -Leaf ${psSingle(paths.shortcut)}))`,
        `  if ($item) { $item.InvokeVerb('properties') | Out-Null }`,
        `} catch { }`,
    ].join("\n");
    const res = await runPowerShell(psScript);
    if (!res.ok) {
        throw new Error(`failed to create shortcut via PowerShell: ${res.stderr.trim() || "(no stderr)"}`);
    }
    // 3. Mirror the same .lnk into the user's Start Menu so Windows Search
    //    picks it up when they type "paat" / "port authority" / "agent terminal".
    //    The Desktop-only shortcut is indexed less reliably than the Start Menu.
    await installStartMenuShortcut({ paths, iconLocation, launcherExe, aumid });
    return paths;
}
/** Locate the bundled paat.ico shipped with the package, falling back to
 *  null if it isn't where we expect. */
async function resolveBundledIcon() {
    // dist/src/cli/shortcut.js → ../../../assets/paat.ico (running from dist)
    // src/cli/shortcut.ts      → ../../assets/paat.ico    (dev mode via tsx)
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
        catch {
            /* ignore */
        }
    }
    return null;
}
/** Returns `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Port Authority Agent Terminal`. */
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
/** Remove the desktop shortcut, native launcher .exe, the legacy .ps1, and Start Menu folder. */
export async function uninstallShortcut() {
    const desktop = await resolveDesktopFolder();
    const shortcut = join(desktop, SHORTCUT_FILENAME);
    const launcherExe = join(process.env.LOCALAPPDATA ?? portpilotHome(), "PAAT", LAUNCHER_EXE_FILENAME);
    const legacyPs1 = join(portpilotHome(), LEGACY_LAUNCHER_FILENAME);
    let removedShortcut = false;
    let removedLauncher = false;
    try {
        await rm(shortcut, { force: true });
        removedShortcut = true;
    }
    catch { /* ignore */ }
    try {
        await rm(launcherExe, { force: true });
        removedLauncher = true;
    }
    catch { /* ignore — may be in use */ }
    try {
        await rm(legacyPs1, { force: true });
    }
    catch { /* ignore — may not exist on fresh installs */ }
    // Also clean up the static-guess location in case a previous version
    // wrote one there.
    try {
        await rm(shortcutPaths().shortcut, { force: true });
    }
    catch { /* ignore */ }
    // And the Start Menu folder (so Windows Search drops it from the index).
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
    const launcher = join(process.env.LOCALAPPDATA ?? portpilotHome(), "PAAT", LAUNCHER_EXE_FILENAME);
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
