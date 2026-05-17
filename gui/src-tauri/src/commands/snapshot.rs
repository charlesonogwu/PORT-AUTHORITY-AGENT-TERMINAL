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

use crate::cli::run_cli_json;
use serde_json::{json, Value};

#[tauri::command]
pub fn get_snapshot() -> Result<Value, String> {
    match run_cli_json(&["dashboard-snapshot"]) {
        Ok(v) => Ok(v),
        Err(e) => Ok(json!({
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
        })),
    }
}
