/**
 * Bring a Chrome window to the foreground on the user's desktop. Called
 * from the dashboard's "Show" button to let the user visually inspect a
 * specific session.
 *
 * ============================================================================
 * SECURITY NOTE — read this before reviewing or modifying buildFocusScript()
 * ============================================================================
 * This file imports the Win32 user32 functions `SetForegroundWindow`,
 * `ShowWindowAsync`, `IsIconic`, and (the one that catches naive AV
 * scanners' eyes) `keybd_event`. Static signature scanners sometimes flag
 * any code that imports `keybd_event` as "potential keylogger" because
 * the same API can be used to inject arbitrary keystrokes.
 *
 * What this file actually does with `keybd_event`:
 *   - It synthesizes ONE press-then-release of the Alt key (VK_MENU, 0x12)
 *     immediately around a single SetForegroundWindow call.
 *   - That's the standard, documented workaround for Windows' "foreground
 *     steal prevention": background processes calling SetForegroundWindow
 *     are silently denied unless the caller has just received user input.
 *     The Alt-tap satisfies that requirement so the Show button reliably
 *     brings the chosen Chrome window to front instead of just blinking
 *     the taskbar.
 *
 * What this file does NOT do (and what would make it a keylogger):
 *   - It does NOT install a keyboard hook. There is no SetWindowsHookEx,
 *     no WH_KEYBOARD_LL, no GetKeyboardState polling, no clipboard read.
 *   - It does NOT capture input. `keybd_event` only generates input —
 *     the only key it generates is Alt, and only when the user has
 *     deliberately clicked the Show button on a specific row.
 *   - It does NOT have any background daemon. The PowerShell script
 *     spawns once per HTTP click, runs for ~50ms, exits.
 *
 * Authorization gates before any window manipulation happens:
 *   - The PID arrives over HTTP and is validated to be a positive integer.
 *   - A fresh port scan confirms the PID is currently a Chromium-family
 *     process (chrome.exe / msedge.exe / brave.exe). Anything else is
 *     refused with "not a Chromium-family process".
 *   - The HTTP server binds to 127.0.0.1 by default; remote callers
 *     cannot reach this endpoint without an explicit override flag.
 *
 * If a future audit replaces `keybd_event` with `AttachThreadInput` or
 * any other foreground-permission workaround, please preserve this
 * comment block so the design intent is obvious to the next reviewer.
 *
 * Safety contract (mirrors kill.ts):
 *   - Refuses to focus anything we can't identify as a Chromium-family
 *     process. The dashboard server takes PIDs from a public HTTP body,
 *     and we don't want a stray malicious tab on 127.0.0.1 to be able
 *     to bring random apps to the foreground.
 *   - User-initiated only — invoked from a POST handler that exists to
 *     serve a deliberate click on a specific row.
 *   - Never crashes the server: Win32 SetForegroundWindow has well-known
 *     "foreground steal prevention" rules that may legitimately fail.
 *     We report ok:false with a useful message and let the user retry.
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { scanPorts } from "../core/scanner.js";
import { isChromeProcess } from "../core/chrome.js";
/**
 * The PowerShell script we run. ASCII-only, no em-dashes, no smart
 * quotes — Windows PowerShell 5.1 reads the inline -Command string as
 * ANSI and chokes on non-ASCII bytes inside code regions.
 *
 * Strategy:
 *   1. Resolve PID -> Process. If it has no main window (helper
 *      subprocess, headless chrome) we report "no-window" so the
 *      dashboard can show a friendly message.
 *   2. If the window is minimised, restore it (SW_RESTORE).
 *   3. Press-and-release Alt to defeat Windows' foreground-steal
 *      prevention — without this, SetForegroundWindow from a background
 *      service silently fails and the taskbar just blinks.
 *   4. Call SetForegroundWindow.
 */
/**
 * Build the focus script with the PID baked in. PowerShell's -Command
 * mode doesn't support the `--` arg-separator trick that -File does, so
 * inlining is the cleanest way to pass the PID. The PID is validated
 * upstream as a positive integer, so injection isn't a concern.
 */
function buildFocusScript(pid) {
    return [
        '$ErrorActionPreference = "SilentlyContinue"',
        `$pid_arg = ${pid}`,
        "$proc = Get-Process -Id $pid_arg -ErrorAction SilentlyContinue",
        "if (-not $proc) { Write-Output 'no-process'; exit 3 }",
        "$hwnd = $proc.MainWindowHandle",
        "if ($hwnd -eq 0) { Write-Output 'no-window'; exit 4 }",
        "try {",
        "  Add-Type -MemberDefinition @\"",
        '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);',
        '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);',
        '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);',
        '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);',
        '"@ -Name PpFocus -Namespace Pp -ErrorAction Stop',
        "} catch { Write-Output 'add-type-failed'; exit 5 }",
        "if ([Pp.PpFocus]::IsIconic($hwnd)) { [Pp.PpFocus]::ShowWindowAsync($hwnd, 9) | Out-Null }",
        "[Pp.PpFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)",
        "$ok = [Pp.PpFocus]::SetForegroundWindow($hwnd)",
        "[Pp.PpFocus]::keybd_event(0x12, 0, 0x2, [UIntPtr]::Zero)",
        "if ($ok) { Write-Output 'ok' } else { Write-Output 'set-foreground-failed' }",
    ].join("\n");
}
/**
 * Build the hide (minimize) script. Same Win32 ShowWindowAsync API as
 * focus, just with SW_MINIMIZE (6) instead of SW_RESTORE (9). Mirrors
 * what clicking the underscore button in a window's title bar does.
 *
 * No keybd_event / SetForegroundWindow — minimizing is allowed for any
 * window, even from a background process. No foreground-steal worries.
 */
function buildHideScript(pid) {
    return [
        '$ErrorActionPreference = "SilentlyContinue"',
        `$pid_arg = ${pid}`,
        "$proc = Get-Process -Id $pid_arg -ErrorAction SilentlyContinue",
        "if (-not $proc) { Write-Output 'no-process'; exit 3 }",
        "$hwnd = $proc.MainWindowHandle",
        "if ($hwnd -eq 0) { Write-Output 'no-window'; exit 4 }",
        "try {",
        "  Add-Type -MemberDefinition @\"",
        '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);',
        '"@ -Name PpHide -Namespace PpHide -ErrorAction Stop',
        "} catch { Write-Output 'add-type-failed'; exit 5 }",
        "$ok = [PpHide.PpHide]::ShowWindowAsync($hwnd, 6)", // SW_MINIMIZE = 6
        "if ($ok) { Write-Output 'ok' } else { Write-Output 'minimize-failed' }",
    ].join("\n");
}
function runPowerShell(script, timeoutMs) {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const timer = setTimeout(() => { try {
            child.kill();
        }
        catch { /* ignore */ } }, timeoutMs);
        child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
        child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr, code }); });
        child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: err.message, code: null }); });
    });
}
/**
 * Bring the window of the given chromium-family PID to the foreground.
 * Validates PID is actually a Chromium process before issuing the focus.
 */
export async function focusChromeWindow(pid, opts = {}) {
    if (process.platform !== "win32") {
        return { ok: false, error: "focus is currently Windows-only" };
    }
    if (!Number.isInteger(pid) || pid <= 0) {
        return { ok: false, error: "invalid pid" };
    }
    // Same safety check as kill: confirm the PID is a Chromium process by
    // looking it up in a fresh port scan. Refuses to focus anything we
    // can't identify as a browser.
    const scan = await scanPorts();
    const obs = scan.observations.find((o) => o.pid === pid);
    if (!obs) {
        return { ok: false, error: `pid ${pid} not found in port scan (process may have exited or has no listening ports)` };
    }
    if (!isChromeProcess(obs)) {
        return { ok: false, error: `pid ${pid} (${obs.command ?? "unknown"}) is not a Chromium-family process` };
    }
    const r = await runPowerShell(buildFocusScript(pid), opts.timeoutMs ?? 4000);
    const out = r.stdout.trim().split(/\r?\n/).pop() ?? "";
    if (out === "ok")
        return { ok: true, pid };
    if (out === "no-process")
        return { ok: false, error: "process exited before we could focus it" };
    if (out === "no-window")
        return { ok: false, error: "this Chrome has no window (headless or helper subprocess)" };
    if (out === "set-foreground-failed")
        return { ok: false, error: "Windows refused the focus request (try clicking the dashboard, then clicking Show again)" };
    if (out === "add-type-failed")
        return { ok: false, error: "could not load Win32 focus API" };
    return { ok: false, error: r.stderr.trim() || `unknown focus error (output: ${out})` };
}
/**
 * Minimize the window of the given chromium-family PID. Same effect as
 * clicking the underscore button in the window's title bar. Validates
 * PID is a Chromium process before touching the window.
 */
export async function hideChromeWindow(pid, opts = {}) {
    if (process.platform !== "win32") {
        return { ok: false, error: "hide is currently Windows-only" };
    }
    if (!Number.isInteger(pid) || pid <= 0) {
        return { ok: false, error: "invalid pid" };
    }
    const scan = await scanPorts();
    const obs = scan.observations.find((o) => o.pid === pid);
    if (!obs) {
        return { ok: false, error: `pid ${pid} not found in port scan (process may have exited or has no listening ports)` };
    }
    if (!isChromeProcess(obs)) {
        return { ok: false, error: `pid ${pid} (${obs.command ?? "unknown"}) is not a Chromium-family process` };
    }
    const r = await runPowerShell(buildHideScript(pid), opts.timeoutMs ?? 4000);
    const out = r.stdout.trim().split(/\r?\n/).pop() ?? "";
    if (out === "ok")
        return { ok: true, pid };
    if (out === "no-process")
        return { ok: false, error: "process exited before we could hide it" };
    if (out === "no-window")
        return { ok: false, error: "this Chrome has no window (headless or helper subprocess)" };
    if (out === "minimize-failed")
        return { ok: false, error: "Windows refused the minimize request" };
    if (out === "add-type-failed")
        return { ok: false, error: "could not load Win32 ShowWindowAsync API" };
    return { ok: false, error: r.stderr.trim() || `unknown hide error (output: ${out})` };
}
