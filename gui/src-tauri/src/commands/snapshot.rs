// get_snapshot — Phase 6 real implementation. Shells out to `paat status --json`
// to get the live snapshot (lanes + observations + warnings + scan errors).
//
// We delegate to the Node CLI rather than re-implementing port scanning in
// Rust because:
//  - the scan logic is already well-tested on the Node side,
//  - keeping a single source of truth means the dashboard + MCP server +
//    CLI all see identical results,
//  - port scanning is I/O bound, so the subprocess overhead is negligible.
//
// If the CLI can't be found (npm install missing or broken PATH), we return
// a shape the UI can still render — empty arrays plus a warning string so the
// dashboard surfaces the install issue instead of going blank.

use crate::cli::run_cli_json;
use serde_json::{json, Value};

#[tauri::command]
pub fn get_snapshot() -> Result<Value, String> {
    match run_cli_json(&["status"]) {
        Ok(v) => Ok(v),
        Err(e) => Ok(json!({
            "ok": false,
            "lanes": [],
            "observations": [],
            "warnings": [format!("paat CLI unavailable: {}", e)],
            "scanSource": "error",
            "scanErrors": [e]
        })),
    }
}
