// kill_chrome — terminate a process by PID via taskkill.
//
// Phase 5: minimal real implementation (no safety validation — that's added
// in Phase 6 to match the old /api/kill endpoint's "only kill paat-owned
// Chrome processes" guard).

use serde_json::Value;
use std::process::Command;

#[tauri::command]
pub fn kill_chrome(pid: u32) -> Result<Value, String> {
    let output = Command::new("taskkill.exe")
        .args(["/F", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| format!("failed to spawn taskkill: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(serde_json::json!({
            "ok": false,
            "pid": pid,
            "error": stderr.trim().to_string()
        }));
    }
    Ok(serde_json::json!({ "ok": true, "pid": pid }))
}
