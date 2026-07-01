// erase_chrome — the dashboard "Erase" button.
//
// Unlike kill_chrome (which only CLOSES Chrome and leaves the saved profile on
// disk, so the agent reopens still logged in), this also WIPES the lane's saved
// browser data. It:
//   1. kills the Chrome pid so it releases the profile's file locks,
//   2. waits for those locks to clear (Windows holds them briefly after exit),
//   3. shells out to `paat profiles forget` to delete the profile directory
//      (guarded to ~/.portpilot/profiles) and drop the lane from the registry.
//
// async + spawn_blocking so the multi-second kill+retry never freezes the UI
// thread — same pattern as commands/snapshot.rs.

use crate::cli::{quiet_command, run_cli_json};
use serde_json::Value;
use std::{thread, time::Duration};

fn kill_pid(pid: u32) {
    let _ = if cfg!(target_os = "windows") {
        quiet_command("taskkill.exe")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
    } else {
        quiet_command("kill").args(["-9", &pid.to_string()]).output()
    };
}

fn erase_blocking(pid: u32, profile_dir: String, lane_id: Option<String>) -> Result<Value, String> {
    // 1. Close Chrome so it releases the profile's file handles.
    kill_pid(pid);

    // 2. Erase via the CLI. The guarded delete + lane removal live in the
    //    tested Node core; we just retry because Windows can keep the profile
    //    locked for a moment after the process dies.
    let mut args: Vec<String> = vec![
        "profiles".into(),
        "forget".into(),
        "--profile-dir".into(),
        profile_dir,
    ];
    if let Some(id) = lane_id {
        args.push("--lane".into());
        args.push(id);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let mut last_err = String::new();
    for attempt in 0u64..5 {
        thread::sleep(Duration::from_millis(300 * (attempt + 1)));
        match run_cli_json(&arg_refs) {
            Ok(v) => return Ok(v),
            Err(e) => last_err = e,
        }
    }
    Err(format!(
        "closed Chrome (pid {}) but could not erase the saved data after several tries \
         (a file may still be locked): {}",
        pid, last_err
    ))
}

#[tauri::command]
pub async fn erase_chrome(
    pid: u32,
    profile_dir: String,
    lane_id: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || erase_blocking(pid, profile_dir, lane_id))
        .await
        .map_err(|e| format!("erase worker join failed: {}", e))?
}
