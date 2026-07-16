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

/// Release B's prototype runtime selection lives outside the shared lane
/// state. Finder-launched apps do not inherit a shell PATH, so this file holds
/// explicit verified absolute paths for the InstalledRuntimeProvider.
pub fn runtime_provider_config_path() -> PathBuf {
    if let Ok(path) = std::env::var("PORTPILOT_RUNTIME_CONFIG") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("com.charlesonogwu.portpilot")
            .join("runtime-provider.json")
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        return PathBuf::from(base)
            .join("PortPilot")
            .join("runtime-provider.json");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        portpilot_home().join("runtime-provider.json")
    }
}
