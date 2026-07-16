use crate::runtime::RuntimeState;
use serde_json::Value;

/// Reload the lane and scan the live debugging port through the verified Node
/// runtime immediately before an operating-system process/window action.
pub fn revalidate_lane_action(
    runtime: &RuntimeState,
    lane_id: &str,
    pid: u32,
    process_start: &str,
) -> Result<Value, String> {
    if lane_id.trim().is_empty() || pid == 0 {
        return Err("refused dashboard action: lane id and positive PID are required".into());
    }
    crate::process_identity::verify(pid, process_start)?;
    let result = runtime.run_json(&[
        "dashboard-action-check".into(),
        "--lane".into(),
        lane_id.into(),
        "--pid".into(),
        pid.to_string(),
    ])?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("refused dashboard action: runtime validation did not return ok=true".into());
    }
    if result.get("pid").and_then(Value::as_u64) != Some(pid as u64) {
        return Err("refused dashboard action: validated PID changed".into());
    }
    crate::process_identity::verify(pid, process_start)?;
    if result
        .get("lane")
        .and_then(|lane| lane.get("id"))
        .and_then(Value::as_str)
        != Some(lane_id)
    {
        return Err("refused dashboard action: validated lane identity changed".into());
    }
    Ok(result)
}
