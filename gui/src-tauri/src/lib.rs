// paat_dashboard_lib::run — Tauri shell entry point.
//
// We deliberately keep the Rust shell thin. Read-path commands (list_lanes,
// get_config) live in src/commands/ and parse ~/.portpilot/*.json directly.
// Write-path commands (Phase 6) will shell out to the existing Node CLI via
// `paat <subcommand> --json` so the CLI remains the single source of truth
// for mutations. See docs/superpowers/plans/2026-05-13-tauri-migration.md.

mod cli;
mod commands;
mod paths;

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
        .invoke_handler(tauri::generate_handler![
            commands::lanes::list_lanes,
            commands::snapshot::get_snapshot,
            commands::doctor::get_doctor,
            commands::config::get_config,
            commands::kill::kill_chrome,
            commands::focus::focus_chrome,
            commands::focus::hide_chrome,
        ])
        .run(tauri::generate_context!())
        .expect("error while running paat-dashboard");
}
