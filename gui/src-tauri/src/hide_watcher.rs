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

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::State;

/// Shared set of pids whose windows must be kept off-screen. Managed as Tauri
/// state and read by the watcher thread.
pub type HiddenPids = Arc<Mutex<HashSet<u32>>>;

const POLL_MS: u64 = 150;

/// Replace the watcher's hidden-pid set. Called by the frontend whenever the
/// hidden lanes (or their live pids) change.
#[tauri::command]
pub fn set_hidden_pids(pids: Vec<u32>, state: State<'_, HiddenPids>) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    *s = pids.into_iter().collect();
    Ok(())
}

/// Spawn the background watcher. Cheap no-op loop while nothing is hidden.
pub fn spawn(state: HiddenPids) {
    std::thread::spawn(move || loop {
        let pids: HashSet<u32> = match state.lock() {
            Ok(g) => g.clone(),
            Err(_) => HashSet::new(),
        };
        if !pids.is_empty() {
            #[cfg(target_os = "windows")]
            win::park_on_screen(&pids);
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    });
}

#[cfg(target_os = "windows")]
mod win {
    use std::collections::HashSet;

    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowPlacement, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
        SetWindowPos, ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        SW_SHOWNOACTIVATE, SW_SHOWMAXIMIZED, WINDOWPLACEMENT,
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
    pub fn park_on_screen(pids: &HashSet<u32>) {
        unsafe {
            let mut ctx = Collected { windows: Vec::new() };
            if EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut _ as isize)).is_err() {
                return;
            }
            for (hwnd, pid) in ctx.windows {
                if !pids.contains(&pid) {
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
        let _ = SetWindowPos(hwnd, HWND_BOTTOM, OFF, OFF, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
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
