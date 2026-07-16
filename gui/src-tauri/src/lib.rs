// paat_dashboard_lib::run — Tauri shell entry point.
//
// We deliberately keep the Rust shell thin. Read-path commands (list_lanes,
// get_config) live in src/commands/ and parse ~/.portpilot/*.json directly.
// Write-path commands (Phase 6) will shell out to the existing Node CLI via
// `paat <subcommand> --json` so the CLI remains the single source of truth
// for mutations. See docs/superpowers/plans/2026-05-13-tauri-migration.md.

mod cli;
mod commands;
mod hide_watcher;
mod lifecycle;
#[cfg(target_os = "macos")]
mod macos_application;
mod paths;
mod process_identity;
mod runtime;

use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::Emitter;

#[cfg(target_os = "macos")]
fn install_macos_menu(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let refresh = MenuItem::with_id(
        app.handle(),
        "refresh-dashboard",
        "Refresh",
        true,
        Some("CommandOrControl+R"),
    )?;
    let show_portpilot = MenuItem::with_id(
        app.handle(),
        "show-portpilot",
        "Show PortPilot",
        true,
        None::<&str>,
    )?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            match submenu.text()?.as_str() {
                "View" => submenu.prepend(&refresh)?,
                "Window" => submenu.append_items(&[
                    &PredefinedMenuItem::separator(app.handle())?,
                    &PredefinedMenuItem::bring_all_to_front(app.handle(), None)?,
                    &show_portpilot,
                ])?,
                _ => {}
            }
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Shared set of pids the real-time watcher keeps off-screen.
    let hidden_pids: hide_watcher::HiddenPids =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let runtime = runtime::RuntimeState::load(&paths::runtime_provider_config_path());

    let app = tauri::Builder::default()
        // Single-instance plugin: a second `paat-dashboard.exe` invocation
        // brings the existing window to front instead of spawning a duplicate.
        // Replaces the Go launcher's mutex logic from v0.1.x.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if lifecycle::decision(
                lifecycle::LifecycleEvent::SecondLaunch,
                cfg!(target_os = "macos"),
            ) == lifecycle::LifecycleDecision::Restore
            {
                lifecycle::restore_main_window(app);
            }
        }))
        .manage(hidden_pids.clone())
        .manage(runtime)
        .setup(move |app| {
            // Start the real-time hide watcher: keeps every window of every
            // hidden lane off-screen within ~150ms of it appearing.
            hide_watcher::spawn(hidden_pids.clone());
            // macOS may launch an application without activating its first
            // window (for example via Finder or `open`). Make first launch
            // obey the same explicit restore contract as Dock reopen and a
            // second invocation.
            #[cfg(target_os = "macos")]
            {
                install_macos_menu(app)?;
                lifecycle::restore_main_window(app.handle());
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "refresh-dashboard" => {
                let _ = app.emit("refresh-dashboard", ());
            }
            "show-portpilot" => lifecycle::restore_main_window(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if lifecycle::decision(
                    lifecycle::LifecycleEvent::CloseRequested,
                    cfg!(target_os = "macos"),
                ) == lifecycle::LifecycleDecision::Hide
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::lanes::list_lanes,
            commands::snapshot::get_snapshot,
            commands::doctor::get_doctor,
            commands::config::get_config,
            commands::config::set_default_browser,
            commands::kill::kill_chrome,
            commands::erase::erase_chrome,
            commands::focus::focus_chrome,
            commands::focus::hide_chrome,
            commands::focus::unhide_chrome,
            hide_watcher::set_hidden_processes,
            runtime::get_runtime_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building PortPilot");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. })
            && lifecycle::decision(lifecycle::LifecycleEvent::Reopen, true)
                == lifecycle::LifecycleDecision::Restore
        {
            lifecycle::restore_main_window(app_handle);
        }
    });
}
