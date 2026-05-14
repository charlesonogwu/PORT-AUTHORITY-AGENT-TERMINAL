// list_lanes — direct JSON read of ~/.portpilot/lanes.json.
//
// We deserialize into `serde_json::Value` rather than mirror every TypeScript
// type as a Rust struct. The dashboard UI already has the canonical types
// from the Node side; the Rust shell just acts as a JSON pass-through.

use crate::paths::registry_path;
use serde_json::Value;

/// Read ~/.portpilot/lanes.json and return the `lanes` array.
/// Response shape matches the old `GET /api/snapshot` lanes field:
/// `{ ok: true, lanes: Lane[] }`.
#[tauri::command]
pub fn list_lanes() -> Result<Value, String> {
    let path = registry_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // First run — no registry yet. Return empty.
            return Ok(serde_json::json!({ "ok": true, "lanes": [] }));
        }
        Err(e) => return Err(format!("failed to read lanes.json: {}", e)),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid JSON in lanes.json: {}", e))?;
    let lanes = parsed.get("lanes").cloned().unwrap_or(Value::Array(vec![]));
    Ok(serde_json::json!({ "ok": true, "lanes": lanes }))
}
