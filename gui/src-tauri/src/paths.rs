// Helpers that resolve PAAT filesystem locations. Mirrors src/core/paths.ts
// from the Node side so the Tauri dashboard reads the same files the CLI
// and MCP server read.

use std::path::PathBuf;

/// Resolve `~/.portpilot` (or `$PORTPILOT_HOME` if set). Matches the
/// `portpilotHome()` function in src/core/paths.ts.
pub fn portpilot_home() -> PathBuf {
    if let Ok(override_dir) = std::env::var("PORTPILOT_HOME") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".portpilot")
}

/// `~/.portpilot/lanes.json` — the canonical lane registry.
pub fn registry_path() -> PathBuf {
    portpilot_home().join("lanes.json")
}

/// `~/.portpilot/config.json` — per-machine config (max lanes, port ranges, etc.).
pub fn config_path() -> PathBuf {
    portpilot_home().join("config.json")
}
