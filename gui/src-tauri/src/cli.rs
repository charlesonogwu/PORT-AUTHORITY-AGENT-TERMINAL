// Shared helper for shelling out to the existing Node `paat` CLI.
// Used by write-path commands (status/doctor/install-mcp/reserve/etc) so
// the CLI remains the single source of truth for mutations + complex
// read paths that involve live port scanning.
//
// We resolve the binary via the `which` crate, which mirrors how
// PowerShell's Get-Command and Bash's `command -v` walk PATH. On Windows
// it knows about `.exe`/`.cmd`/`.bat` shims.

use serde_json::Value;
use std::process::Command;

/// Locate the `paat` binary on PATH. Falls back to `port-authority` then
/// `portpilot` (the other npm-installed aliases). Returns a clear error
/// message if none are found so the dashboard UI can surface it.
fn find_paat_binary() -> Result<String, String> {
    for name in &["paat", "port-authority", "portpilot"] {
        if let Ok(path) = which::which(name) {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    Err(
        "could not locate `paat` on PATH. Reinstall via \
         `npm install -g port-authority-agent-terminal-mcp`."
            .into(),
    )
}

/// Run `paat <args> --json` and return the parsed JSON response.
///
/// Notes:
///  - We add `--json` automatically; callers pass only the subcommand args.
///  - stdout is parsed as JSON; stderr is propagated on non-zero exit.
///  - Subprocess inherits no env from the dashboard process beyond what
///    `Command::new` defaults to. PAAT respects `PORTPILOT_HOME` etc.
pub fn run_cli_json(args: &[&str]) -> Result<Value, String> {
    let binary = find_paat_binary()?;
    let mut full_args: Vec<&str> = args.to_vec();
    full_args.push("--json");
    let output = Command::new(&binary)
        .args(&full_args)
        .output()
        .map_err(|e| format!("failed to spawn `{}`: {}", binary, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);
        return Err(format!("`paat {}` exited {}: {}", args.join(" "), code, stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| {
        let preview = if stdout.len() > 200 { &stdout[..200] } else { &stdout };
        format!("invalid JSON from `paat {}`: {} (stdout preview: {})", args.join(" "), e, preview)
    })
}
