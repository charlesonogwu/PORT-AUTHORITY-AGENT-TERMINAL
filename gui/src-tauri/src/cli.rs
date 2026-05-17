// Shared helper for shelling out to the existing Node `paat` CLI.
// Used by write-path commands (status/doctor/install-mcp/reserve/etc) so
// the CLI remains the single source of truth for mutations + complex
// read paths that involve live port scanning.
//
// We resolve the binary via the `which` crate, which mirrors how
// PowerShell's Get-Command and Bash's `command -v` walk PATH. On Windows
// it knows about `.exe`/`.cmd`/`.bat` shims.
//
// 0.2.3 BUGS FIXED:
//   - Every spawn now sets CREATE_NO_WINDOW on Windows so the subprocess
//     doesn't pop a CMD console window (was causing "CMD tabs spamming
//     the screen" complaints when the snapshot poll fired every 3s).
//   - run_cli_json is intended to be called from a worker thread (via
//     tauri::async_runtime::spawn_blocking) — see commands/snapshot.rs.
//     The function itself stays sync because Command::output is sync; we
//     just don't want callers to invoke it from the main UI thread.

use serde_json::Value;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Windows-only flag: spawn without creating a console window. Without this,
/// every Command::spawn from a windows_subsystem="windows" parent pops a
/// fresh CMD window because Windows defaults to giving children a new
/// console when the parent doesn't have one.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build a Command pre-configured with the platform's "hide-the-console"
/// flag. All subprocess spawns in the Tauri shell go through this helper to
/// guarantee none of them pop a CMD window.
pub fn quiet_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

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
///  - **Blocking.** Call this from `tauri::async_runtime::spawn_blocking`
///    so the Tauri main thread stays free to pump WM_* messages. Calling
///    it directly from a `#[tauri::command] pub fn ...` (sync command)
///    freezes the UI for the subprocess duration (~500ms-1s on Windows),
///    which Windows surfaces as "Not Responding" if the user is dragging
///    the window at that moment.
pub fn run_cli_json(args: &[&str]) -> Result<Value, String> {
    let binary = find_paat_binary()?;
    let mut full_args: Vec<&str> = args.to_vec();
    full_args.push("--json");
    let output = quiet_command(&binary)
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
