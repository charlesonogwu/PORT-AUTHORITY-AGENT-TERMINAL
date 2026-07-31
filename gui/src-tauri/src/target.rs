use crate::cli::run_cli_json;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneTarget {
    pub pid: u32,
    pub lane_id: Option<String>,
    pub browser: String,
    pub chrome_debug_port: u16,
    pub profile_dir: String,
}

fn normalized_path(value: &str) -> String {
    value.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

pub fn verify_snapshot_target(snapshot: &Value, target: &LaneTarget) -> Result<(), String> {
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
    let matched = sessions.iter().any(|session| {
        let browser = session
            .get("browser")
            .and_then(Value::as_str)
            .unwrap_or("chrome");
        session.get("registeredBy").and_then(Value::as_str) == Some("portpilot")
            && session.get("laneId").and_then(Value::as_str) == Some(lane_id)
            && session.get("pid").and_then(Value::as_u64) == Some(u64::from(target.pid))
            && session
                .get("chromeDebugPort")
                .and_then(Value::as_u64)
                == Some(u64::from(target.chrome_debug_port))
            && browser.eq_ignore_ascii_case(&target.browser)
            && session
                .get("chromeProfileDir")
                .and_then(Value::as_str)
                .map(normalized_path)
                .as_deref()
                == Some(expected_profile.as_str())
    });

    if matched {
        Ok(())
    } else {
        Err(format!(
            "refusing action: lane {} no longer matches pid {}, {} port {}, and profile {}",
            lane_id,
            target.pid,
            target.browser,
            target.chrome_debug_port,
            target.profile_dir
        ))
    }
}

pub fn verify_live_target(target: &LaneTarget) -> Result<(), String> {
    let snapshot = run_cli_json(&["dashboard-snapshot"])?;
    verify_snapshot_target(&snapshot, target)
}

pub fn verify_live_targets(targets: &[LaneTarget]) -> Result<(), String> {
    let snapshot = run_cli_json(&["dashboard-snapshot"])?;
    for target in targets {
        verify_snapshot_target(&snapshot, target)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn process_creation_time(pid: u32) -> Result<u64, String> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|e| format!("cannot inspect pid {}: {}", pid, e))?;
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let result = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
        let _ = CloseHandle(handle);
        result.map_err(|e| format!("cannot read creation time for pid {}: {}", pid, e))?;
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}

#[cfg(not(target_os = "windows"))]
pub fn process_creation_time(_pid: u32) -> Result<u64, String> {
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::{verify_snapshot_target, LaneTarget};
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
    fn accepts_an_exact_current_portpilot_lane() {
        assert!(verify_snapshot_target(&snapshot(), &target()).is_ok());
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

    #[cfg(target_os = "windows")]
    #[test]
    fn process_identity_uses_a_nonzero_creation_time() {
        let created = super::process_creation_time(std::process::id()).unwrap();
        assert_ne!(created, 0);
    }
}
