// Windows/Linux retain the installed CLI path and never require Mac configuration.
use serde_json::{json, Value};
use std::{path::Path, process::Command};
#[derive(Clone)]
pub struct RuntimeState;
impl RuntimeState {
    pub fn load(_config_path: &Path) -> Self {
        Self
    }
    pub fn run_json(&self, args: &[String]) -> Result<Value, String> {
        crate::cli::run_cli_json(&args.iter().map(String::as_str).collect::<Vec<_>>())
    }
    pub fn dashboard_helper_command(&self) -> Result<Command, String> {
        crate::cli::dashboard_helper_command()
    }
}
#[tauri::command]
pub fn get_runtime_status() -> Value {
    json!({ "ok": true, "provider": "cli" })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_does_not_require_a_macos_provider_config() {
        let runtime = RuntimeState::load(Path::new("missing-runtime-provider.json"));
        assert!(get_runtime_status()["ok"].as_bool().unwrap());
        // Exercise the CLI command builder without launching any browser.
        let command = runtime.dashboard_helper_command();
        if let Err(error) = command {
            assert!(!error.contains("runtime configuration"));
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    #[test]
    #[ignore = "isolated child with a fake installed CLI and no runtime configuration"]
    fn runtime_without_config_worker() {
        let root = std::env::var_os("PORTPILOT_HOME").unwrap();
        let missing = Path::new(&root).join("runtime-provider.json");
        assert!(!missing.exists());
        let runtime = RuntimeState::load(&missing);
        for args in [
            vec!["doctor".into()],
            vec!["dashboard-snapshot".into()],
            vec!["supervisor".into(), "status".into()],
        ] {
            assert_eq!(runtime.run_json(&args).unwrap()["ok"], true);
        }
        let helper = runtime.dashboard_helper_command().unwrap();
        assert!(helper.get_program().to_string_lossy().ends_with("paat.cmd"));
        crate::commands::config::set_default_browser("edge".into()).unwrap();
        assert_eq!(
            crate::commands::config::get_config().unwrap()["config"]["defaultBrowser"],
            "edge"
        );
    }

    #[test]
    fn windows_dashboard_uses_its_cli_without_a_runtime_config() {
        let root =
            std::env::temp_dir().join(format!("portpilot-no-provider-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("paat.cmd"), "@echo off\r\necho {\"ok\":true}\r\n").unwrap();
        let mut paths = vec![root.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "runtime::windows_tests::runtime_without_config_worker",
                "--ignored",
                "--nocapture",
            ])
            .env("PORTPILOT_HOME", &root)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .output()
            .unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
