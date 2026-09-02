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
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

/// Windows-only flag: spawn without creating a console window. Without this,
/// every Command::spawn from a windows_subsystem="windows" parent pops a
/// fresh CMD window because Windows defaults to giving children a new
/// console when the parent doesn't have one.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
/// Refuse to keep the supervisor inside a disposable parent Job Object. If
/// the host job forbids breakaway, CreateProcess fails and PortPilot fails
/// closed instead of launching browsers with a false persistence guarantee.
#[cfg(target_os = "windows")]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

static SUPERVISOR_STARTUP: OnceLock<Result<(), String>> = OnceLock::new();

pub fn record_supervisor_startup(result: Result<(), String>) {
    let _ = SUPERVISOR_STARTUP.set(result);
}

pub fn supervisor_startup_error() -> Option<&'static str> {
    SUPERVISOR_STARTUP
        .get()
        .and_then(|result| result.as_ref().err().map(String::as_str))
}

#[cfg(target_os = "windows")]
fn configure_persistent_process(command: &mut Command) {
    command.creation_flags(
        CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
    );
}

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
    Err("could not locate `paat` on PATH. Reinstall via \
         `npm install -g port-authority-agent-terminal-mcp`."
        .into())
}

/// Start the user-scoped browser supervisor. The dashboard is launched by
/// Explorer/login autostart, outside disposable MCP process jobs; the
/// supervisor inherits that durable lifetime boundary.
#[allow(clippy::zombie_processes)]
pub fn start_supervisor_background() -> Result<(), String> {
    let binary = find_paat_binary()?;
    let mut command = Command::new(&binary);
    command.args(["supervisor", "serve"]);
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    configure_persistent_process(&mut command);
    let mut child = command.spawn().map_err(|e| {
        format!(
            "failed to start PortPilot supervisor with `{}`: {}",
            binary, e
        )
    })?;
    for _ in 0..100 {
        if let Ok(output) = quiet_command(&binary)
            .args(["supervisor", "status", "--json"])
            .output()
        {
            if let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) {
                if value.get("running").and_then(Value::as_bool) == Some(true) {
                    return Ok(());
                }
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "PortPilot supervisor exited before becoming ready (status {})",
                status
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("PortPilot supervisor did not become ready within 10 seconds".into())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::configure_persistent_process;
    use std::fs;
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    #[test]
    #[ignore = "worker invoked by supervisor_breaks_away_from_kill_on_close_job"]
    fn breakaway_worker() {
        let signal = std::env::var("PORTPILOT_BREAKAWAY_SIGNAL").unwrap();
        let pid_file = std::env::var("PORTPILOT_BREAKAWAY_PID").unwrap();
        while !std::path::Path::new(&signal).exists() {
            thread::sleep(Duration::from_millis(10));
        }
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_persistent_process(&mut command);
        let mut child = command.spawn().expect("breakaway child should spawn");
        fs::write(pid_file, child.id().to_string()).unwrap();
        thread::sleep(Duration::from_secs(60));
        let _ = child.wait();
    }

    #[test]
    fn supervisor_breaks_away_from_kill_on_close_job() {
        let root = std::env::temp_dir().join(format!("portpilot-job-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let signal = root.join("go");
        let pid_file = root.join("pid");
        let mut worker = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "cli::tests::breakaway_worker",
                "--ignored",
                "--nocapture",
            ])
            .env("PORTPILOT_BREAKAWAY_SIGNAL", &signal)
            .env("PORTPILOT_BREAKAWAY_PID", &pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let job = unsafe { CreateJobObjectW(None, None).unwrap() };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )
            .unwrap();
            AssignProcessToJobObject(job, HANDLE(worker.as_raw_handle())).unwrap();
        }
        fs::write(&signal, b"go").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pid_file.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let child_pid: u32 = fs::read_to_string(&pid_file).unwrap().parse().unwrap();
        let child_before = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                false,
                child_pid,
            )
            .unwrap()
        };
        let mut in_job = windows::Win32::Foundation::BOOL(0);
        unsafe { IsProcessInJob(child_before, job, &mut in_job).unwrap() };
        assert!(
            !in_job.as_bool(),
            "supervisor child remained in the disposable job"
        );
        unsafe { CloseHandle(job).unwrap() };
        let _ = worker.wait();
        thread::sleep(Duration::from_millis(100));

        unsafe { CloseHandle(child_before).unwrap() };
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &child_pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = fs::remove_dir_all(root);
    }
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
        return Err(format!(
            "`paat {}` exited {}: {}",
            args.join(" "),
            code,
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| {
        let preview = if stdout.len() > 200 {
            &stdout[..200]
        } else {
            &stdout
        };
        format!(
            "invalid JSON from `paat {}`: {} (stdout preview: {})",
            args.join(" "),
            e,
            preview
        )
    })
}
