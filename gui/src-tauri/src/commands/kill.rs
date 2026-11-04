// kill_chrome — the dashboard "Kill" button: close one PortPilot browser.
//
// The pid comes from the last refresh, so it is never trusted on its own:
//   1. Windows: pin the exact process with a handle first.
//   2. Re-check the full lane target (lane, pid, browser, port, profile)
//      against a snapshot taken after the click.
//   3. Terminate through the pinned handle, so a pid Windows reused for
//      another program after the check can never be the one closed.
// macOS/Linux have no handle to pin; they re-check, then `kill -9`.

use crate::target::{verify_live_target, LaneTarget};
use serde_json::{json, Value};

#[tauri::command]
pub async fn kill_chrome(target: LaneTarget) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || kill_verified(target))
        .await
        .map_err(|e| format!("kill worker join failed: {}", e))?
}

#[cfg(target_os = "windows")]
fn kill_verified(target: LaneTarget) -> Result<Value, String> {
    use crate::target::ProcessPin;
    use std::time::Duration;

    let pid = target.pid;
    let Some(pin) = ProcessPin::open(pid)? else {
        return Ok(json!({ "ok": true, "pid": pid, "alreadyExited": true }));
    };
    verify_live_target(&target)?;
    match pin.terminate_and_wait(Duration::from_secs(5)) {
        Ok(()) => Ok(json!({ "ok": true, "pid": pin.pid() })),
        Err(error) => Ok(json!({ "ok": false, "pid": pin.pid(), "error": error })),
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_verified(target: LaneTarget) -> Result<Value, String> {
    use crate::cli::quiet_command;

    verify_live_target(&target)?;
    let pid = target.pid;
    let output = quiet_command("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .map_err(|e| format!("failed to spawn kill command: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(json!({ "ok": false, "pid": pid, "error": stderr.trim().to_string() }));
    }
    Ok(json!({ "ok": true, "pid": pid }))
}
