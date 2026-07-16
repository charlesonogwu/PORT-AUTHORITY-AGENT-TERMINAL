#[cfg(not(target_os = "macos"))]
use crate::cli::quiet_command;
use crate::commands::action_safety::revalidate_lane_action;
use crate::runtime::RuntimeState;
use serde_json::{json, Value};
use std::{
    thread,
    time::{Duration, Instant},
};
use tauri::State;

#[cfg(target_os = "macos")]
fn process_exists(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(crate) fn terminate_lane_process(
    runtime: &RuntimeState,
    lane_id: &str,
    pid: u32,
    process_start: &str,
) -> Result<Value, String> {
    let validated = revalidate_lane_action(runtime, lane_id, pid, process_start)?;

    #[cfg(target_os = "windows")]
    {
        let output = quiet_command("taskkill.exe")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
            .map_err(|e| format!("failed to terminate verified browser: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }

    #[cfg(target_os = "macos")]
    {
        let term = std::process::Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map_err(|e| format!("failed to gracefully terminate verified browser: {e}"))?;
        if !term.status.success() {
            return Err(String::from_utf8_lossy(&term.stderr).trim().to_string());
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while process_exists(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
        if process_exists(pid) {
            crate::process_identity::verify(pid, process_start)?;
            let forced = std::process::Command::new("/bin/kill")
                .args(["-KILL", &pid.to_string()])
                .output()
                .map_err(|e| format!("failed to force-terminate verified browser: {e}"))?;
            if !forced.status.success() {
                return Err(String::from_utf8_lossy(&forced.stderr).trim().to_string());
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let output = quiet_command("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .map_err(|e| format!("failed to terminate verified browser: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }

    Ok(validated)
}

#[tauri::command]
pub async fn kill_chrome(
    lane_id: String,
    pid: u32,
    process_start: String,
    runtime: State<'_, RuntimeState>,
) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match terminate_lane_process(&runtime, &lane_id, pid, &process_start) {
            Ok(_) => json!({ "ok": true, "pid": pid }),
            Err(error) => json!({ "ok": false, "pid": pid, "error": error }),
        }
    })
    .await
    .map_err(|e| format!("kill worker failed: {e}"))
}
