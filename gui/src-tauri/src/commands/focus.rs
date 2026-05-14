// focus_chrome / hide_chrome — bring a Chrome lane window to front (or hide
// it). Cross-platform best-effort: we shell out to platform-native tools so
// we don't pull in winapi/cocoa direct deps for a feature that's purely a
// quality-of-life affordance.
//
// Windows: PowerShell grabs the target PID's MainWindowHandle (no EnumWindows
//   gymnastics needed — .NET's Process class exposes it directly) and we call
//   ShowWindowAsync + SetForegroundWindow on it via Add-Type P/Invoke.
// macOS:   AppleScript via osascript to activate / hide the process.
// Linux:   wmctrl if installed; otherwise a soft error. Linux WM diversity
//   makes a universal solution impractical and PAAT is Windows+macOS-first.

use serde_json::{json, Value};
use std::process::Command;

#[tauri::command]
pub fn focus_chrome(pid: u32) -> Result<Value, String> {
    let result = run_window_action(pid, WindowAction::Focus);
    Ok(make_response(pid, result))
}

#[tauri::command]
pub fn hide_chrome(pid: u32) -> Result<Value, String> {
    let result = run_window_action(pid, WindowAction::Hide);
    Ok(make_response(pid, result))
}

enum WindowAction {
    Focus,
    Hide,
}

fn make_response(pid: u32, result: Result<(), String>) -> Value {
    match result {
        Ok(()) => json!({ "ok": true, "pid": pid }),
        Err(e) => json!({ "ok": false, "pid": pid, "error": e }),
    }
}

#[cfg(target_os = "windows")]
fn run_window_action(pid: u32, action: WindowAction) -> Result<(), String> {
    // SW_RESTORE = 9 (restore + activate), SW_HIDE = 0. ShowWindowAsync is
    // non-blocking so a misbehaving target window can't hang us.
    let (sw_cmd, do_foreground) = match action {
        WindowAction::Focus => (9, true),
        WindowAction::Hide => (0, false),
    };
    // PowerShell 5.1 ships on every supported Windows. We grab the HWND via
    // Get-Process -Id ...MainWindowHandle — far simpler than EnumWindows.
    let script = format!(
        r#"$ErrorActionPreference='Stop';
try {{
  $proc = Get-Process -Id {pid} -ErrorAction Stop;
  $hwnd = $proc.MainWindowHandle;
  if ($hwnd -eq [System.IntPtr]::Zero) {{
    Write-Error "no visible window for PID {pid}";
    exit 1;
  }};
  Add-Type -Name PaatWin -Namespace PaatNs -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@;
  [void][PaatNs.PaatWin]::ShowWindowAsync($hwnd, {sw});
  if (${fg}) {{ [void][PaatNs.PaatWin]::SetForegroundWindow($hwnd); }};
  exit 0;
}} catch {{
  Write-Error $_.Exception.Message;
  exit 1;
}}"#,
        pid = pid,
        sw = sw_cmd,
        fg = if do_foreground { "true" } else { "false" }
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("failed to spawn powershell: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "powershell exit {}: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_window_action(pid: u32, action: WindowAction) -> Result<(), String> {
    // AppleScript via osascript: System Events targets processes by Unix PID.
    // `set frontmost to true` activates; `set visible to false` hides.
    let script = match action {
        WindowAction::Focus => format!(
            "tell application \"System Events\" to set frontmost of (first process whose unix id is {}) to true",
            pid
        ),
        WindowAction::Hide => format!(
            "tell application \"System Events\" to set visible of (first process whose unix id is {}) to false",
            pid
        ),
    };
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("failed to spawn osascript: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("osascript failed: {}", stderr.trim()));
    }
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn run_window_action(pid: u32, action: WindowAction) -> Result<(), String> {
    // Best-effort Linux path via wmctrl. PAAT is not officially supported on
    // Linux yet — this is a courtesy so the build compiles.
    let action_args: &[&str] = match action {
        WindowAction::Focus => &["-a"],
        WindowAction::Hide => &["-b", "add,hidden"],
    };
    let mut cmd = Command::new("wmctrl");
    cmd.args(["-i", "-x", "-p", &pid.to_string()]);
    cmd.args(action_args);
    let output = cmd
        .output()
        .map_err(|e| format!("wmctrl not available: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "wmctrl exit {} (Linux window control is best-effort)",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}
