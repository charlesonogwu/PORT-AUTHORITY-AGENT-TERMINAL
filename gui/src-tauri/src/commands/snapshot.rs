// get_snapshot — shells out to `paat dashboard-snapshot --json` to get the
// full DashboardSnapshot shape the React UI consumes. This is the same data
// the old Express `/api/snapshot` endpoint returned.
//
// 0.2.0/0.2.1 BUG (fixed here in 0.2.2): we previously shelled out to
// `paat status --json`, but that returns a simpler shape (just lanes + scan
// results) — no `summary` object, no `liveSessions` array, no `conflicts`.
// The React UI tried to read `snap.summary.liveSessions` → undefined →
// TypeError → blank white window. The fix is a new dedicated subcommand
// that calls buildSnapshot() and returns the rich shape.
//
// We delegate to the Node CLI rather than re-implementing the snapshot
// logic in Rust because:
//  - the scan + agent-inference + conflict-detection logic is already well-
//    tested on the Node side,
//  - keeping a single source of truth means the dashboard + MCP server see
//    identical results,
//  - I/O bound work makes the subprocess overhead negligible.
//
// If the CLI can't be found (npm install missing or broken PATH), we return
// the bare DashboardSnapshot skeleton the UI knows how to render — empty
// arrays + zeroed summary + a warning string so the dashboard surfaces the
// install issue instead of going blank.

use crate::runtime::RuntimeState;
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::State;

fn append_verified_firefox(snapshot: &mut Value, lane: &Value, checked: &Value) -> bool {
    if lane.get("browser").and_then(Value::as_str) != Some("firefox")
        || lane.get("status").and_then(Value::as_str) == Some("released")
        || checked.pointer("/verdict/kind").and_then(Value::as_str) != Some("safe-attach")
    {
        return false;
    }
    let lane_id = match lane.get("id").and_then(Value::as_str) {
        Some(value) => value,
        None => return false,
    };
    if checked.pointer("/lane/id").and_then(Value::as_str) != Some(lane_id) {
        return false;
    }
    let observation = match checked.pointer("/verdict/observation") {
        Some(value) => value,
        None => return false,
    };
    let command_line = match observation.get("commandLine").and_then(Value::as_str) {
        Some(value) if value.split_whitespace().any(|part| part == "-no-remote") => value,
        _ => return false,
    };
    let pid = match observation.get("pid").and_then(Value::as_u64) {
        Some(value) => value,
        None => return false,
    };
    let port = match lane.get("chromeDebugPort").and_then(Value::as_u64) {
        Some(value) => value,
        None => return false,
    };
    let profile = match lane.get("chromeProfileDir").and_then(Value::as_str) {
        Some(value) if command_line.contains(value) => value,
        _ => return false,
    };
    let sessions = match snapshot
        .get_mut("liveSessions")
        .and_then(Value::as_array_mut)
    {
        Some(value) => value,
        None => return false,
    };
    if sessions.iter().any(|session| {
        session.get("laneId").and_then(Value::as_str) == Some(lane_id)
            || session.get("pid").and_then(Value::as_u64) == Some(pid)
    }) {
        return false;
    }
    let owner = lane.get("owner").and_then(Value::as_str).unwrap_or("agent");
    let project = lane
        .get("project")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut session = json!({
        "key": format!("{pid}:{port}:{profile}"),
        "agent": owner,
        "agentConfidence": "registered",
        "project": project,
        "projectConfidence": "registered",
        "cwdConfidence": "registered",
        "pid": pid,
        "chromeDebugPort": port,
        "debugMode": "port",
        "chromeProfileDir": profile,
        "browser": "firefox",
        "hasSavedData": false,
        "tabs": [],
        "primaryTabs": [],
        "registeredBy": "portpilot",
        "laneId": lane_id,
        "cdpError": "Firefox lane: BiDi debug port (not Chrome CDP) — tab list unavailable; drive it with the page tools"
    });
    for field in ["cwd", "task", "appPort"] {
        if let Some(value) = lane.get(field) {
            session[field] = value.clone();
        }
    }
    sessions.push(session);
    true
}

fn refresh_summary(snapshot: &mut Value) {
    let (count, agent_count) = {
        let sessions = match snapshot.get("liveSessions").and_then(Value::as_array) {
            Some(value) => value,
            None => return,
        };
        let agents: HashSet<&str> = sessions
            .iter()
            .filter_map(|session| session.get("agent").and_then(Value::as_str))
            .collect();
        (sessions.len() as u64, agents.len())
    };
    if let Some(summary) = snapshot.get_mut("summary") {
        summary["liveSessions"] = json!(count);
        summary["distinctAgents"] = json!(agent_count);
    }
}

fn enrich_release_a_firefox(runtime: &RuntimeState, snapshot: &mut Value) {
    if runtime.portpilot_version() != Some("0.4.0") {
        return;
    }
    let listed = match runtime.run_json(&["list".into()]) {
        Ok(value) => value,
        Err(_) => return,
    };
    let lanes = match listed.get("lanes").and_then(Value::as_array) {
        Some(value) => value,
        None => return,
    };
    for lane in lanes {
        if lane.get("browser").and_then(Value::as_str) != Some("firefox")
            || lane.get("status").and_then(Value::as_str) == Some("released")
        {
            continue;
        }
        let (owner, cwd, session) = match (
            lane.get("owner").and_then(Value::as_str),
            lane.get("cwd").and_then(Value::as_str),
            lane.get("sessionId").and_then(Value::as_str),
        ) {
            (Some(owner), Some(cwd), Some(session)) => (owner, cwd, session),
            _ => continue,
        };
        let args = vec![
            "check".into(),
            "--owner".into(),
            owner.into(),
            "--cwd".into(),
            cwd.into(),
            "--session".into(),
            session.into(),
            "--browser".into(),
            "firefox".into(),
            "--json".into(),
        ];
        if let Ok(checked) = runtime.run_json(&args) {
            append_verified_firefox(snapshot, lane, &checked);
        }
    }
    refresh_summary(snapshot);
}

/// 0.2.3 fix: async + spawn_blocking. Previously this was a sync
/// `pub fn`, which Tauri runs on the **main UI thread**. Every 3-second
/// poll then blocked the message pump for ~500-1000 ms (cost of spawning
/// Node + reading lanes.json + scanning ports). If the user happened to
/// be dragging the window during that interval, Windows showed "Not
/// Responding" in the title bar. Making the command async + offloading the
/// blocking subprocess to a worker thread via tauri's async_runtime keeps
/// the UI thread free to pump WM_* messages even while the snapshot is
/// being computed.
#[tauri::command]
pub async fn get_snapshot(runtime: State<'_, RuntimeState>) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    let snapshot_runtime = runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        snapshot_runtime.run_json(&["dashboard-snapshot".into()])
    })
    .await
    .map_err(|e| format!("snapshot worker join failed: {}", e))
    .map(|res| match res {
        Ok(mut v) => {
            enrich_release_a_firefox(&runtime, &mut v);
            crate::process_identity::enrich_snapshot(&mut v);
            v
        }
        Err(e) => json!({
            "ok": false,
            "generatedAt": "",
            "scanSource": "empty",
            "scanErrors": [e.clone()],
            "home": "",
            "registryPath": "",
            "config": {},
            "summary": { "liveSessions": 0, "distinctAgents": 0, "conflicts": 0 },
            "liveSessions": [],
            "registryHealth": { "portpilot": { "exists": false, "lockHealthy": false } },
            "conflicts": [],
            "warnings": [format!("paat CLI unavailable: {}", e)]
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_a_firefox_adapter_requires_verified_exact_lane() {
        let lane = json!({
            "id": "lane_ff", "owner": "agent", "project": "demo",
            "cwd": "/tmp/demo", "sessionId": "ff", "appPort": 3001,
            "chromeDebugPort": 9323, "chromeProfileDir": "/tmp/pp/profiles/ff",
            "browser": "firefox", "status": "active"
        });
        let checked = json!({
            "verdict": { "kind": "safe-attach", "observation": {
                "pid": 123, "commandLine": "firefox -profile /tmp/pp/profiles/ff -no-remote --remote-debugging-port 9323"
            }},
            "lane": { "id": "lane_ff" }
        });
        let mut snapshot = json!({
            "summary": { "liveSessions": 0, "distinctAgents": 0, "conflicts": 0 },
            "liveSessions": []
        });
        assert!(append_verified_firefox(&mut snapshot, &lane, &checked));
        refresh_summary(&mut snapshot);
        assert_eq!(snapshot.pointer("/summary/liveSessions"), Some(&json!(1)));
        assert_eq!(
            snapshot.pointer("/liveSessions/0/browser"),
            Some(&json!("firefox"))
        );

        let mut wrong = checked.clone();
        wrong["lane"]["id"] = json!("foreign");
        assert!(!append_verified_firefox(&mut snapshot, &lane, &wrong));
    }
}
