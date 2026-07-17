// focus_chrome / hide_chrome / unhide_chrome — control a Chrome lane window.
//
// HIDE is a persistent OFF-SCREEN MOVE, never SW_HIDE. SW_HIDE/SW_MINIMIZE
// toggle a show-state bit that the driving agent's next Page.bringToFront()
// (-> SW_SHOW/SW_RESTORE) flips right back, so a hidden window pops back onto
// the desktop on the agent's very next action. POSITION, by contrast, is never
// changed by activation or z-order calls (SetForegroundWindow/BringWindowToTop
// are pure focus/z-order; SW_SHOW means "in its current size and position").
// So a window left SHOWN but parked at (-32000,-32000) stays off every monitor
// no matter how many times the agent raises it — until the user clicks Unhide.
// This is the same mechanism PortPilot's "background" launch mode uses
// (OFFSCREEN_WINDOW_ARGS), applied post-hoc to a running HWND.
//
// hide_chrome captures the window's WINDOWPLACEMENT (show-state + the normal
// on-screen rect) and returns it so the dashboard can persist it and restore
// the window to exactly where it was on Unhide.
//
// Windows: native Win32 for Show; PowerShell + Win32 P/Invoke for Hide/Unhide.
// macOS: exact-PID NSRunningApplication control with a revalidation watcher.
// Linux: best-effort set-visible / wmctrl behavior.

#[cfg(not(target_os = "macos"))]
use crate::cli::quiet_command;
use crate::commands::action_safety::revalidate_lane_action;
use crate::runtime::RuntimeState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::time::{Duration, Instant};
use tauri::State;

const CDP_ACTIVATION_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpActivationRequest {
    debug_port: u16,
    browser: String,
    tab_id: String,
}

async fn validated_lane_action(
    runtime: State<'_, RuntimeState>,
    lane_id: String,
    pid: u32,
    process_start: String,
) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    match tauri::async_runtime::spawn_blocking(move || {
        revalidate_lane_action(&runtime, &lane_id, pid, &process_start)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("lane validation worker failed: {error}")),
    }
}

fn validate_cdp_target_id(target_id: &str) -> Result<(), String> {
    if target_id.is_empty()
        || target_id.len() > 128
        || !target_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("refused CDP activation: invalid tab target id".into());
    }
    Ok(())
}

fn activate_cdp_target_with_stream(
    mut stream: TcpStream,
    port: u16,
    target_id: &str,
) -> Result<(), String> {
    validate_cdp_target_id(target_id)?;
    let request = format!(
        "PUT /json/activate/{target_id} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("could not request the exact browser tab: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("could not send the exact browser tab request: {error}"))?;

    // Chrome may keep this tiny HTTP connection alive. Success is completely
    // determined by the status line, so do not wait for EOF. On macOS a timed
    // or temporarily nonblocking read can surface as EAGAIN (OS error 35);
    // retry it only inside this short, bounded deadline.
    let deadline = Instant::now() + CDP_ACTIVATION_TIMEOUT;
    let mut response = Vec::with_capacity(256);
    loop {
        if let Some(newline) = response.iter().position(|byte| *byte == b'\n') {
            let status = String::from_utf8_lossy(&response[..newline])
                .trim_end_matches('\r')
                .to_string();
            let mut parts = status.split_whitespace();
            let protocol = parts.next().unwrap_or_default();
            let code = parts.next().unwrap_or_default();
            if matches!(protocol, "HTTP/1.1" | "HTTP/1.0") && code == "200" {
                return Ok(());
            }
            return Err(format!(
                "browser refused to activate tab {target_id} on debug port {port} ({status})"
            ));
        }
        if response.len() >= 8 * 1024 {
            return Err("browser tab response has no bounded HTTP status line".into());
        }
        if Instant::now() >= deadline {
            return Err("timed out reading the browser tab response status".into());
        }

        let mut chunk = [0_u8; 512];
        match stream.read(&mut chunk) {
            Ok(0) => return Err("browser tab response ended before its HTTP status".into()),
            Ok(size) => response.extend_from_slice(&chunk[..size]),
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => {
                return Err(format!("could not read the browser tab response: {error}"));
            }
        }
    }
}

fn activate_cdp_target(port: u16, target_id: &str) -> Result<(), String> {
    validate_cdp_target_id(target_id)?;
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let stream =
        TcpStream::connect_timeout(&address.into(), CDP_ACTIVATION_TIMEOUT).map_err(|error| {
            format!("could not reach the verified browser tab on port {port}: {error}")
        })?;
    stream
        .set_read_timeout(Some(CDP_ACTIVATION_TIMEOUT))
        .map_err(|error| format!("could not set browser response timeout: {error}"))?;
    stream
        .set_write_timeout(Some(CDP_ACTIVATION_TIMEOUT))
        .map_err(|error| format!("could not set browser request timeout: {error}"))?;
    activate_cdp_target_with_stream(stream, port, target_id)
}

fn checked_cdp_activation(
    validation: &Value,
    requested_port: Option<u16>,
    requested_browser: Option<&str>,
    target_id: Option<&str>,
) -> Result<Option<(u16, String)>, String> {
    let Some(target_id) = target_id else {
        return Ok(None);
    };
    validate_cdp_target_id(target_id)?;
    let lane = validation
        .get("lane")
        .ok_or_else(|| "refused CDP activation: validated lane is missing".to_string())?;
    let lane_port = lane
        .get("chromeDebugPort")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or_else(|| "refused CDP activation: validated lane port is missing".to_string())?;
    if requested_port != Some(lane_port) {
        return Err(
            "refused CDP activation: dashboard port does not match the validated lane".into(),
        );
    }
    let lane_browser = lane
        .get("browser")
        .and_then(Value::as_str)
        .unwrap_or("chrome");
    let requested_browser = requested_browser.unwrap_or("chrome");
    if requested_browser != lane_browser {
        return Err(
            "refused CDP activation: dashboard browser does not match the validated lane".into(),
        );
    }
    if !matches!(lane_browser, "chrome" | "edge") {
        return Ok(None);
    }
    Ok(Some((lane_port, target_id.to_string())))
}

async fn activate_exact_tab(activation: Option<(u16, String)>) -> Result<(), String> {
    let Some((port, target_id)) = activation else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || activate_cdp_target(port, &target_id))
        .await
        .map_err(|error| format!("browser tab activation worker failed: {error}"))?
}

/// The small amount of window metadata needed to decide whether a top-level
/// HWND is Chrome's real browser frame rather than one of its helper windows.
/// Kept platform-neutral so the selection rule is unit-testable.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowCandidate {
    class_name: String,
    title: String,
    width: i32,
    height: i32,
}

/// Higher is a better Show target. A real browser frame may be temporarily
/// represented by Windows as a 160x28 minimized placeholder, so size alone
/// cannot reject it.
#[cfg(any(target_os = "windows", test))]
fn browser_window_rank(candidate: &WindowCandidate) -> Option<u8> {
    if candidate.width <= 0 || candidate.height <= 0 {
        return None;
    }

    // Chrome/Edge's tabbed browser frame is Chrome_WidgetWin_1. Its helper
    // surfaces use other classes (including Chrome_WidgetWin_0) and must never
    // be shown in place of the user's actual tabbed browser.
    if candidate.class_name != "Chrome_WidgetWin_1" {
        return None;
    }

    if candidate.title.trim().is_empty() {
        Some(2)
    } else {
        Some(3)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        activate_cdp_target_with_stream, browser_window_rank, checked_cdp_activation,
        validate_cdp_target_id, WindowCandidate,
    };
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;
    use std::time::{Duration, Instant};

    fn candidate(class_name: &str, title: &str, width: i32, height: i32) -> WindowCandidate {
        WindowCandidate {
            class_name: class_name.into(),
            title: title.into(),
            width,
            height,
        }
    }

    #[test]
    fn selects_a_minimized_titled_chrome_frame() {
        // Windows reports a minimized Chrome browser as this 160x28 placeholder.
        // It is still the user's real tabbed frame and Show must restore it.
        assert_eq!(
            browser_window_rank(&candidate(
                "Chrome_WidgetWin_1",
                "Project Cooler - Google Chrome",
                160,
                28,
            )),
            Some(3),
        );
    }

    #[test]
    fn rejects_chrome_helper_windows() {
        assert_eq!(
            browser_window_rank(&candidate("Chrome_WidgetWin_0", "", 160, 28)),
            None,
        );
    }

    #[test]
    fn rejects_zero_sized_windows() {
        assert_eq!(
            browser_window_rank(&candidate("Chrome_WidgetWin_1", "Chrome", 0, 0)),
            None,
        );
    }

    #[test]
    fn cdp_activation_targets_the_exact_tab_over_loopback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let size = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request
                .starts_with("PUT /json/activate/6D2D652F143283327CAB85B3373381BD HTTP/1.1\r\n"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\nTarget activated",
                )
                .unwrap();
        });

        let stream = TcpStream::connect(address).unwrap();
        activate_cdp_target_with_stream(stream, address.port(), "6D2D652F143283327CAB85B3373381BD")
            .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn cdp_activation_accepts_200_without_waiting_for_eof_and_retries_would_block() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).unwrap();
            thread::sleep(Duration::from_millis(50));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: keep-alive\r\n\r\nTarget activated",
                )
                .unwrap();
            thread::sleep(Duration::from_millis(500));
        });

        let stream = TcpStream::connect(address).unwrap();
        stream.set_nonblocking(true).unwrap();
        let started = Instant::now();
        activate_cdp_target_with_stream(stream, address.port(), "6D2D652F143283327CAB85B3373381BD")
            .unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "activation waited for the server to close its successful response"
        );
        server.join().unwrap();
    }

    #[test]
    fn cdp_activation_refuses_path_or_header_injection() {
        for target in ["", "../../json/version", "tab id", "tab\r\nInjected: yes"] {
            assert!(
                validate_cdp_target_id(target).is_err(),
                "accepted {target:?}"
            );
        }
        assert!(validate_cdp_target_id("6D2D652F143283327CAB85B3373381BD").is_ok());
    }

    #[test]
    fn cdp_activation_requires_the_revalidated_lane_port_and_browser() {
        let validated = json!({
            "lane": { "chromeDebugPort": 9322, "browser": "chrome" }
        });
        let exact = checked_cdp_activation(
            &validated,
            Some(9322),
            Some("chrome"),
            Some("6D2D652F143283327CAB85B3373381BD"),
        )
        .unwrap();
        assert_eq!(
            exact,
            Some((9322, "6D2D652F143283327CAB85B3373381BD".to_string()))
        );
        assert!(checked_cdp_activation(
            &validated,
            Some(9323),
            Some("chrome"),
            Some("6D2D652F143283327CAB85B3373381BD")
        )
        .is_err());
        assert!(checked_cdp_activation(
            &validated,
            Some(9322),
            Some("edge"),
            Some("6D2D652F143283327CAB85B3373381BD")
        )
        .is_err());
    }
}

/* -------------------------------------------------------------------------- */
/*  focus_chrome (unchanged behavior): bring a window to the foreground.       */
/* -------------------------------------------------------------------------- */

#[tauri::command]
pub async fn focus_chrome(
    lane_id: String,
    pid: u32,
    process_start: String,
    tab: Option<CdpActivationRequest>,
    runtime: State<'_, RuntimeState>,
) -> Result<Value, String> {
    let validation = match validated_lane_action(runtime, lane_id, pid, process_start.clone()).await
    {
        Ok(validation) => validation,
        Err(error) => return Ok(json!({ "ok": false, "pid": pid, "error": error })),
    };
    if let Err(error) = crate::process_identity::verify(pid, &process_start) {
        return Ok(json!({ "ok": false, "pid": pid, "error": error }));
    }
    let activation = match checked_cdp_activation(
        &validation,
        tab.as_ref().map(|tab| tab.debug_port),
        tab.as_ref().map(|tab| tab.browser.as_str()),
        tab.as_ref().map(|tab| tab.tab_id.as_str()),
    ) {
        Ok(activation) => activation,
        Err(error) => return Ok(json!({ "ok": false, "pid": pid, "error": error })),
    };
    if let Err(error) = activate_exact_tab(activation).await {
        return Ok(json!({ "ok": false, "pid": pid, "error": error }));
    }
    #[cfg(target_os = "macos")]
    let result = crate::macos_application::focus(pid).await;
    #[cfg(not(target_os = "macos"))]
    let result = run_focus(pid);
    Ok(match result {
        Ok(()) => json!({ "ok": true, "pid": pid }),
        Err(e) => json!({ "ok": false, "pid": pid, "error": e }),
    })
}

/* -------------------------------------------------------------------------- */
/*  hide_chrome: persistent native hide; returns its safe restore state.       */
/* -------------------------------------------------------------------------- */

#[tauri::command]
pub async fn hide_chrome(
    lane_id: String,
    pid: u32,
    process_start: String,
    runtime: State<'_, RuntimeState>,
) -> Result<Value, String> {
    if let Err(error) = validated_lane_action(runtime, lane_id, pid, process_start.clone()).await {
        return Ok(json!({ "ok": false, "pid": pid, "placement": Value::Null, "error": error }));
    }
    if let Err(error) = crate::process_identity::verify(pid, &process_start) {
        return Ok(json!({ "ok": false, "pid": pid, "placement": Value::Null, "error": error }));
    }
    #[cfg(target_os = "windows")]
    {
        Ok(windows_hide(pid))
    }
    #[cfg(target_os = "macos")]
    {
        let result = crate::macos_application::hide(pid).await;
        Ok(match result {
            Ok(placement) => json!({ "ok": true, "pid": pid, "placement": placement }),
            Err(e) => json!({ "ok": false, "pid": pid, "placement": Value::Null, "error": e }),
        })
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let result = unix_hide(pid);
        Ok(match result {
            Ok(()) => json!({ "ok": true, "pid": pid, "placement": Value::Null }),
            Err(e) => json!({ "ok": false, "pid": pid, "placement": Value::Null, "error": e }),
        })
    }
}

/* -------------------------------------------------------------------------- */
/*  unhide_chrome: reverse the native hide and restore placement when known.   */
/* -------------------------------------------------------------------------- */

/// Placement the dashboard passes back to restore a hidden window. Comes from
/// the JSON hide_chrome returned, stored verbatim in the frontend. `showCmd`
/// is the Win32 SW_* the window had before hiding (3 = maximized).
#[cfg(target_os = "windows")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinPlacement {
    pub show_cmd: i32,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[tauri::command]
pub async fn unhide_chrome(
    lane_id: String,
    pid: u32,
    process_start: String,
    placement: Value,
    tab: Option<CdpActivationRequest>,
    runtime: State<'_, RuntimeState>,
) -> Result<Value, String> {
    let validation = match validated_lane_action(runtime, lane_id, pid, process_start.clone()).await
    {
        Ok(validation) => validation,
        Err(error) => return Ok(json!({ "ok": false, "pid": pid, "error": error })),
    };
    if let Err(error) = crate::process_identity::verify(pid, &process_start) {
        return Ok(json!({ "ok": false, "pid": pid, "error": error }));
    }
    let activation = match checked_cdp_activation(
        &validation,
        tab.as_ref().map(|tab| tab.debug_port),
        tab.as_ref().map(|tab| tab.browser.as_str()),
        tab.as_ref().map(|tab| tab.tab_id.as_str()),
    ) {
        Ok(activation) => activation,
        Err(error) => return Ok(json!({ "ok": false, "pid": pid, "error": error })),
    };
    if let Err(error) = activate_exact_tab(activation).await {
        return Ok(json!({ "ok": false, "pid": pid, "error": error }));
    }
    #[cfg(target_os = "windows")]
    {
        let placement: WinPlacement = serde_json::from_value(placement)
            .map_err(|e| format!("invalid Windows window placement: {e}"))?;
        // Sanity-guard the saved rect: if it is degenerate or itself off-screen
        // (lost/garbled state, monitor unplugged), never restore invisibly.
        let invalid = placement.left <= -30000
            || placement.top <= -30000
            || placement.right - placement.left <= 0
            || placement.bottom - placement.top <= 0;
        let (sc, l, t, r, b) = if invalid {
            (1, 80, 80, 80 + 1280, 80 + 1000)
        } else {
            (
                placement.show_cmd,
                placement.left,
                placement.top,
                placement.right,
                placement.bottom,
            )
        };
        Ok(windows_unhide(pid, sc, l, t, r, b))
    }
    #[cfg(target_os = "macos")]
    {
        let placement: crate::macos_application::MacPlacement = serde_json::from_value(placement)
            .unwrap_or_else(|_| crate::macos_application::MacPlacement::application_hidden());
        let result = crate::macos_application::restore(pid, placement).await;
        Ok(match result {
            Ok(()) => json!({ "ok": true, "pid": pid }),
            Err(e) => json!({ "ok": false, "pid": pid, "error": e }),
        })
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = placement;
        let result = run_focus(pid);
        Ok(match result {
            Ok(()) => json!({ "ok": true, "pid": pid }),
            Err(e) => json!({ "ok": false, "pid": pid, "error": e }),
        })
    }
}

/* -------------------------------------------------------------------------- */
/*  Windows implementations                                                    */
/* -------------------------------------------------------------------------- */

#[cfg(target_os = "windows")]
fn run_focus(pid: u32) -> Result<(), String> {
    // Native Show path: find the actual Chrome tabbed frame, restore it before
    // moving it on-screen, then raise it. Unlike the old PowerShell path, this
    // never opens a console host.
    win_focus::focus_browser_window(pid)
}

#[cfg(target_os = "windows")]
mod win_focus {
    use super::{browser_window_rank, WindowCandidate};
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, SetForegroundWindow, SetWindowPos, ShowWindow, SWP_NOZORDER,
        SW_RESTORE,
    };

    struct FoundWindow {
        hwnd: HWND,
        candidate: WindowCandidate,
    }

    struct Collected {
        target_pid: u32,
        windows: Vec<FoundWindow>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Collected);
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != ctx.target_pid {
            return TRUE;
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return TRUE;
        }
        let mut class_name = [0_u16; 256];
        let mut title = [0_u16; 512];
        let class_len = GetClassNameW(hwnd, &mut class_name).max(0) as usize;
        let title_len = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        ctx.windows.push(FoundWindow {
            hwnd,
            candidate: WindowCandidate {
                class_name: String::from_utf16_lossy(&class_name[..class_len]),
                title: String::from_utf16_lossy(&title[..title_len]),
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            },
        });
        TRUE
    }

    pub fn focus_browser_window(pid: u32) -> Result<(), String> {
        unsafe {
            let target = find_browser_window(pid)?;

            // Windows first represents a minimized Chrome browser as a small
            // placeholder at -32000. Restore it before checking/moving bounds;
            // moving that placeholder does not move the restored browser.
            let _ = ShowWindow(target, SW_RESTORE);

            let mut rect = RECT::default();
            GetWindowRect(target, &mut rect)
                .map_err(|e| format!("could not read browser window bounds: {e}"))?;
            if rect.left <= -30000 || rect.top <= -30000 {
                SetWindowPos(target, HWND::default(), 80, 80, 1280, 1000, SWP_NOZORDER)
                    .map_err(|e| format!("could not move browser window on-screen: {e}"))?;
            }

            let _ = BringWindowToTop(target);
            let _ = SetForegroundWindow(target);
            Ok(())
        }
    }

    fn find_browser_window(pid: u32) -> Result<HWND, String> {
        unsafe {
            let mut ctx = Collected {
                target_pid: pid,
                windows: Vec::new(),
            };
            EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut _ as isize))
                .map_err(|e| format!("could not enumerate browser windows: {e}"))?;
            let found = ctx
                .windows
                .iter()
                .map(|window| {
                    format!(
                        "{} {:?} {}x{}",
                        window.candidate.class_name,
                        window.candidate.title,
                        window.candidate.width,
                        window.candidate.height
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            ctx.windows
                .into_iter()
                .filter_map(|found| browser_window_rank(&found.candidate).map(|rank| (rank, found)))
                .max_by_key(|(rank, _)| *rank)
                .map(|(_, found)| found.hwnd)
                .ok_or_else(|| format!(
                    "PID {pid} has no Chrome browser window (headless browsers have none; found: {found})"
                ))
        }
    }
}

// The Win32 helper class + Park() routine shared by hide and park_windows.
// EnumWindows -> every VISIBLE, non-zero-size top-level window owned by the pid
// (the main browser window AND any independent popups: OAuth/sign-in windows,
// "Restore pages?" bubbles, etc. — these are separate top-level windows that do
// NOT follow the main window off-screen on their own). Park() applies the
// flash-hardened off-screen move to one HWND: move off-screen + send to bottom
// while still maximized/snapped (X/Y ignored when maximized, but bottom +
// NOACTIVATE occludes any frame), un-maximize without activating if needed,
// then re-assert the off-screen position with SetWindowPos (never
// SetWindowPlacement — it clamps a fully-off-screen rect back on-screen).
#[cfg(target_os = "windows")]
const PPWIN_PREAMBLE: &str = r#"Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public class PpWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int X, int Y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length; public int flags; public int showCmd; public POINT a; public POINT b; public RECT rcNormalPosition; }
  public static IntPtr[] TopLevelVisible(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h,l)=>{ uint p; GetWindowThreadProcessId(h, out p); if (p!=pid) return true; if (!IsWindowVisible(h)) return true; RECT r; GetWindowRect(h, out r); if (r.Right-r.Left<=0 || r.Bottom-r.Top<=0) return true; list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  // The window Show should target. INCLUDES HIDDEN windows: background-mode
  // lanes spawn Chrome with the initial show-state SW_HIDE, so the real
  // browser window is invisible AND off-screen. Filter to real-sized windows
  // (>=200x200 — excludes IME/compositor helpers) and prefer a titled one
  // (Chrome's actual browser window carries the page title; its similarly
  // sized compositor sibling does not).
  public static IntPtr BestShowTarget(uint pid) {
    IntPtr first = IntPtr.Zero; IntPtr titled = IntPtr.Zero;
    EnumWindows((h,l)=>{ uint p; GetWindowThreadProcessId(h, out p); if (p!=pid) return true; RECT r; GetWindowRect(h, out r); if (r.Right-r.Left<200 || r.Bottom-r.Top<200) return true; if (first==IntPtr.Zero) first=h; if (titled==IntPtr.Zero) { var sb=new System.Text.StringBuilder(4); GetWindowText(h, sb, 4); if (sb.Length>0) titled=h; } return true; }, IntPtr.Zero);
    return titled != IntPtr.Zero ? titled : first;
  }
}
'@
$OFF=-32000
function Park($h) {
  $wp = New-Object "PpWin+WINDOWPLACEMENT"; $wp.length=[System.Runtime.InteropServices.Marshal]::SizeOf($wp)
  [void][PpWin]::GetWindowPlacement($h,[ref]$wp)
  [void][PpWin]::SetWindowPos($h,[System.IntPtr]1,$OFF,$OFF,0,0,(0x1 -bor 0x10))
  if ($wp.showCmd -eq 3) { [void][PpWin]::ShowWindow($h,4) }
  [void][PpWin]::SetWindowPos($h,[System.IntPtr]::Zero,$OFF,$OFF,0,0,(0x1 -bor 0x4 -bor 0x10))
}
"#;

#[cfg(target_os = "windows")]
fn windows_hide(pid: u32) -> Value {
    // Capture the MAIN window's original placement BEFORE parking (so the rect
    // returned for Unhide is the on-screen one), then park EVERY top-level
    // window the process owns.
    let script = format!(
        r#"$ErrorActionPreference='Stop'
try {{
  $proc = Get-Process -Id {pid} -ErrorAction Stop
{preamble}
  $main = $proc.MainWindowHandle
  $mainWp = $null
  if ($main -ne [System.IntPtr]::Zero) {{
    $mainWp = New-Object "PpWin+WINDOWPLACEMENT"; $mainWp.length=[System.Runtime.InteropServices.Marshal]::SizeOf($mainWp)
    [void][PpWin]::GetWindowPlacement($main,[ref]$mainWp)
  }}
  foreach ($h in [PpWin]::TopLevelVisible([uint32]{pid})) {{ Park ([System.IntPtr]$h) }}
  if ($mainWp -ne $null) {{
    @{{ showCmd=$mainWp.showCmd; left=$mainWp.rcNormalPosition.Left; top=$mainWp.rcNormalPosition.Top; right=$mainWp.rcNormalPosition.Right; bottom=$mainWp.rcNormalPosition.Bottom }} | ConvertTo-Json -Compress | Write-Output
  }} else {{ Write-Output '{{}}' }}
  exit 0
}} catch {{ [Console]::Error.WriteLine($_.Exception.Message); exit 1 }}"#,
        pid = pid,
        preamble = PPWIN_PREAMBLE,
    );

    match run_powershell(&script) {
        Ok(stdout) => {
            let placement = serde_json::from_str::<Value>(stdout.trim()).unwrap_or(Value::Null);
            json!({ "ok": true, "pid": pid, "placement": placement })
        }
        Err(e) => json!({ "ok": false, "pid": pid, "placement": Value::Null, "error": e }),
    }
}

// Note: continuous off-screen enforcement (catching popup/sign-in windows and
// re-hiding restarted Chromes) is handled natively by hide_watcher.rs, not by a
// per-pid PowerShell loop. hide_chrome below is only the one-shot "Hide click"
// that captures placement for a later Unhide and parks immediately.

#[cfg(target_os = "windows")]
fn windows_unhide(pid: u32, show_cmd: i32, left: i32, top: i32, right: i32, bottom: i32) -> Value {
    // Reverse of hide: move back to the saved on-screen rect (no clamp issue,
    // coords are on-screen), restore the original show-state (re-maximize if it
    // was maximized; else normal), then bring to front + focus (intentional —
    // Unhide is a "show me this window" action).
    let script = r#"$ErrorActionPreference='Stop'
try {
  $proc = Get-Process -Id __PID__ -ErrorAction Stop
  $hwnd = $proc.MainWindowHandle
  if ($hwnd -eq [System.IntPtr]::Zero) { [Console]::Error.WriteLine("no window for PID __PID__"); exit 1 }
  Add-Type -Name PpShow -Namespace PpNs -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int X, int Y, int cx, int cy, uint f);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@
  $SWP_NOZORDER=0x4; $SWP_NOACTIVATE=0x10
  $SW_SHOWMAXIMIZED=3; $SW_SHOWNORMAL=1
  $L=__LEFT__; $T=__TOP__; $W=(__RIGHT__ - __LEFT__); $H=(__BOTTOM__ - __TOP__)
  [void][PpNs.PpShow]::SetWindowPos($hwnd, [System.IntPtr]::Zero, $L, $T, $W, $H, ($SWP_NOZORDER -bor $SWP_NOACTIVATE))
  if (__SHOWCMD__ -eq 3) { [void][PpNs.PpShow]::ShowWindow($hwnd, $SW_SHOWMAXIMIZED) } else { [void][PpNs.PpShow]::ShowWindow($hwnd, $SW_SHOWNORMAL) }
  [void][PpNs.PpShow]::SetForegroundWindow($hwnd)
  exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"#
        .replace("__PID__", &pid.to_string())
        .replace("__SHOWCMD__", &show_cmd.to_string())
        .replace("__LEFT__", &left.to_string())
        .replace("__TOP__", &top.to_string())
        .replace("__RIGHT__", &right.to_string())
        .replace("__BOTTOM__", &bottom.to_string());

    match run_powershell(&script) {
        Ok(_) => json!({ "ok": true, "pid": pid }),
        Err(e) => json!({ "ok": false, "pid": pid, "error": e }),
    }
}

/// Run a PowerShell script (console suppressed) and return trimmed stdout on
/// success, or a formatted error on non-zero exit / spawn failure.
#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<String, String> {
    let output = quiet_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("failed to spawn powershell: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "powershell exit {}: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/* -------------------------------------------------------------------------- */
/*  Linux implementations (best-effort)                                        */
/* -------------------------------------------------------------------------- */

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn run_focus(pid: u32) -> Result<(), String> {
    let output = quiet_command("wmctrl")
        .args(["-i", "-x", "-p", &pid.to_string(), "-a"])
        .output()
        .map_err(|e| format!("wmctrl not available: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "wmctrl exit {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn unix_hide(pid: u32) -> Result<(), String> {
    // Best-effort: move off-screen via wmctrl -e (gravity,x,y,w,h = keep size).
    let output = quiet_command("wmctrl")
        .args([
            "-i",
            "-x",
            "-p",
            &pid.to_string(),
            "-e",
            "0,-32000,-32000,-1,-1",
        ])
        .output()
        .map_err(|e| format!("wmctrl not available: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "wmctrl exit {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}
