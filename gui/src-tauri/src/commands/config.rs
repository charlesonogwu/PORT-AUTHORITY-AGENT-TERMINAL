#[cfg(target_os = "macos")]
mod platform {
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
}
#[cfg(not(target_os = "macos"))]
mod platform {
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
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|e| format!("invalid JSON in config.json: {}", e))?;
        Ok(serde_json::json!({ "ok": true, "config": parsed }))
    }

    /// set_default_browser — write the dashboard's "Default browser" pick into
    /// ~/.portpilot/config.json. Used for NEW lanes when an agent calls PortPilot
    /// without naming a browser; an explicit per-call browser always wins, and
    /// existing lanes keep theirs. Only the defaultBrowser key is touched — every
    /// other config value is preserved.
    #[tauri::command]
    pub fn set_default_browser(browser: String) -> Result<Value, String> {
        const ALLOWED: [&str; 3] = ["chrome", "edge", "firefox"];
        if !ALLOWED.contains(&browser.as_str()) {
            return Err(format!(
                "invalid browser '{}' — must be one of chrome, edge, firefox",
                browser
            ));
        }
        let path = config_path();
        let mut config: Value = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s)
                .map_err(|e| format!("invalid JSON in config.json: {}", e))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                serde_json::json!({ "version": 1 })
            }
            Err(e) => return Err(format!("failed to read config.json: {}", e)),
        };
        let obj = config
            .as_object_mut()
            .ok_or_else(|| "config.json is not a JSON object".to_string())?;
        obj.insert("defaultBrowser".into(), Value::String(browser.clone()));
        obj.insert("version".into(), serde_json::json!(1));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
        }
        let pretty = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("failed to serialize config: {}", e))?;
        std::fs::write(&path, pretty).map_err(|e| format!("failed to write config.json: {}", e))?;
        Ok(serde_json::json!({ "ok": true, "defaultBrowser": browser }))
    }
}
pub use platform::*;
