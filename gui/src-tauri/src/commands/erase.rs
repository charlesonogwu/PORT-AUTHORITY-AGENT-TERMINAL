// erase_chrome — the dashboard "Erase" button.
//
// Unlike kill_chrome (which only CLOSES the browser and leaves the saved
// profile on disk, so the agent reopens still logged in), this also WIPES the
// lane's saved browser data. It:
//   1. pins the browser process (Windows) and re-checks the full lane target
//      against a snapshot taken after the click,
//   2. closes the browser and confirms it exited, so it releases the
//      profile's files,
//   3. shells out to `paat profiles forget` to delete the profile directory
//      the snapshot just reported (guarded to ~/.portpilot/profiles in the
//      Node core) and drop the lane from the registry.
//
// async + spawn_blocking so the multi-second close+retry never freezes the UI
// thread — same pattern as commands/snapshot.rs.

use crate::cli::run_cli_json;
use crate::target::{verify_live_target, LaneTarget};
use serde_json::Value;
use std::{thread, time::Duration};

/// Close the verified browser and wait until it has really exited.
#[cfg(target_os = "windows")]
fn close_verified(target: &LaneTarget) -> Result<String, String> {
    use crate::target::ProcessPin;

    let pin = ProcessPin::open(target.pid)?;
    let profile_dir = verify_live_target(target)?;
    if let Some(pin) = pin {
        pin.terminate_and_wait(Duration::from_secs(10)).map_err(|e| {
            format!("could not close the browser (pid {}) before erasing: {}", target.pid, e)
        })?;
    }
    Ok(profile_dir)
}

#[cfg(not(target_os = "windows"))]
fn close_verified(target: &LaneTarget) -> Result<String, String> {
    use crate::cli::quiet_command;

    let profile_dir = verify_live_target(target)?;
    let pid = target.pid.to_string();
    let _ = quiet_command("kill").args(["-9", &pid]).output();
    for _ in 0..50 {
        let alive = quiet_command("kill")
            .args(["-0", &pid])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !alive {
            return Ok(profile_dir);
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!("could not close the browser (pid {}) before erasing", target.pid))
}

fn erase_blocking(target: LaneTarget) -> Result<Value, String> {
    let pid = target.pid;
    let profile_dir = close_verified(&target)?;

    // Erase via the CLI. The guarded delete + lane removal live in the
    // tested Node core; we retry because Windows can keep the profile locked
    // for a moment after the process dies.
    let mut args: Vec<String> = vec![
        "profiles".into(),
        "forget".into(),
        "--profile-dir".into(),
        profile_dir,
    ];
    if let Some(id) = target.lane_id {
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
        "closed the browser (pid {}) but could not erase the saved data after several tries \
         (a file may still be locked): {}",
        pid, last_err
    ))
}

#[tauri::command]
pub async fn erase_chrome(target: LaneTarget) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || erase_blocking(target))
        .await
        .map_err(|e| format!("erase worker join failed: {}", e))?
}
