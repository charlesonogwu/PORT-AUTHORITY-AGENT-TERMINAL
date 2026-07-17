use crate::cli::quiet_command;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
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
}

#[derive(Clone)]
pub struct RuntimeState {
    provider: Option<Arc<dyn RuntimeProvider>>,
    error: Option<String>,
}

impl RuntimeState {
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

    pub fn portpilot_version(&self) -> Option<&str> {
        self.provider
            .as_ref()
            .map(|provider| provider.handshake().portpilot_version.as_str())
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

fn validate_release_a_action(
    lane_id: &str,
    requested_pid: u64,
    lane: &Value,
    checked: &Value,
) -> Result<Value, String> {
    if lane.get("status").and_then(Value::as_str) == Some("released") {
        return Err("refused dashboard action: lane is released".into());
    }
    if checked
        .get("lane")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        != Some(lane_id)
    {
        return Err("refused dashboard action: checked lane identity changed".into());
    }
    let verdict = checked
        .get("verdict")
        .ok_or_else(|| "refused dashboard action: check verdict is missing".to_string())?;
    if verdict.get("kind").and_then(Value::as_str) != Some("safe-attach") {
        return Err("refused dashboard action: browser is not a verified safe attachment".into());
    }
    let observation = verdict
        .get("observation")
        .ok_or_else(|| "refused dashboard action: process observation is missing".to_string())?;
    if observation.get("pid").and_then(Value::as_u64) != Some(requested_pid) {
        return Err("refused dashboard action: observed PID changed".into());
    }
    let command_line = observation
        .get("commandLine")
        .and_then(Value::as_str)
        .ok_or_else(|| "refused dashboard action: process command line is missing".to_string())?;
    if lane.get("browser").and_then(Value::as_str) == Some("firefox")
        && !command_line
            .split_whitespace()
            .any(|part| part == "-no-remote")
    {
        return Err("refused dashboard action: Firefox is missing -no-remote".into());
    }
    Ok(serde_json::json!({ "ok": true, "pid": requested_pid, "lane": lane }))
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
        let value = match provider.run_direct(&["runtime-handshake".into(), "--json".into()]) {
            Ok(value) => value,
            Err(_) if config.expected_portpilot_version == "0.4.0" => {
                provider.probe_release_a_runtime(&package_path)?
            }
            Err(error) => return Err(error),
        };
        let handshake: RuntimeHandshake = serde_json::from_value(value)
            .map_err(|e| format!("invalid PortPilot runtime handshake: {e}"))?;
        validate_handshake(&handshake, &config.expected_portpilot_version)?;
        provider.handshake = handshake;
        Ok(provider)
    }

    fn run_direct(&self, args: &[String]) -> Result<Value, String> {
        let mut command = quiet_command(&self.node_executable);
        command.arg(&self.cli_entry).args(args);
        if let Some(home) = &self.portpilot_home {
            command.env("PORTPILOT_HOME", home);
        }
        let output = command
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

    /// PortPilot 0.4.0 shipped before the dedicated handshake subcommand.
    /// This exact-version bridge executes a constant script through the
    /// already verified absolute Node binary and reads only the already
    /// verified package.json. No shell, PATH lookup, install, or mutation.
    fn probe_release_a_runtime(&self, package_path: &Path) -> Result<Value, String> {
        const PROBE: &str = r#"const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify({ok:true,identity:'portpilot-runtime',portpilotVersion:p.version,protocolVersion:1,registrySchemaVersion:1,platform:process.platform,architecture:process.arch}));"#;
        let output = quiet_command(&self.node_executable)
            .args(["-e", PROBE])
            .arg(package_path)
            .output()
            .map_err(|e| format!("failed to probe the verified PortPilot 0.4.0 runtime: {e}"))?;
        if !output.status.success() {
            return Err("verified PortPilot 0.4.0 compatibility probe failed".into());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("invalid PortPilot 0.4.0 compatibility response: {e}"))
    }

    /// Release A can already produce a fresh, profile-verified `check`
    /// verdict, but it predates the lane-id dashboard action wrapper. Adapt
    /// that exact output here so the prototype can stay pinned to the public
    /// 0.4.0 package without weakening the native action gate.
    fn dashboard_action_check_release_a(&self, args: &[String]) -> Result<Value, String> {
        fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
            args.windows(2)
                .find(|pair| pair[0] == flag)
                .map(|pair| pair[1].as_str())
        }

        let lane_id = value_after(args, "--lane")
            .ok_or_else(|| "dashboard action requires --lane".to_string())?;
        let requested_pid = value_after(args, "--pid")
            .ok_or_else(|| "dashboard action requires --pid".to_string())?
            .parse::<u64>()
            .map_err(|_| "dashboard action PID is invalid".to_string())?;

        let listed = self.run_direct(&["list".into(), "--json".into()])?;
        let lane = listed
            .get("lanes")
            .and_then(Value::as_array)
            .and_then(|lanes| {
                lanes
                    .iter()
                    .find(|lane| lane.get("id").and_then(Value::as_str) == Some(lane_id))
            })
            .cloned()
            .ok_or_else(|| "refused dashboard action: lane no longer exists".to_string())?;
        let owner = lane
            .get("owner")
            .and_then(Value::as_str)
            .ok_or_else(|| "refused dashboard action: lane owner is missing".to_string())?;
        let cwd = lane
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or_else(|| "refused dashboard action: lane cwd is missing".to_string())?;
        let mut check_args = vec![
            "check".into(),
            "--owner".into(),
            owner.into(),
            "--cwd".into(),
            cwd.into(),
        ];
        if let Some(session) = lane.get("sessionId").and_then(Value::as_str) {
            check_args.extend(["--session".into(), session.into()]);
        }
        check_args.push("--json".into());
        let checked = self.run_direct(&check_args)?;
        validate_release_a_action(lane_id, requested_pid, &lane, &checked)
    }
}

impl RuntimeProvider for InstalledRuntimeProvider {
    fn handshake(&self) -> &RuntimeHandshake {
        &self.handshake
    }

    fn run_json(&self, args: &[String]) -> Result<Value, String> {
        if self.handshake.portpilot_version == "0.4.0"
            && args.first().map(String::as_str) == Some("dashboard-action-check")
        {
            return self.dashboard_action_check_release_a(args);
        }
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
            portpilot_version: "0.4.0".into(),
            protocol_version: 1,
            registry_schema_version: 1,
            platform: expected_node_platform().into(),
            architecture: expected_node_architecture().into(),
        }
    }

    #[test]
    fn release_a_action_bridge_requires_exact_pid_and_firefox_no_remote() {
        let chrome_lane =
            serde_json::json!({ "id": "lane-1", "status": "active", "browser": "chrome" });
        let chrome_check = serde_json::json!({
            "lane": { "id": "lane-1" },
            "verdict": { "kind": "safe-attach", "observation": { "pid": 42, "commandLine": "Google Chrome --user-data-dir=/tmp/safe" } }
        });
        assert!(validate_release_a_action("lane-1", 42, &chrome_lane, &chrome_check).is_ok());
        assert!(validate_release_a_action("lane-1", 43, &chrome_lane, &chrome_check).is_err());

        let firefox_lane =
            serde_json::json!({ "id": "lane-2", "status": "active", "browser": "firefox" });
        let without_no_remote = serde_json::json!({
            "lane": { "id": "lane-2" },
            "verdict": { "kind": "safe-attach", "observation": { "pid": 44, "commandLine": "firefox -profile /tmp/safe" } }
        });
        assert!(
            validate_release_a_action("lane-2", 44, &firefox_lane, &without_no_remote).is_err()
        );
    }

    #[test]
    fn accepts_a_compatible_runtime_handshake() {
        assert!(validate_handshake(&compatible(), "0.4.0").is_ok());
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
            assert!(validate_handshake(&handshake, "0.4.0").is_err(), "{label}");
        }
    }

    #[test]
    fn rejects_relative_runtime_paths() {
        let config = InstalledRuntimeConfig {
            node_executable: "node".into(),
            package_root: "package".into(),
            cli_entry: "dist/src/cli/index.js".into(),
            expected_portpilot_version: "0.4.0".into(),
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
