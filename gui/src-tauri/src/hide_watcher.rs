// Real-time hide watcher.
//
// The dashboard's "Hide" must mean *stays gone* — even when a signup flow
// opens a fresh sign-in popup (an independent top-level window born on-screen)
// or the agent's Chrome restarts and comes up visible. A ~3s poll missed those
// for up to a refresh cycle, so the user saw flashes.
//
// This module runs a single background thread that, every ~150 ms (imperceptible
// to the eye, microseconds of work natively), enumerates every top-level window
// and shoves any on-screen one owned by a *hidden* pid off-screen to
// (-32000, -32000). The frontend keeps the hidden-pid set current (keyed by
// debug-port + profile, so a restarted Chrome's new pid is re-hidden
// automatically) via the `set_hidden_pids` command.
//
// We move POSITION (never SW_HIDE / minimize): an off-screen window stays off
// every monitor even when the agent raises it, because activation/z-order calls
// never touch position. The move is flash-hardened: send to the bottom of the
// z-order while still maximized first, drop to normal without activating, then
// re-assert the off-screen position.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::State;

use crate::commands::snapshot::fresh_snapshot;
use crate::runtime::RuntimeState;
use crate::target::{process_creation_time, verified_targets, LaneTarget};

/// Shared map of hidden pid -> process creation time. The watcher only parks a
/// window whose process still has that creation time, so a pid Windows reuses
/// for another program is never moved. Managed as Tauri state.
pub type HiddenPids = Arc<Mutex<HashMap<u32, u64>>>;

const POLL_MS: u64 = 150;

/// Bumped by every set_hidden_targets call; a slower, older call must not
/// overwrite the result of a newer one.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Leases for the targets that still match a fresh snapshot. A stale target
/// is simply left out; it never drops the others.
fn verified_leases(
    runtime: &RuntimeState,
    targets: Vec<LaneTarget>,
) -> Result<HashMap<u32, u64>, String> {
    let before: HashMap<u32, u64> = targets
        .iter()
        .filter_map(|t| {
            process_creation_time(t.pid)
                .ok()
                .map(|created| (t.pid, created))
        })
        .collect();
    let snapshot = fresh_snapshot(runtime)?;
    Ok(verified_targets(&snapshot, targets)
        .into_iter()
        .filter_map(|target| {
            let created = process_creation_time(target.pid).ok()?;
            (before.get(&target.pid) == Some(&created)).then_some((target.pid, created))
        })
        .collect())
}

/// Drop leases for pids no longer wanted and return the targets that still
/// need checking (wanted but not leased yet).
fn release_unwanted(current: &mut HashMap<u32, u64>, targets: Vec<LaneTarget>) -> Vec<LaneTarget> {
    let wanted: HashSet<u32> = targets.iter().map(|target| target.pid).collect();
    current.retain(|pid, _| wanted.contains(pid));
    targets
        .into_iter()
        .filter(|target| !current.contains_key(&target.pid))
        .collect()
}

/// Bring the watcher's hidden set in line with `targets`. The frontend calls
/// this whenever its snapshot or hidden set changes.
///
/// - Pids no longer wanted are released at once. Unhide relies on the watcher
///   letting go before it moves the window back, and releasing is always safe.
/// - Pids already leased keep their lease, so a hidden window never flashes
///   on-screen while anything is checked. Their creation time already pins them.
/// - Only newly hidden pids are checked against a fresh snapshot. A failed
///   check leaves them visible (fail open) without touching the others, and a
///   refresh that hides nothing new costs nothing.
#[tauri::command]
pub async fn set_hidden_targets(
    targets: Vec<LaneTarget>,
    state: State<'_, HiddenPids>,
    runtime: State<'_, RuntimeState>,
) -> Result<(), String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let to_verify = {
        let mut current = state.lock().map_err(|e| e.to_string())?;
        release_unwanted(&mut current, targets)
    };
    if to_verify.is_empty() {
        return Ok(());
    }
    let runtime = runtime.inner().clone();
    let leases = tauri::async_runtime::spawn_blocking(move || verified_leases(&runtime, to_verify))
        .await
        .map_err(|e| format!("hidden-target worker join failed: {}", e))??;
    let mut current = state.lock().map_err(|e| e.to_string())?;
    if GENERATION.load(Ordering::SeqCst) == generation {
        current.extend(leases);
    }
    // Otherwise a newer call owns the hidden set now and checks these itself.
    Ok(())
}

/// Spawn the background watcher. Cheap no-op loop while nothing is hidden.
pub fn spawn(state: HiddenPids) {
    std::thread::spawn(move || loop {
        let pids: HashMap<u32, u64> = match state.lock() {
            Ok(g) => g.clone(),
            Err(_) => HashMap::new(),
        };
        #[cfg(target_os = "macos")]
        for (pid, created) in &pids {
            if process_creation_time(*pid).ok().as_ref() == Some(created) {
                let _ = crate::macos_application::enforce_hide(*pid);
            }
        }
        if !pids.is_empty() {
            #[cfg(target_os = "windows")]
            win::park_on_screen(&pids);
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    });
}

#[cfg(target_os = "windows")]
mod win {
    use std::collections::HashMap;

    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowPlacement, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
        SetWindowPos, ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        SW_SHOWMAXIMIZED, SW_SHOWNOACTIVATE, WINDOWPLACEMENT,
    };

    const OFF: i32 = -32000;

    struct Collected {
        windows: Vec<(HWND, u32)>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Collected);
        if IsWindowVisible(hwnd).as_bool() {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            if pid != 0 {
                ctx.windows.push((hwnd, pid));
            }
        }
        TRUE // keep enumerating
    }

    /// Move every on-screen top-level window owned by a hidden pid off-screen.
    pub fn park_on_screen(pids: &HashMap<u32, u64>) {
        unsafe {
            let mut ctx = Collected {
                windows: Vec::new(),
            };
            if EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut _ as isize)).is_err() {
                return;
            }
            for (hwnd, pid) in ctx.windows {
                let Some(expected_creation) = pids.get(&pid) else {
                    continue;
                };
                if super::process_creation_time(pid).ok().as_ref() != Some(expected_creation) {
                    continue;
                }
                let mut r = RECT::default();
                if GetWindowRect(hwnd, &mut r).is_err() {
                    continue;
                }
                // Already parked (well off every monitor)? skip — avoids churn.
                if r.left <= OFF + 2000 && r.top <= OFF + 2000 {
                    continue;
                }
                park(hwnd);
            }
        }
    }

    unsafe fn park(hwnd: HWND) {
        let mut wp = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        let _ = GetWindowPlacement(hwnd, &mut wp);
        // 1) Off-screen + bottom-of-z-order while still maximized/snapped: any
        //    painted frame is occluded and unfocused.
        let _ = SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            OFF,
            OFF,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE,
        );
        // 2) Drop maximized -> normal WITHOUT activating, only if maximized.
        if wp.showCmd == SW_SHOWMAXIMIZED.0 as u32 {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        // 3) Re-assert off-screen (now honored for a normal-state window).
        let _ = SetWindowPos(
            hwnd,
            HWND::default(),
            OFF,
            OFF,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::release_unwanted;
    use crate::target::LaneTarget;
    use std::collections::HashMap;

    fn target(pid: u32) -> LaneTarget {
        LaneTarget {
            pid,
            lane_id: Some(format!("lane-{pid}")),
            browser: "chrome".into(),
            chrome_debug_port: 9322,
            profile_dir: format!("C:/profiles/{pid}"),
        }
    }

    #[test]
    fn unhiding_releases_the_lease_immediately_and_checks_nothing() {
        let mut leases = HashMap::from([(1, 100), (2, 200)]);
        let to_verify = release_unwanted(&mut leases, vec![target(2)]);
        assert_eq!(leases, HashMap::from([(2, 200)]));
        assert!(
            to_verify.is_empty(),
            "an already-leased pid is not re-checked"
        );
    }

    #[test]
    fn only_newly_hidden_pids_need_a_check() {
        let mut leases = HashMap::from([(1, 100)]);
        let to_verify = release_unwanted(&mut leases, vec![target(1), target(3)]);
        assert_eq!(leases, HashMap::from([(1, 100)]));
        assert_eq!(to_verify, vec![target(3)]);
    }

    #[test]
    fn an_empty_hidden_set_releases_everything() {
        let mut leases = HashMap::from([(1, 100), (2, 200)]);
        assert!(release_unwanted(&mut leases, Vec::new()).is_empty());
        assert!(leases.is_empty());
    }
}
