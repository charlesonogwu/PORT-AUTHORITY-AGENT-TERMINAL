// Shared argument-safe process helper. Runtime CLI calls are handled by
// runtime.rs, which requires explicit verified absolute Node and CLI paths.
//
// 0.2.3 BUGS FIXED:
//   - Every spawn now sets CREATE_NO_WINDOW on Windows so the subprocess
//     doesn't pop a CMD console window (was causing "CMD tabs spamming
//     the screen" complaints when the snapshot poll fired every 3s).
//   - run_cli_json is intended to be called from a worker thread (via
//     tauri::async_runtime::spawn_blocking) — see commands/snapshot.rs.
//     The function itself stays sync because Command::output is sync; we
//     just don't want callers to invoke it from the main UI thread.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;

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
    #[cfg(not(target_os = "windows"))]
    let cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
