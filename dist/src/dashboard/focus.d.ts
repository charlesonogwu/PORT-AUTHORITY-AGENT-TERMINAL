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
export interface FocusResult {
    ok: boolean;
    error?: string;
    pid?: number;
}
/**
 * Bring the window of the given chromium-family PID to the foreground.
 * Validates PID is actually a Chromium process before issuing the focus.
 */
export declare function focusChromeWindow(pid: number, opts?: {
    timeoutMs?: number;
}): Promise<FocusResult>;
/**
 * Minimize the window of the given chromium-family PID. Same effect as
 * clicking the underscore button in the window's title bar. Validates
 * PID is a Chromium process before touching the window.
 */
export declare function hideChromeWindow(pid: number, opts?: {
    timeoutMs?: number;
}): Promise<FocusResult>;
