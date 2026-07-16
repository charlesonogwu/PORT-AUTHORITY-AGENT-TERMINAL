use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleEvent {
    CloseRequested,
    #[allow(dead_code)]
    ExitRequested,
    Reopen,
    SecondLaunch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleDecision {
    Hide,
    Close,
    Restore,
    Exit,
}

pub fn decision(event: LifecycleEvent, is_macos: bool) -> LifecycleDecision {
    match event {
        LifecycleEvent::CloseRequested if is_macos => LifecycleDecision::Hide,
        LifecycleEvent::CloseRequested => LifecycleDecision::Close,
        LifecycleEvent::ExitRequested => LifecycleDecision::Exit,
        LifecycleEvent::Reopen | LifecycleEvent::SecondLaunch => LifecycleDecision::Restore,
    }
}

pub fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_close_hides_but_quit_exits() {
        assert_eq!(
            decision(LifecycleEvent::CloseRequested, true),
            LifecycleDecision::Hide
        );
        assert_eq!(
            decision(LifecycleEvent::ExitRequested, true),
            LifecycleDecision::Exit
        );
    }

    #[test]
    fn reopen_and_second_launch_restore_the_existing_window() {
        assert_eq!(
            decision(LifecycleEvent::Reopen, true),
            LifecycleDecision::Restore
        );
        assert_eq!(
            decision(LifecycleEvent::SecondLaunch, true),
            LifecycleDecision::Restore
        );
    }

    #[test]
    fn windows_close_behavior_is_preserved() {
        assert_eq!(
            decision(LifecycleEvent::CloseRequested, false),
            LifecycleDecision::Close
        );
    }
}
