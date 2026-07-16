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

use crate::commands::action_safety::revalidate_lane_action;
use crate::commands::kill::terminate_lane_process;
use crate::runtime::RuntimeState;
use serde_json::Value;
use std::{thread, time::Duration};
use tauri::State;

fn erase_blocking(
    pid: u32,
    process_start: String,
    profile_dir: String,
    lane_id: String,
    runtime: RuntimeState,
) -> Result<Value, String> {
    let validated = revalidate_lane_action(&runtime, &lane_id, pid, &process_start)?;
    let validated_profile = validated
        .get("lane")
        .and_then(|lane| lane.get("chromeProfileDir"))
        .and_then(Value::as_str)
        .ok_or_else(|| "refused erase: validated lane has no profile path".to_string())?;
    if validated_profile != profile_dir {
        return Err("refused erase: requested profile does not match the revalidated lane".into());
    }
    // Revalidate once more inside the termination helper immediately before
    // closing the process. A mismatched frontend path can never cause a kill.
    terminate_lane_process(&runtime, &lane_id, pid, &process_start)?;

    // Erase via the CLI. The guarded delete + lane removal live in the
    //    tested Node core; we just retry because Windows can keep the profile
    //    locked for a moment after the process dies.
    let mut args: Vec<String> = vec![
        "profiles".into(),
        "forget".into(),
        "--profile-dir".into(),
        profile_dir,
    ];
    args.push("--lane".into());
    args.push(lane_id);
    let mut last_err = String::new();
    for attempt in 0u64..5 {
        thread::sleep(Duration::from_millis(300 * (attempt + 1)));
        match runtime.run_json(&args) {
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
    process_start: String,
    profile_dir: String,
    lane_id: String,
    runtime: State<'_, RuntimeState>,
) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        erase_blocking(pid, process_start, profile_dir, lane_id, runtime)
    })
    .await
    .map_err(|e| format!("erase worker join failed: {}", e))?
}
