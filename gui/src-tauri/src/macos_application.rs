use objc2_app_kit::NSRunningApplication;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const STATE_TIMEOUT: Duration = Duration::from_millis(1_500);
const STATE_POLL: Duration = Duration::from_millis(50);

const SET_FRONT_PROCESS_FRONT_WINDOW_ONLY: u32 = 1 << 0;
const SET_FRONT_PROCESS_CAUSED_BY_USER: u32 = 1 << 1;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ProcessSerialNumber {
    high_long_of_psn: u32,
    low_long_of_psn: u32,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn GetProcessForPID(pid: i32, psn: *mut ProcessSerialNumber) -> i32;
    fn ShowHideProcess(psn: *const ProcessSerialNumber, visible: u8) -> i16;
    fn SetFrontProcessWithOptions(psn: *const ProcessSerialNumber, options: u32) -> i32;
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacPlacement {
    pub platform: String,
    pub application_hidden: bool,
}

impl MacPlacement {
    pub fn application_hidden() -> Self {
        Self {
            platform: "macos".into(),
            application_hidden: true,
        }
    }
}

trait ProcessControl {
    fn is_terminated(&self) -> bool;
    fn hide_process(&self) -> Result<(), String>;
    fn show_process(&self) -> Result<(), String>;
    fn make_frontmost(&self) -> Result<(), String>;
}

struct NativeProcessControl {
    pid: u32,
    serial_number: ProcessSerialNumber,
}

impl NativeProcessControl {
    fn new(pid: u32) -> Result<Self, String> {
        let native_pid =
            i32::try_from(pid).map_err(|_| "browser PID is outside the macOS range")?;
        let mut serial_number = ProcessSerialNumber::default();
        // SAFETY: `serial_number` is writable for the duration of the call and
        // GetProcessForPID is documented by Apple as thread-safe.
        let status = unsafe { GetProcessForPID(native_pid, &mut serial_number) };
        os_status("resolve browser process", status)?;
        Ok(Self { pid, serial_number })
    }
}

impl ProcessControl for NativeProcessControl {
    fn is_terminated(&self) -> bool {
        running_application(self.pid)
            .map(|application| application.isTerminated())
            .unwrap_or(true)
    }

    fn hide_process(&self) -> Result<(), String> {
        // SAFETY: this immutable process serial number was resolved from the
        // already revalidated PID. ShowHideProcess is thread-safe on macOS.
        let status = unsafe { ShowHideProcess(&self.serial_number, 0) };
        os_status("hide browser process", i32::from(status))
    }

    fn show_process(&self) -> Result<(), String> {
        // SAFETY: same invariants as `hide_process`; nonzero means visible.
        let status = unsafe { ShowHideProcess(&self.serial_number, 1) };
        os_status("show browser process", i32::from(status))
    }

    fn make_frontmost(&self) -> Result<(), String> {
        // SAFETY: Apple documents SetFrontProcessWithOptions as thread-safe.
        // The user-caused option accurately represents a direct Show click.
        let status = unsafe {
            SetFrontProcessWithOptions(
                &self.serial_number,
                SET_FRONT_PROCESS_FRONT_WINDOW_ONLY | SET_FRONT_PROCESS_CAUSED_BY_USER,
            )
        };
        os_status("make browser process frontmost", status)
    }
}

fn os_status(action: &str, status: i32) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("macOS could not {action} (OSStatus {status})"))
    }
}

fn request_hide(process: &impl ProcessControl) -> Result<(), String> {
    if process.is_terminated() {
        return Err("browser application has already exited".into());
    }
    process.hide_process()
}

fn request_show(process: &impl ProcessControl) -> Result<(), String> {
    if process.is_terminated() {
        return Err("browser application has already exited".into());
    }
    process.show_process()?;
    process.make_frontmost()
}

fn running_application(pid: u32) -> Result<objc2::rc::Retained<NSRunningApplication>, String> {
    let pid = i32::try_from(pid).map_err(|_| "browser PID is outside the macOS range")?;
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .ok_or_else(|| format!("PID {pid} is not a running macOS application"))
}

fn wait_for_state(pid: u32, hidden: bool, active: bool) -> Result<(), String> {
    let deadline = Instant::now() + STATE_TIMEOUT;
    loop {
        let application = running_application(pid)?;
        if application.isTerminated() {
            return Err("browser application exited while macOS was changing its state".into());
        }
        if application.isHidden() == hidden && (!active || application.isActive()) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let expected = if hidden {
                "hidden"
            } else if active {
                "visible and frontmost"
            } else {
                "visible"
            };
            return Err(format!(
                "macOS accepted the request but browser PID {pid} did not become {expected}"
            ));
        }
        std::thread::sleep(STATE_POLL);
    }
}

async fn change_state(pid: u32, show: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let process = NativeProcessControl::new(pid)?;
        if show {
            request_show(&process)?;
            wait_for_state(pid, false, true)
        } else {
            request_hide(&process)?;
            wait_for_state(pid, true, false)
        }
    })
    .await
    .map_err(|error| format!("macOS process-control worker failed: {error}"))?
}

pub async fn focus(pid: u32) -> Result<(), String> {
    change_state(pid, true).await
}

pub async fn hide(pid: u32) -> Result<MacPlacement, String> {
    change_state(pid, false).await?;
    Ok(MacPlacement::application_hidden())
}

/// Re-hide an already verified browser PID from the watcher thread. The
/// Process Manager call is thread-safe and idempotently applies to that PID.
pub fn enforce_hide(pid: u32) -> Result<(), String> {
    let process = NativeProcessControl::new(pid)?;
    request_hide(&process)
}

pub async fn restore(pid: u32, placement: MacPlacement) -> Result<(), String> {
    if placement.platform != "macos" || !placement.application_hidden {
        return Err("invalid macOS application hide state".into());
    }
    focus(pid).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct FakeProcess {
        terminated: bool,
        hide_result: Result<(), String>,
        show_result: Result<(), String>,
        front_result: Result<(), String>,
        hide_calls: Cell<u32>,
        show_calls: Cell<u32>,
        front_calls: Cell<u32>,
    }

    impl FakeProcess {
        fn running() -> Self {
            Self {
                terminated: false,
                hide_result: Ok(()),
                show_result: Ok(()),
                front_result: Ok(()),
                hide_calls: Cell::new(0),
                show_calls: Cell::new(0),
                front_calls: Cell::new(0),
            }
        }
    }

    impl ProcessControl for FakeProcess {
        fn is_terminated(&self) -> bool {
            self.terminated
        }

        fn hide_process(&self) -> Result<(), String> {
            self.hide_calls.set(self.hide_calls.get() + 1);
            self.hide_result.clone()
        }

        fn show_process(&self) -> Result<(), String> {
            self.show_calls.set(self.show_calls.get() + 1);
            self.show_result.clone()
        }

        fn make_frontmost(&self) -> Result<(), String> {
            self.front_calls.set(self.front_calls.get() + 1);
            self.front_result.clone()
        }
    }

    #[test]
    fn hide_targets_the_resolved_process_once() {
        let process = FakeProcess::running();
        assert_eq!(request_hide(&process), Ok(()));
        assert_eq!(process.hide_calls.get(), 1);
    }

    #[test]
    fn show_makes_the_same_process_visible_then_frontmost() {
        let process = FakeProcess::running();
        assert_eq!(request_show(&process), Ok(()));
        assert_eq!(process.show_calls.get(), 1);
        assert_eq!(process.front_calls.get(), 1);
    }

    #[test]
    fn show_failure_does_not_claim_frontmost() {
        let mut process = FakeProcess::running();
        process.show_result = Err("show refused".into());
        assert!(request_show(&process).is_err());
        assert_eq!(process.show_calls.get(), 1);
        assert_eq!(process.front_calls.get(), 0);
    }

    #[test]
    fn frontmost_failure_is_reported() {
        let mut process = FakeProcess::running();
        process.front_result = Err("front refused".into());
        assert!(request_show(&process).is_err());
        assert_eq!(process.show_calls.get(), 1);
        assert_eq!(process.front_calls.get(), 1);
    }

    #[test]
    fn terminated_process_is_refused_without_actions() {
        let mut process = FakeProcess::running();
        process.terminated = true;
        assert!(request_hide(&process).is_err());
        assert!(request_show(&process).is_err());
        assert_eq!(process.hide_calls.get(), 0);
        assert_eq!(process.show_calls.get(), 0);
        assert_eq!(process.front_calls.get(), 0);
    }

    #[test]
    fn placement_round_trips_as_explicit_application_hide_state() {
        let placement = MacPlacement::application_hidden();
        let value = serde_json::to_value(&placement).unwrap();
        assert_eq!(value["platform"], "macos");
        assert_eq!(value["applicationHidden"], true);
        assert_eq!(
            serde_json::from_value::<MacPlacement>(value).unwrap(),
            placement
        );
    }
}
