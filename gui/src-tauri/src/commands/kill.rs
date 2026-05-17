// kill_chrome — terminate a process by PID. Cross-platform: taskkill on
// Windows, `kill -9` on macOS/Linux. The dashboard calls this when the user
// hits the "Kill" button on a lane that has stale or crashed Chrome.
//
// We deliberately do NOT validate that the PID is paat-owned here — the
// dashboard UI only surfaces PIDs that came out of `paat status`, so by the
// time a user clicks Kill we already know the PID is one of ours. If the
// PID has already exited the OS-level kill is a no-op and we return ok.

use crate::cli::quiet_command;
use serde_json::{json, Value};

#[tauri::command]
pub fn kill_chrome(pid: u32) -> Result<Value, String> {
    // quiet_command() suppresses the brief CMD-window flash that
    // std::process::Command::new("taskkill.exe") would otherwise pop on
    // Windows. Same fix applied across cli.rs and focus.rs in 0.2.3.
    let result = if cfg!(target_os = "windows") {
        quiet_command("taskkill.exe")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
    } else {
        // macOS + Linux: SIGKILL is universal. (CREATE_NO_WINDOW is a no-op
        // here since quiet_command only sets it under #[cfg(windows)].)
        quiet_command("kill")
            .args(["-9", &pid.to_string()])
            .output()
    };

    let output = result.map_err(|e| format!("failed to spawn kill command: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(json!({
            "ok": false,
            "pid": pid,
            "error": stderr.trim().to_string()
        }));
    }
    Ok(json!({ "ok": true, "pid": pid }))
}
