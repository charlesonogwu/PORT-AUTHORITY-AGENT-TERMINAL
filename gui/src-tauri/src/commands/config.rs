// get_config — direct JSON read of ~/.portpilot/config.json.
// Returns sensible defaults when the file doesn't exist (first run).

use crate::runtime::RuntimeState;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn get_config(runtime: State<'_, RuntimeState>) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.run_json(&["config".into(), "show".into()])
    })
    .await
    .map_err(|e| format!("config worker join failed: {e}"))?
}

/// set_default_browser — write the dashboard's "Default browser" pick into
/// ~/.portpilot/config.json. Used for NEW lanes when an agent calls PortPilot
/// without naming a browser; an explicit per-call browser always wins, and
/// existing lanes keep theirs. Only the defaultBrowser key is touched — every
/// other config value is preserved.
#[tauri::command]
pub async fn set_default_browser(
    browser: String,
    runtime: State<'_, RuntimeState>,
) -> Result<Value, String> {
    const ALLOWED: [&str; 3] = ["chrome", "edge", "firefox"];
    if !ALLOWED.contains(&browser.as_str()) {
        return Err(format!(
            "invalid browser '{}' — must be one of chrome, edge, firefox",
            browser
        ));
    }
    let runtime = runtime.inner().clone();
    let browser_for_worker = browser.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.run_json(&[
            "config".into(),
            "set".into(),
            "defaultBrowser".into(),
            browser_for_worker,
        ])
    })
    .await
    .map_err(|e| format!("config worker join failed: {e}"))??;
    Ok(serde_json::json!({ "ok": true, "defaultBrowser": browser }))
}
