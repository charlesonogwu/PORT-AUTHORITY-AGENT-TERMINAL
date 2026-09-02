// get_snapshot — shells out to `paat dashboard-snapshot --json` to get the
// full DashboardSnapshot shape the React UI consumes. This is the same data
// the old Express `/api/snapshot` endpoint returned.
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

use crate::cli::{run_cli_json, supervisor_startup_error};
use serde_json::{json, Value};

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
    tauri::async_runtime::spawn_blocking(|| {
        (
            run_cli_json(&["dashboard-snapshot"]),
            run_cli_json(&["supervisor", "status"]),
        )
    })
        .await
        .map_err(|e| format!("snapshot worker join failed: {}", e))
        .map(|(res, supervisor_status)| match res {
            Ok(mut v) => {
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
