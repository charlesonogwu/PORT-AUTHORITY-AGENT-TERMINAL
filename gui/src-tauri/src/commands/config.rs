// get_config — direct JSON read of ~/.portpilot/config.json.
// Returns sensible defaults when the file doesn't exist (first run).

use crate::paths::config_path;
use serde_json::Value;

#[tauri::command]
pub fn get_config() -> Result<Value, String> {
    let path = config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({ "ok": true, "config": { "version": 1 } }));
        }
        Err(e) => return Err(format!("failed to read config.json: {}", e)),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid JSON in config.json: {}", e))?;
    Ok(serde_json::json!({ "ok": true, "config": parsed }))
}
