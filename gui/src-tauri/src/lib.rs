// paat_dashboard_lib::run — Tauri shell entry point.
//
// We deliberately keep the Rust shell thin. Read-path commands (list_lanes,
// get_config) live in src/commands/ and parse ~/.portpilot/*.json directly.
// Write-path commands (kill, install-mcp, reserve) shell out to the existing
// Node CLI via run_cli_json so the CLI remains the single source of truth
// for mutations. See docs/superpowers/plans/2026-05-13-tauri-migration.md.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance plugin: a second `paat-dashboard.exe` invocation
        // brings the existing window to front instead of spawning a duplicate.
        // Replaces the Go launcher's mutex logic from v0.1.x.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .run(tauri::generate_context!())
        .expect("error while running paat-dashboard");
}
