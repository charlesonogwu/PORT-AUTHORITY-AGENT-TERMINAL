// get_snapshot — Phase 4 stub. Returns empty arrays so the UI renders
// without erroring out. Phase 6 replaces this with a real implementation
// that shells out to `paat status --json` to get live port observations,
// stale-lane warnings, etc.

use serde_json::Value;

#[tauri::command]
pub fn get_snapshot() -> Result<Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "lanes": [],
        "observations": [],
        "warnings": [],
        "scanSource": "stub",
        "scanErrors": []
    }))
}
