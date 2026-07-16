use serde_json::Value;
#[cfg(target_os = "macos")]
use std::collections::{HashMap, HashSet};

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy)]
struct ProcessMemory {
    parent: u32,
    rss_kib: u64,
}

#[cfg(target_os = "macos")]
fn parse_process_memory(stdout: &str) -> HashMap<u32, ProcessMemory> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let parent = fields.next()?.parse::<u32>().ok()?;
            let rss_kib = fields.next()?.parse::<u64>().ok()?;
            (pid > 0).then_some((pid, ProcessMemory { parent, rss_kib }))
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn tree_memory_mib(root: u32, processes: &HashMap<u32, ProcessMemory>) -> Option<u64> {
    if !processes.contains_key(&root) {
        return None;
    }
    let mut selected = HashSet::from([root]);
    loop {
        let before = selected.len();
        for (pid, process) in processes {
            if selected.contains(&process.parent) {
                selected.insert(*pid);
            }
        }
        if selected.len() == before {
            break;
        }
    }
    let kib = selected
        .iter()
        .filter_map(|pid| processes.get(pid))
        .map(|p| p.rss_kib)
        .sum::<u64>();
    Some((kib + 512) / 1024)
}

#[cfg(target_os = "macos")]
fn read_process_memory() -> HashMap<u32, ProcessMemory> {
    std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,rss="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_process_memory(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn read_process_start(pid: u32) -> Result<String, String> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .map_err(|e| format!("could not inspect browser process start time: {e}"))?;
    if !output.status.success() {
        return Err(format!("browser process {pid} no longer exists"));
    }
    let start = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if start.is_empty() {
        return Err(format!(
            "browser process {pid} has no verifiable start identity"
        ));
    }
    Ok(start)
}

#[cfg(target_os = "macos")]
pub fn verify(pid: u32, expected: &str) -> Result<(), String> {
    if expected.trim().is_empty() {
        return Err("refused dashboard action: process start identity is missing".into());
    }
    let current = read_process_start(pid)?;
    if current != expected {
        return Err("refused dashboard action: PID was reused or the browser restarted".into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn verify(_pid: u32, _expected: &str) -> Result<(), String> {
    Ok(())
}

pub fn enrich_snapshot(snapshot: &mut Value) {
    #[cfg(target_os = "macos")]
    if let Some(sessions) = snapshot
        .get_mut("liveSessions")
        .and_then(Value::as_array_mut)
    {
        let memory = read_process_memory();
        for session in sessions {
            let Some(pid) = session
                .get("pid")
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
            else {
                continue;
            };
            if let Ok(start) = read_process_start(pid) {
                if let Some(object) = session.as_object_mut() {
                    object.insert("processStart".into(), Value::String(start));
                }
            }
            if let Some(mib) = tree_memory_mib(pid, &memory) {
                if let Some(object) = session.as_object_mut() {
                    object.insert("memoryMB".into(), Value::Number(mib.into()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_enrichment_never_invents_identity_for_an_invalid_pid() {
        let mut snapshot = serde_json::json!({ "liveSessions": [{ "pid": 0 }] });
        enrich_snapshot(&mut snapshot);
        assert!(snapshot["liveSessions"][0].get("processStart").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn process_tree_memory_includes_descendants_but_not_unrelated_processes() {
        let processes = parse_process_memory("10 1 1024\n11 10 2048\n12 11 3072\n20 1 9999\n");
        assert_eq!(tree_memory_mib(10, &processes), Some(6));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn exact_process_start_accepts_current_process_and_rejects_a_stale_hint() {
        let pid = std::process::id();
        let start = read_process_start(pid).expect("current test process must be inspectable");
        assert!(verify(pid, &start).is_ok());
        assert!(verify(pid, "stale process identity").is_err());
    }
}
