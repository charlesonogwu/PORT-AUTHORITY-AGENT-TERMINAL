// get_snapshot — returns the full DashboardSnapshot shape the React UI
// consumes, plus the supervisor's health. This is the same data the old
// Express `/api/snapshot` endpoint returned.
//
// Each refresh is one request to the long-lived `paat dashboard-serve`
// helper (snapshot_worker.rs), avoiding a fresh Node process for each call.
// Native port/process scanners can still run as child processes. Previously
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
//  - the helper amortizes Node startup across refreshes.
//
// If the CLI can't be found (npm install missing or broken PATH), we return
// the bare DashboardSnapshot skeleton the UI knows how to render — empty
// arrays + zeroed summary + a warning string so the dashboard surfaces the
// install issue instead of going blank.

use crate::cli::supervisor_startup_error;
#[cfg(target_os = "windows")]
use crate::cli::{dashboard_helper_command, run_cli_json};
#[cfg(not(target_os = "windows"))]
use crate::runtime::RuntimeState;
use crate::snapshot_worker::{
    split_snapshot_reply, Coalescer, WorkerSlot, IDLE_LIMIT, REQUEST_TIMEOUT, RETRY_BACKOFF,
};
use serde_json::{json, Value};
#[cfg(not(target_os = "windows"))]
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard, Once, PoisonError};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;

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

fn one_shot_parts(
    #[cfg(not(target_os = "windows"))] runtime: &RuntimeState,
    reason: String,
) -> SnapshotParts {
    eprintln!("paat-dashboard: dashboard helper unavailable ({reason}); using one-shot CLI calls");
    #[cfg(target_os = "windows")]
    {
        (
            run_cli_json(&["dashboard-snapshot"]),
            run_cli_json(&["supervisor", "status"]),
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        (
            runtime.run_json(&["dashboard-snapshot".into()]),
            runtime.run_json(&["supervisor".into(), "status".into()]),
        )
    }
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
fn fetch_snapshot_parts(
    #[cfg(not(target_os = "windows"))] runtime: &RuntimeState,
) -> SnapshotParts {
    let requested_at = Instant::now();
    start_idle_reaper();
    let mut guard = refresher();
    let Refresher { helper, latest } = &mut *guard;
    latest.run(requested_at, || {
        #[cfg(target_os = "windows")]
        {
            let reply = helper.request("snapshot", REQUEST_TIMEOUT, dashboard_helper_command);
            parts_or_fallback(reply, one_shot_parts)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let reply = helper.request("snapshot", REQUEST_TIMEOUT, || {
                runtime.dashboard_helper_command()
            });
            parts_or_fallback(reply, |reason| one_shot_parts(runtime, reason))
        }
    })
}

#[cfg(not(target_os = "windows"))]
fn append_verified_firefox(snapshot: &mut Value, lane: &Value, checked: &Value) -> bool {
    if lane.get("browser").and_then(Value::as_str) != Some("firefox")
        || lane.get("status").and_then(Value::as_str) == Some("released")
        || checked.pointer("/verdict/kind").and_then(Value::as_str) != Some("safe-attach")
    {
        return false;
    }
    let lane_id = match lane.get("id").and_then(Value::as_str) {
        Some(value) => value,
        None => return false,
    };
    if checked.pointer("/lane/id").and_then(Value::as_str) != Some(lane_id) {
        return false;
    }
    let observation = match checked.pointer("/verdict/observation") {
        Some(value) => value,
        None => return false,
    };
    let command_line = match observation.get("commandLine").and_then(Value::as_str) {
        Some(value) if value.split_whitespace().any(|part| part == "-no-remote") => value,
        _ => return false,
    };
    let pid = match observation.get("pid").and_then(Value::as_u64) {
        Some(value) => value,
        None => return false,
    };
    let port = match lane.get("chromeDebugPort").and_then(Value::as_u64) {
        Some(value) => value,
        None => return false,
    };
    let profile = match lane.get("chromeProfileDir").and_then(Value::as_str) {
        Some(value) if command_line.contains(value) => value,
        _ => return false,
    };
    let sessions = match snapshot
        .get_mut("liveSessions")
        .and_then(Value::as_array_mut)
    {
        Some(value) => value,
        None => return false,
    };
    if sessions.iter().any(|session| {
        session.get("laneId").and_then(Value::as_str) == Some(lane_id)
            || session.get("pid").and_then(Value::as_u64) == Some(pid)
    }) {
        return false;
    }
    let owner = lane.get("owner").and_then(Value::as_str).unwrap_or("agent");
    let project = lane
        .get("project")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut session = json!({
        "key": format!("{pid}:{port}:{profile}"),
        "agent": owner,
        "agentConfidence": "registered",
        "project": project,
        "projectConfidence": "registered",
        "cwdConfidence": "registered",
        "pid": pid,
        "chromeDebugPort": port,
        "debugMode": "port",
        "chromeProfileDir": profile,
        "browser": "firefox",
        "hasSavedData": false,
        "tabs": [],
        "primaryTabs": [],
        "registeredBy": "portpilot",
        "laneId": lane_id,
        "cdpError": "Firefox lane: BiDi debug port (not Chrome CDP) — tab list unavailable; drive it with the page tools"
    });
    for field in ["cwd", "task", "appPort"] {
        if let Some(value) = lane.get(field) {
            session[field] = value.clone();
        }
    }
    sessions.push(session);
    true
}

#[cfg(not(target_os = "windows"))]
fn refresh_summary(snapshot: &mut Value) {
    let (count, agent_count) = {
        let sessions = match snapshot.get("liveSessions").and_then(Value::as_array) {
            Some(value) => value,
            None => return,
        };
        let agents: HashSet<&str> = sessions
            .iter()
            .filter_map(|session| session.get("agent").and_then(Value::as_str))
            .collect();
        (sessions.len() as u64, agents.len())
    };
    if let Some(summary) = snapshot.get_mut("summary") {
        summary["liveSessions"] = json!(count);
        summary["distinctAgents"] = json!(agent_count);
    }
}

#[cfg(not(target_os = "windows"))]
fn enrich_release_a_firefox(runtime: &RuntimeState, snapshot: &mut Value) {
    if runtime.portpilot_version() != Some("0.4.0") {
        return;
    }
    let listed = match runtime.run_json(&["list".into()]) {
        Ok(value) => value,
        Err(_) => return,
    };
    let lanes = match listed.get("lanes").and_then(Value::as_array) {
        Some(value) => value,
        None => return,
    };
    for lane in lanes {
        if lane.get("browser").and_then(Value::as_str) != Some("firefox")
            || lane.get("status").and_then(Value::as_str) == Some("released")
        {
            continue;
        }
        let (owner, cwd, session) = match (
            lane.get("owner").and_then(Value::as_str),
            lane.get("cwd").and_then(Value::as_str),
            lane.get("sessionId").and_then(Value::as_str),
        ) {
            (Some(owner), Some(cwd), Some(session)) => (owner, cwd, session),
            _ => continue,
        };
        let args = vec![
            "check".into(),
            "--owner".into(),
            owner.into(),
            "--cwd".into(),
            cwd.into(),
            "--session".into(),
            session.into(),
            "--browser".into(),
            "firefox".into(),
            "--json".into(),
        ];
        if let Ok(checked) = runtime.run_json(&args) {
            append_verified_firefox(snapshot, lane, &checked);
        }
    }
    refresh_summary(snapshot);
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
pub async fn get_snapshot(
    _runtime: State<'_, crate::runtime::RuntimeState>,
) -> Result<Value, String> {
    #[cfg(not(target_os = "windows"))]
    let runtime = _runtime.inner().clone();
    #[cfg(not(target_os = "windows"))]
    let snapshot_runtime = runtime.clone();
    #[cfg(not(target_os = "windows"))]
    let fetch = move || fetch_snapshot_parts(&snapshot_runtime);
    #[cfg(target_os = "windows")]
    let fetch = fetch_snapshot_parts;
    tauri::async_runtime::spawn_blocking(fetch)
        .await
        .map_err(|e| format!("snapshot worker join failed: {}", e))
        .map(|(res, supervisor_status)| match res {
            Ok(mut v) => {
                #[cfg(not(target_os = "windows"))]
                { enrich_release_a_firefox(&runtime, &mut v);
                  crate::process_identity::enrich_snapshot(&mut v); }
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
                v
            }
            Err(e) => json!({
                "ok": false,
                "generatedAt": "",
                "scanSource": "empty",
                "scanErrors": [e.clone()],
                "home": "",
                "registryPath": "",
                "config": {},
                "summary": { "liveSessions": 0, "distinctAgents": 0, "conflicts": 0 },
                "liveSessions": [],
                "registryHealth": { "portpilot": { "exists": false, "lockHealthy": false } },
                "conflicts": [],
                "warnings": [format!("paat CLI unavailable: {}", e)]
            }),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn release_a_firefox_adapter_requires_verified_exact_lane() {
        let lane = json!({
            "id": "lane_ff", "owner": "agent", "project": "demo",
            "cwd": "/tmp/demo", "sessionId": "ff", "appPort": 3001,
            "chromeDebugPort": 9323, "chromeProfileDir": "/tmp/pp/profiles/ff",
            "browser": "firefox", "status": "active"
        });
        let checked = json!({
            "verdict": { "kind": "safe-attach", "observation": {
                "pid": 123, "commandLine": "firefox -profile /tmp/pp/profiles/ff -no-remote --remote-debugging-port 9323"
            }},
            "lane": { "id": "lane_ff" }
        });
        let mut snapshot = json!({
            "summary": { "liveSessions": 0, "distinctAgents": 0, "conflicts": 0 },
            "liveSessions": []
        });
        assert!(append_verified_firefox(&mut snapshot, &lane, &checked));
        refresh_summary(&mut snapshot);
        assert_eq!(snapshot.pointer("/summary/liveSessions"), Some(&json!(1)));
        assert_eq!(
            snapshot.pointer("/liveSessions/0/browser"),
            Some(&json!("firefox"))
        );

        let mut wrong = checked.clone();
        wrong["lane"]["id"] = json!("foreign");
        assert!(!append_verified_firefox(&mut snapshot, &lane, &wrong));
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
