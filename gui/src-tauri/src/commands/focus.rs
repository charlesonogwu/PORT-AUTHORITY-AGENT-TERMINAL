// focus_chrome / hide_chrome — Phase 5 stubs that return ok without doing
// anything. Phase 6 wires up SetForegroundWindow / ShowWindowAsync via Win32
// to match the behavior the old /api/focus + /api/hide endpoints had.
//
// We stub them now so the Tauri bridge in gui/src/api/client.ts compiles
// and the buttons in the UI don't throw — just no-op until Phase 6.

use serde_json::Value;

#[tauri::command]
pub fn focus_chrome(pid: u32) -> Result<Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "pid": pid,
        "stub": "focus_chrome not implemented yet (Phase 6)"
    }))
}

#[tauri::command]
pub fn hide_chrome(pid: u32) -> Result<Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "pid": pid,
        "stub": "hide_chrome not implemented yet (Phase 6)"
    }))
}
