// get_doctor — Phase 4 stub. Phase 6 shells out to `paat doctor --json`
// for the real audit results.

use serde_json::Value;

#[tauri::command]
pub fn get_doctor() -> Result<Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "issues": []
    }))
}
