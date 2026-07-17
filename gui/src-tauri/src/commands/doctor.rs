// get_doctor — Phase 6 real implementation. Shells out to `paat doctor --json`
// to run the install/config audit. Same rationale as snapshot.rs: the audit
// logic lives in Node and we want one source of truth.
//
// On CLI lookup failure we synthesize a single issue describing the failure
// instead of returning an error, so the UI's Doctor panel can show the user
// exactly what's wrong (install missing, PATH broken, etc.).

use crate::runtime::RuntimeState;
use serde_json::{json, Value};
use tauri::State;

/// 0.2.3 fix: async + spawn_blocking. See snapshot.rs for the rationale —
/// same root cause (sync command blocks Tauri main thread → window
/// "Not Responding" when user drags during the spawn).
#[tauri::command]
pub async fn get_doctor(runtime: State<'_, RuntimeState>) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.run_json(&["doctor".into()]))
        .await
        .map_err(|e| format!("doctor worker join failed: {}", e))
        .map(|res| match res {
            Ok(v) => v,
            Err(e) => json!({
                "ok": false,
                "issues": [{
                    "severity": "error",
                    "code": "cli-unavailable",
                    "message": format!("paat CLI unavailable: {}", e),
                    "fix": "Reinstall via `npm install -g port-authority-agent-terminal-mcp`."
                }]
            }),
        })
}
