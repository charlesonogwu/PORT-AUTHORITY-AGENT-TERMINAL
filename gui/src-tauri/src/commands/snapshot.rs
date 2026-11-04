// get_snapshot — returns the full DashboardSnapshot shape the React UI
// consumes, plus the supervisor's health. This is the same data the old
// Express `/api/snapshot` endpoint returned.
//
// Each refresh is one request to the long-lived `paat dashboard-serve`
// helper (snapshot_worker.rs), which starts no new processes (apart from the
// optional `sonar` port scanner, when it is installed). Previously
// every refresh ran `paat dashboard-snapshot --json` and `paat supervisor
// status --json` as fresh processes; that path remains as the fallback when
// the helper can't be used (for example an older `paat` on PATH).
//
// 0.2.0/0.2.1 BUG (fixed here in 0.2.2): we previously shelled out to
// `paat status --json`, but that returns a simpler shape (just lanes + scan
// results) — no `summary` object, no `liveSessions` array, no `conflicts`.
// The React UI tried to read `snap.summary.liveSessions` → undefined →
// TypeError → blank white window. The fix is a new dedicated subcommand
// that calls buildSnapshot() and returns the rich shape.
//
// We delegate to the Node CLI rather than re-implementing the snapshot
// logic in Rust because:
//  - the scan + agent-inference + conflict-detection logic is already well-
//    tested on the Node side,
//  - keeping a single source of truth means the dashboard + MCP server see
//    identical results,
//  - I/O bound work makes the subprocess overhead negligible.
//
// If the CLI can't be found (npm install missing or broken PATH), we return
// the bare DashboardSnapshot skeleton the UI knows how to render — empty
// arrays + zeroed summary + a warning string so the dashboard surfaces the
// install issue instead of going blank.

use crate::cli::{dashboard_helper_command, run_cli_json, supervisor_startup_error};
use crate::snapshot_worker::{
    split_snapshot_reply, Coalescer, WorkerSlot, IDLE_LIMIT, REQUEST_TIMEOUT, RETRY_BACKOFF,
};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard, Once, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// The snapshot and the supervisor status, as the UI merges them.
type SnapshotParts = (Result<Value, String>, Result<Value, String>);

/// The dashboard's one helper, plus the latest refresh for callers that
/// queued behind it. A single lock also serializes the one-shot fallback, so
/// a stalled helper can't set off a burst of parallel fallbacks.
struct Refresher {
    helper: WorkerSlot,
    latest: Coalescer<SnapshotParts>,
}

static REFRESHER: Mutex<Refresher> = Mutex::new(Refresher {
    helper: WorkerSlot::new(RETRY_BACKOFF),
    latest: Coalescer::new(),
});
static IDLE_REAPER: Once = Once::new();

fn refresher() -> MutexGuard<'static, Refresher> {
    REFRESHER.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Stop the helper while the dashboard is hidden and not refreshing.
fn start_idle_reaper() {
    IDLE_REAPER.call_once(|| {
        thread::spawn(|| loop {
            thread::sleep(Duration::from_secs(30));
            refresher().helper.retire_if_idle(IDLE_LIMIT);
        });
    });
}

fn one_shot_parts(reason: String) -> SnapshotParts {
    eprintln!("paat-dashboard: dashboard helper unavailable ({reason}); using one-shot CLI calls");
    (
        run_cli_json(&["dashboard-snapshot"]),
        run_cli_json(&["supervisor", "status"]),
    )
}

/// Use the helper's reply when it has both parts; otherwise run `fallback`
/// with the reason the helper couldn't be used.
fn parts_or_fallback(
    helper: Result<Value, String>,
    fallback: impl FnOnce(String) -> SnapshotParts,
) -> SnapshotParts {
    match helper.map(split_snapshot_reply) {
        Ok((Ok(snapshot), Ok(supervisor))) => (Ok(snapshot), Ok(supervisor)),
        Ok((snapshot, supervisor)) => fallback(snapshot.and(supervisor).err().unwrap_or_default()),
        Err(error) => fallback(error),
    }
}

/// From the helper when possible, else from the original one-shot CLI calls
/// so the dashboard keeps working. Blocking: runs on a spawn_blocking thread.
fn fetch_snapshot_parts() -> SnapshotParts {
    let requested_at = Instant::now();
    start_idle_reaper();
    let mut guard = refresher();
    let Refresher { helper, latest } = &mut *guard;
    latest.run(requested_at, || {
        let reply = helper.request("snapshot", REQUEST_TIMEOUT, dashboard_helper_command);
        parts_or_fallback(reply, one_shot_parts)
    })
}

/// 0.2.3 fix: async + spawn_blocking. Previously this was a sync
/// `pub fn`, which Tauri runs on the **main UI thread**. Every 3-second
/// poll then blocked the message pump for ~500-1000 ms (cost of spawning
/// Node + reading lanes.json + scanning ports). If the user happened to
/// be dragging the window during that interval, Windows showed "Not
/// Responding" in the title bar. Making the command async + offloading the
/// blocking subprocess to a worker thread via tauri's async_runtime keeps
/// the UI thread free to pump WM_* messages even while the snapshot is
/// being computed.
#[tauri::command]
pub async fn get_snapshot() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(fetch_snapshot_parts)
        .await
        .map_err(|e| format!("snapshot worker join failed: {}", e))
        .and_then(|(res, supervisor_status)| merge_snapshot(res, supervisor_status))
}

/// Merge the supervisor's state into the snapshot as warnings. A failed
/// snapshot stays an error: disguising it as an empty dashboard told the
/// user no browsers were running. The UI keeps its last verified snapshot
/// and shows the error instead.
fn merge_snapshot(
    res: Result<Value, String>,
    supervisor_status: Result<Value, String>,
) -> Result<Value, String> {
    let mut v = res.map_err(|e| format!("paat CLI unavailable: {}", e))?;
    let mut add_warning = |warning: String| {
        if let Some(object) = v.as_object_mut() {
            let warnings = object.entry("warnings").or_insert_with(|| json!([]));
            if let Some(array) = warnings.as_array_mut() {
                array.push(json!(warning));
            }
        }
    };
    if let Some(error) = supervisor_startup_error() {
        add_warning(format!("Persistent browser supervisor unavailable: {}", error));
    }
    let running = supervisor_status
        .as_ref()
        .ok()
        .and_then(|status| status.get("running"))
        .and_then(Value::as_bool)
        == Some(true);
    if !running {
        add_warning("Persistent browser supervisor is not responding; new browser launches are disabled until PortPilot is restarted.".into());
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_snapshot_is_reported_not_disguised_as_an_empty_dashboard() {
        let result = merge_snapshot(Err("helper down".into()), Ok(json!({ "running": true })));
        assert_eq!(result.unwrap_err(), "paat CLI unavailable: helper down");
    }

    #[test]
    fn a_stopped_supervisor_becomes_a_snapshot_warning() {
        let merged = merge_snapshot(Ok(json!({ "ok": true })), Ok(json!({ "running": false }))).unwrap();
        let warnings = merged["warnings"].as_array().expect("warnings array");
        assert!(warnings.iter().any(|w| w.as_str().unwrap_or("").contains("not responding")));
    }

    fn fallback_marker(reason: String) -> SnapshotParts {
        (Err(format!("fallback: {reason}")), Err("fallback".into()))
    }

    #[test]
    fn uses_the_helper_reply_when_it_has_both_parts() {
        let (snapshot, supervisor) = parts_or_fallback(
            Ok(json!({ "snapshot": { "ok": true }, "supervisor": { "running": true } })),
            |_| panic!("fell back to one-shot CLI calls"),
        );
        assert_eq!(snapshot.unwrap(), json!({ "ok": true }));
        assert_eq!(supervisor.unwrap(), json!({ "running": true }));
    }

    #[test]
    fn falls_back_to_one_shot_calls_when_the_helper_is_unavailable() {
        let (snapshot, _) = parts_or_fallback(Err("helper down".into()), fallback_marker);
        assert_eq!(snapshot.unwrap_err(), "fallback: helper down");
    }

    #[test]
    fn falls_back_when_the_helper_reply_is_missing_a_part() {
        let (snapshot, _) =
            parts_or_fallback(Ok(json!({ "snapshot": { "ok": true } })), fallback_marker);
        assert_eq!(
            snapshot.unwrap_err(),
            "fallback: dashboard helper reply has no supervisor"
        );
    }
}
