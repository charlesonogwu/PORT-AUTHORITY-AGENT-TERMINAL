use crate::cli::quiet_command;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

const RUNTIME_IDENTITY: &str = "portpilot-runtime";
const RUNTIME_PROTOCOL_VERSION: u32 = 1;
const REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntimeConfig {
    pub node_executable: PathBuf,
    pub package_root: PathBuf,
    pub cli_entry: PathBuf,
    pub expected_portpilot_version: String,
    pub portpilot_home: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "provider", rename_all = "kebab-case")]
pub enum RuntimeProviderConfig {
    Installed(InstalledRuntimeConfig),
    Bundled,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHandshake {
    pub ok: bool,
    pub identity: String,
    pub portpilot_version: String,
    pub protocol_version: u32,
    pub registry_schema_version: u32,
    pub platform: String,
    pub architecture: String,
}

pub trait RuntimeProvider: Send + Sync {
    fn handshake(&self) -> &RuntimeHandshake;
    fn run_json(&self, args: &[String]) -> Result<Value, String>;
    #[cfg(not(target_os = "windows"))]
    fn dashboard_helper_command(&self) -> Result<Command, String>;
    #[cfg(not(target_os = "windows"))]
    fn supervisor_command(&self) -> Result<Command, String>;
}

#[derive(Clone)]
pub struct RuntimeState {
    provider: Option<Arc<dyn RuntimeProvider>>,
    error: Option<String>,
}

impl RuntimeState {
    #[cfg(target_os = "macos")]
    pub fn load(config_path: &Path) -> Self {
        match Self::try_load(config_path) {
            Ok(provider) => Self {
                provider: Some(provider),
                error: None,
            },
            Err(error) => Self {
                provider: None,
                error: Some(error),
            },
        }
    }

    fn try_load(config_path: &Path) -> Result<Arc<dyn RuntimeProvider>, String> {
        let raw = fs::read_to_string(config_path).map_err(|e| {
            format!(
                "PortPilot runtime configuration is unavailable at {}: {e}",
                config_path.display()
            )
        })?;
        let config: RuntimeProviderConfig = serde_json::from_str(&raw)
            .map_err(|e| format!("invalid PortPilot runtime configuration: {e}"))?;
        match config {
            RuntimeProviderConfig::Installed(config) => {
                Ok(Arc::new(InstalledRuntimeProvider::load(config)?))
            }
            RuntimeProviderConfig::Bundled => Err(
                "the bundled PortPilot runtime provider is reserved for a future release".into(),
            ),
        }
    }

    pub fn status_json(&self) -> Value {
        match (&self.provider, &self.error) {
            (Some(provider), _) => serde_json::json!({
                "ok": true,
                "provider": "installed",
                "handshake": provider.handshake(),
            }),
            (_, Some(error)) => serde_json::json!({
                "ok": false,
                "provider": "unavailable",
                "error": error,
            }),
            _ => serde_json::json!({
                "ok": false,
                "provider": "unavailable",
                "error": "PortPilot runtime provider is unavailable",
            }),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn run_json(&self, args: &[String]) -> Result<Value, String> {
        self.provider
            .as_ref()
            .ok_or_else(|| {
                self.error
                    .clone()
                    .unwrap_or_else(|| "PortPilot runtime provider is unavailable".into())
            })?
            .run_json(args)
    }

    /// Start the helper through the same verified runtime as one-shot calls.
    #[cfg(target_os = "macos")]
    pub fn dashboard_helper_command(&self) -> Result<Command, String> {
        self.provider
            .as_ref()
            .ok_or_else(|| {
                self.error
                    .clone()
                    .unwrap_or_else(|| "PortPilot runtime provider is unavailable".into())
            })?
            .dashboard_helper_command()
    }

    /// The native app owns the supervisor lifetime; never start it under an MCP worker.
    #[cfg(target_os = "macos")]
    pub fn start_supervisor_background(&self) -> Result<(), String> {
        let provider = self.provider.as_ref().ok_or_else(|| {
            self.error
                .clone()
                .unwrap_or_else(|| "PortPilot runtime provider is unavailable".into())
        })?;
        let mut command = provider.supervisor_command()?;
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to start the verified PortPilot supervisor: {e}"))?;
        // Reap the child even after readiness, without tying its lifetime to the dashboard.
        let pid = child.id();
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        for _ in 0..100 {
            if self
                .run_json(&["supervisor".into(), "status".into()])
                .ok()
                .and_then(|value| value.get("running").and_then(Value::as_bool))
                == Some(true)
            {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err(format!(
            "verified PortPilot supervisor (pid {pid}) did not become ready within 10 seconds"
        ))
    }
}

#[tauri::command]
pub fn get_runtime_status(state: tauri::State<'_, RuntimeState>) -> Value {
    state.status_json()
}

pub struct InstalledRuntimeProvider {
    node_executable: PathBuf,
    cli_entry: PathBuf,
    handshake: RuntimeHandshake,
    portpilot_home: Option<PathBuf>,
}

#[derive(Deserialize)]
struct PackageMetadata {
    name: String,
    version: String,
}

pub fn expected_node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

pub fn expected_node_architecture() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

pub fn validate_absolute_paths(config: &InstalledRuntimeConfig) -> Result<(), String> {
    for (label, path) in [
        ("nodeExecutable", &config.node_executable),
        ("packageRoot", &config.package_root),
        ("cliEntry", &config.cli_entry),
    ] {
        if !path.is_absolute() {
            return Err(format!("runtime {label} must be an absolute path"));
        }
    }
    if let Some(path) = &config.portpilot_home {
        if !path.is_absolute() {
            return Err("runtime portpilotHome must be an absolute path".into());
        }
    }
    Ok(())
}

pub fn validate_handshake(
    handshake: &RuntimeHandshake,
    expected_version: &str,
) -> Result<(), String> {
    if !handshake.ok {
        return Err("runtime handshake reported failure".into());
    }
    if handshake.identity != RUNTIME_IDENTITY {
        return Err("unrecognized PortPilot runtime identity".into());
    }
    if handshake.portpilot_version != expected_version {
        return Err(format!(
            "PortPilot runtime version mismatch: expected {expected_version}, received {}",
            handshake.portpilot_version
        ));
    }
    if handshake.protocol_version != RUNTIME_PROTOCOL_VERSION {
        return Err(format!(
            "PortPilot runtime protocol mismatch: expected {RUNTIME_PROTOCOL_VERSION}, received {}",
            handshake.protocol_version
        ));
    }
    if handshake.registry_schema_version != REGISTRY_SCHEMA_VERSION {
        return Err(format!(
            "PortPilot registry schema mismatch: expected {REGISTRY_SCHEMA_VERSION}, received {}",
            handshake.registry_schema_version
        ));
    }
    if handshake.platform != expected_node_platform() {
        return Err(format!(
            "PortPilot runtime platform mismatch: expected {}, received {}",
            expected_node_platform(),
            handshake.platform
        ));
    }
    if handshake.architecture != expected_node_architecture() {
        return Err(format!(
            "PortPilot runtime architecture mismatch: expected {}, received {}",
            expected_node_architecture(),
            handshake.architecture
        ));
    }
    Ok(())
}

fn canonical_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("runtime {label} is unavailable: {e}"))?;
    let metadata =
        fs::metadata(&canonical).map_err(|e| format!("could not inspect runtime {label}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("runtime {label} is not a regular file"));
    }
    Ok(canonical)
}

fn canonical_portpilot_home(path: Option<&Path>) -> Result<Option<PathBuf>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("runtime portpilotHome is unavailable: {e}"))?;
    if !fs::metadata(&canonical)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Err("runtime portpilotHome is not a directory".into());
    }
    Ok(Some(canonical))
}

impl InstalledRuntimeProvider {
    pub fn load(config: InstalledRuntimeConfig) -> Result<Self, String> {
        validate_absolute_paths(&config)?;
        let package_root = fs::canonicalize(&config.package_root)
            .map_err(|e| format!("runtime packageRoot is unavailable: {e}"))?;
        if !fs::metadata(&package_root)
            .map(|m| m.is_dir())
            .unwrap_or(false)
        {
            return Err("runtime packageRoot is not a directory".into());
        }
        let node_executable = canonical_file(&config.node_executable, "nodeExecutable")?;
        let cli_entry = canonical_file(&config.cli_entry, "cliEntry")?;
        let portpilot_home = canonical_portpilot_home(config.portpilot_home.as_deref())?;
        if !cli_entry.starts_with(&package_root) {
            return Err("runtime cliEntry escapes the verified packageRoot".into());
        }

        let package_path = package_root.join("package.json");
        let package: PackageMetadata = serde_json::from_str(
            &fs::read_to_string(&package_path)
                .map_err(|e| format!("could not read runtime package metadata: {e}"))?,
        )
        .map_err(|e| format!("invalid runtime package metadata: {e}"))?;
        if package.name != "port-authority-agent-terminal-mcp" {
            return Err("runtime package identity is not PortPilot".into());
        }
        if package.version != config.expected_portpilot_version {
            return Err(format!(
                "runtime package version mismatch: expected {}, found {}",
                config.expected_portpilot_version, package.version
            ));
        }

        let mut provider = Self {
            node_executable,
            cli_entry,
            handshake: RuntimeHandshake {
                ok: false,
                identity: String::new(),
                portpilot_version: String::new(),
                protocol_version: 0,
                registry_schema_version: 0,
                platform: String::new(),
                architecture: String::new(),
            },
            portpilot_home,
        };
        let value = provider.run_direct(&["runtime-handshake".into(), "--json".into()])?;
        let handshake: RuntimeHandshake = serde_json::from_value(value)
            .map_err(|e| format!("invalid PortPilot runtime handshake: {e}"))?;
        validate_handshake(&handshake, &config.expected_portpilot_version)?;
        provider.handshake = handshake;
        Ok(provider)
    }

    fn command(&self) -> Command {
        let mut command = quiet_command(&self.node_executable);
        command.env_clear();
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        command.arg(&self.cli_entry);
        if let Some(home) = &self.portpilot_home {
            command.env("PORTPILOT_HOME", home);
        }
        command
    }

    fn run_direct(&self, args: &[String]) -> Result<Value, String> {
        let output = self
            .command()
            .args(args)
            .output()
            .map_err(|e| format!("failed to start the verified PortPilot runtime: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let code = output.status.code().unwrap_or(-1);
            return Err(format!(
                "verified PortPilot runtime exited {code}: {}",
                stderr.trim()
            ));
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("invalid JSON from the verified PortPilot runtime: {e}"))
    }
}

impl RuntimeProvider for InstalledRuntimeProvider {
    #[cfg(not(target_os = "windows"))]
    fn supervisor_command(&self) -> Result<Command, String> {
        let mut command = self.command();
        command.args(["supervisor", "serve"]);
        Ok(command)
    }

    #[cfg(not(target_os = "windows"))]
    fn dashboard_helper_command(&self) -> Result<Command, String> {
        let mut command = self.command();
        command.arg("dashboard-serve");
        Ok(command)
    }

    fn handshake(&self) -> &RuntimeHandshake {
        &self.handshake
    }

    fn run_json(&self, args: &[String]) -> Result<Value, String> {
        let mut full_args = args.to_vec();
        if !full_args.iter().any(|arg| arg == "--json") {
            full_args.push("--json".into());
        }
        self.run_direct(&full_args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compatible() -> RuntimeHandshake {
        RuntimeHandshake {
            ok: true,
            identity: "portpilot-runtime".into(),
            portpilot_version: "0.4.7".into(),
            protocol_version: 1,
            registry_schema_version: 1,
            platform: expected_node_platform().into(),
            architecture: expected_node_architecture().into(),
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn helper_uses_the_verified_node_cli_and_home_without_a_path_lookup() {
        let provider = InstalledRuntimeProvider {
            node_executable: PathBuf::from("/verified/node"),
            cli_entry: PathBuf::from("/verified/package/dist/cli.js"),
            portpilot_home: Some(PathBuf::from("/verified/home")),
            handshake: compatible(),
        };
        let command = provider.dashboard_helper_command().unwrap();
        assert_eq!(command.get_program(), "/verified/node");
        assert!(command.get_envs().any(|(key, value)| key == "PATH"
            && value == Some(std::ffi::OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin"))));
        assert!(!command.get_envs().any(|(key, _)| key == "NODE_OPTIONS"
            || key == "NODE_PATH"
            || key == "DYLD_INSERT_LIBRARIES"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec!["/verified/package/dist/cli.js", "dashboard-serve"]
        );
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "PORTPILOT_HOME"
                && value == Some(std::ffi::OsStr::new("/verified/home"))));
        let supervisor = provider.supervisor_command().unwrap();
        assert_eq!(supervisor.get_program(), command.get_program());
        assert_eq!(
            supervisor.get_args().collect::<Vec<_>>(),
            vec!["/verified/package/dist/cli.js", "supervisor", "serve"]
        );
        let direct = provider.command();
        assert_eq!(direct.get_program(), command.get_program());
        assert_eq!(direct.get_args().next(), command.get_args().next());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unavailable_runtime_cannot_start_a_helper() {
        let state = RuntimeState {
            provider: None,
            error: Some("verification failed".into()),
        };
        assert_eq!(
            state.dashboard_helper_command().unwrap_err(),
            "verification failed"
        );
    }

    #[test]
    #[ignore = "child process inherits hostile Node settings to test environment isolation"]
    fn environment_probe_worker() {
        let provider = InstalledRuntimeProvider {
            node_executable: PathBuf::from("/usr/bin/env"),
            cli_entry: PathBuf::from("/usr/bin/env"),
            portpilot_home: None,
            handshake: compatible(),
        };
        let output = provider.command().output().unwrap();
        assert!(output.status.success());
        let environment = String::from_utf8(output.stdout).unwrap();
        for key in ["NODE_OPTIONS=", "NODE_PATH=", "PORTPILOT_INJECTED_SETTING="] {
            assert!(!environment.lines().any(|line| line.starts_with(key)));
        }
        assert!(environment
            .lines()
            .any(|line| line == "PATH=/usr/bin:/bin:/usr/sbin:/sbin"));
    }

    #[test]
    fn verified_runtime_drops_node_injection_and_unlisted_environment_settings() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "runtime::tests::environment_probe_worker",
                "--ignored",
                "--nocapture",
            ])
            .env("NODE_OPTIONS", "--require=/untrusted/injection.js")
            .env("NODE_PATH", "/untrusted/modules")
            .env("PORTPILOT_INJECTED_SETTING", "untrusted")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn accepts_a_compatible_runtime_handshake() {
        assert!(validate_handshake(&compatible(), "0.4.7").is_ok());
    }

    #[test]
    fn rejects_wrong_identity_version_protocol_schema_platform_and_architecture() {
        type HandshakeMutation = (&'static str, Box<dyn Fn(&mut RuntimeHandshake)>);
        let mutations: Vec<HandshakeMutation> = vec![
            (
                "identity",
                Box::new(|h| h.identity = "foreign-runtime".into()),
            ),
            (
                "version",
                Box::new(|h| h.portpilot_version = "9.9.9".into()),
            ),
            ("protocol", Box::new(|h| h.protocol_version = 2)),
            ("schema", Box::new(|h| h.registry_schema_version = 2)),
            ("platform", Box::new(|h| h.platform = "foreign-os".into())),
            (
                "architecture",
                Box::new(|h| h.architecture = "foreign-arch".into()),
            ),
        ];
        for (label, mutate) in mutations {
            let mut handshake = compatible();
            mutate(&mut handshake);
            assert!(validate_handshake(&handshake, "0.4.7").is_err(), "{label}");
        }
    }

    #[test]
    fn rejects_relative_runtime_paths() {
        let config = InstalledRuntimeConfig {
            node_executable: "node".into(),
            package_root: "package".into(),
            cli_entry: "dist/src/cli/index.js".into(),
            expected_portpilot_version: "0.4.7".into(),
            portpilot_home: None,
        };
        assert!(validate_absolute_paths(&config).is_err());
    }

    #[test]
    fn rejects_a_missing_explicit_portpilot_home_instead_of_silently_falling_back() {
        let missing = std::env::temp_dir().join(format!(
            "portpilot-missing-runtime-home-{}",
            std::process::id()
        ));
        assert!(canonical_portpilot_home(Some(&missing)).is_err());
        assert_eq!(canonical_portpilot_home(None).unwrap(), None);
    }
}
