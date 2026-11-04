// Exact-target checks for dashboard actions (Show, Hide, Unhide, Kill, Erase).
//
// The UI only knows what the last refresh said. Before acting, the backend
// re-checks the target against a snapshot taken *after* the user asked, and on
// Windows it pins the exact process with a handle first, so a pid that Windows
// reuses for another program between the check and the action can never be
// the one that gets terminated.

use crate::commands::snapshot::fresh_snapshot;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaneTarget {
    pub pid: u32,
    pub lane_id: Option<String>,
    #[serde(default = "default_browser")]
    pub browser: String,
    // Defaults keep one session with a missing field from rejecting a whole
    // batch at deserialization; verify_snapshot_target then refuses it alone.
    #[serde(default)]
    pub chrome_debug_port: u16,
    #[serde(default)]
    pub profile_dir: String,
}

fn default_browser() -> String {
    "chrome".into()
}

fn normalized_path(value: &str) -> String {
    value.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Check `target` against one snapshot. On success returns the snapshot's own
/// profile directory for the matched session, so destructive actions use the
/// value PortPilot just observed rather than the string the UI sent.
pub fn verify_snapshot_target(snapshot: &Value, target: &LaneTarget) -> Result<String, String> {
    let lane_id = target
        .lane_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "refusing action: the selected session has no PortPilot lane id".to_string())?;
    if target.pid == 0 {
        return Err("refusing action: invalid pid 0".into());
    }
    if target.chrome_debug_port == 0 {
        return Err("refusing action: the selected lane has no debugging port".into());
    }
    if target.profile_dir.trim().is_empty() {
        return Err("refusing action: the selected lane has no isolated profile".into());
    }

    let sessions = snapshot
        .get("liveSessions")
        .and_then(Value::as_array)
        .ok_or_else(|| "refusing action: dashboard snapshot has no live sessions".to_string())?;

    let expected_profile = normalized_path(&target.profile_dir);
    let matched = sessions.iter().find(|session| {
        let browser = session
            .get("browser")
            .and_then(Value::as_str)
            .unwrap_or("chrome");
        session.get("registeredBy").and_then(Value::as_str) == Some("portpilot")
            && session.get("laneId").and_then(Value::as_str) == Some(lane_id)
            && session.get("pid").and_then(Value::as_u64) == Some(u64::from(target.pid))
            && session.get("chromeDebugPort").and_then(Value::as_u64)
                == Some(u64::from(target.chrome_debug_port))
            && browser.eq_ignore_ascii_case(&target.browser)
            && session
                .get("chromeProfileDir")
                .and_then(Value::as_str)
                .map(normalized_path)
                .as_deref()
                == Some(expected_profile.as_str())
    });

    match matched.and_then(|session| session.get("chromeProfileDir").and_then(Value::as_str)) {
        Some(profile_dir) => Ok(profile_dir.to_string()),
        None => Err(format!(
            "refusing action: lane {} no longer matches pid {}, {} port {}, and profile {}",
            lane_id, target.pid, target.browser, target.chrome_debug_port, target.profile_dir
        )),
    }
}

/// Verify one target against a snapshot taken after this call began.
/// Returns the snapshot's profile directory for it. Blocking.
pub fn verify_live_target(target: &LaneTarget) -> Result<String, String> {
    let snapshot = fresh_snapshot()?;
    verify_snapshot_target(&snapshot, target)
}

/// The targets that still match `snapshot`; a stale one never drops the rest.
pub fn verified_targets(snapshot: &Value, targets: Vec<LaneTarget>) -> Vec<LaneTarget> {
    targets
        .into_iter()
        .filter(|target| verify_snapshot_target(snapshot, target).is_ok())
        .collect()
}

#[cfg(target_os = "windows")]
pub fn process_creation_time(pid: u32) -> Result<u64, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|e| format!("cannot inspect pid {}: {}", pid, e))?;
        let created = creation_time_of(handle);
        let _ = CloseHandle(handle);
        created.map_err(|e| format!("cannot read creation time for pid {}: {}", pid, e))
    }
}

#[cfg(target_os = "windows")]
unsafe fn creation_time_of(handle: windows::Win32::Foundation::HANDLE) -> windows::core::Result<u64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetProcessTimes;

    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)?;
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

#[cfg(not(target_os = "windows"))]
pub fn process_creation_time(_pid: u32) -> Result<u64, String> {
    Ok(0)
}

/// An open handle to one exact process. Whatever happens to its pid later,
/// terminating through the handle can only ever end this process.
#[cfg(target_os = "windows")]
pub struct ProcessPin {
    handle: windows::Win32::Foundation::HANDLE,
    pid: u32,
}

#[cfg(target_os = "windows")]
impl ProcessPin {
    /// Pin `pid` now. `Ok(None)` when no such process exists any more.
    pub fn open(pid: u32) -> Result<Option<Self>, String> {
        use windows::Win32::Foundation::ERROR_INVALID_PARAMETER;
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };

        if pid == 0 {
            return Err("refusing action: invalid pid 0".into());
        }
        unsafe {
            match OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                pid,
            ) {
                Ok(handle) => Ok(Some(Self { handle, pid })),
                Err(e) if e.code() == ERROR_INVALID_PARAMETER.to_hresult() => Ok(None),
                Err(e) => Err(format!("cannot open pid {}: {}", pid, e)),
            }
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// True once the pinned process has exited.
    pub fn has_exited(&self) -> bool {
        use windows::Win32::Foundation::WAIT_OBJECT_0;
        use windows::Win32::System::Threading::WaitForSingleObject;
        unsafe { WaitForSingleObject(self.handle, 0) == WAIT_OBJECT_0 }
    }

    /// Terminate the pinned process and wait for it to exit.
    pub fn terminate_and_wait(&self, timeout: std::time::Duration) -> Result<(), String> {
        use windows::Win32::Foundation::WAIT_OBJECT_0;
        use windows::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};

        if self.has_exited() {
            return Ok(());
        }
        unsafe {
            if let Err(e) = TerminateProcess(self.handle, 1) {
                if !self.has_exited() {
                    return Err(format!("could not terminate pid {}: {}", self.pid, e));
                }
            }
            let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
            if WaitForSingleObject(self.handle, millis) == WAIT_OBJECT_0 {
                Ok(())
            } else {
                Err(format!("pid {} did not exit within {} ms", self.pid, millis))
            }
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ProcessPin {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{verified_targets, verify_snapshot_target, LaneTarget};
    use serde_json::json;

    fn target() -> LaneTarget {
        LaneTarget {
            pid: 4242,
            lane_id: Some("lane-1".into()),
            browser: "chrome".into(),
            chrome_debug_port: 9322,
            profile_dir: r"C:\Users\test\.portpilot\profiles\lane-1".into(),
        }
    }

    fn snapshot() -> serde_json::Value {
        json!({
            "liveSessions": [{
                "pid": 4242,
                "laneId": "lane-1",
                "browser": "chrome",
                "chromeDebugPort": 9322,
                "chromeProfileDir": "C:/Users/test/.portpilot/profiles/lane-1",
                "registeredBy": "portpilot"
            }]
        })
    }

    #[test]
    fn accepts_an_exact_current_portpilot_lane_and_returns_the_observed_profile() {
        assert_eq!(
            verify_snapshot_target(&snapshot(), &target()).unwrap(),
            "C:/Users/test/.portpilot/profiles/lane-1"
        );
    }

    #[test]
    fn refuses_a_reused_pid_with_a_different_profile() {
        let mut snap = snapshot();
        snap["liveSessions"][0]["chromeProfileDir"] =
            json!(r"C:\Users\test\.portpilot\profiles\someone-else");
        assert!(verify_snapshot_target(&snap, &target()).is_err());
    }

    #[test]
    fn refuses_a_port_or_browser_mismatch() {
        let mut snap = snapshot();
        snap["liveSessions"][0]["chromeDebugPort"] = json!(9444);
        assert!(verify_snapshot_target(&snap, &target()).is_err());

        let mut snap = snapshot();
        snap["liveSessions"][0]["browser"] = json!("edge");
        assert!(verify_snapshot_target(&snap, &target()).is_err());
    }

    #[test]
    fn refuses_external_or_lane_less_sessions() {
        let mut snap = snapshot();
        snap["liveSessions"][0]["registeredBy"] = json!("external");
        assert!(verify_snapshot_target(&snap, &target()).is_err());

        let mut no_lane = target();
        no_lane.lane_id = None;
        assert!(verify_snapshot_target(&snapshot(), &no_lane).is_err());
    }

    #[test]
    fn a_session_missing_its_port_or_profile_deserializes_and_is_refused_alone() {
        let partial: LaneTarget = serde_json::from_value(json!({ "pid": 7, "laneId": "lane-2" })).unwrap();
        assert_eq!(partial.browser, "chrome");
        assert!(verify_snapshot_target(&snapshot(), &partial).is_err());
        let kept = verified_targets(&snapshot(), vec![partial, target()]);
        assert_eq!(kept, vec![target()]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn process_identity_uses_a_nonzero_creation_time() {
        let created = super::process_creation_time(std::process::id()).unwrap();
        assert_ne!(created, 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_pinned_process_is_terminated_through_its_handle() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .unwrap();
        let pin = super::ProcessPin::open(child.id()).unwrap().expect("child is running");
        assert!(!pin.has_exited());
        pin.terminate_and_wait(std::time::Duration::from_secs(5)).unwrap();
        assert!(pin.has_exited());
        let _ = child.wait();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn pinning_a_process_that_does_not_exist_is_not_an_error() {
        // Windows pids are multiples of 4 well below this value.
        assert!(super::ProcessPin::open(0xFFFF_FFF0).unwrap().is_none());
    }
}
