use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
use serde::{Deserialize, Serialize};

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

trait RunningApplicationControl {
    fn is_terminated(&self) -> bool;
    fn is_hidden(&self) -> bool;
    fn hide(&self) -> bool;
    fn unhide(&self) -> bool;
    fn activate(&self) -> bool;
}

impl RunningApplicationControl for NSRunningApplication {
    fn is_terminated(&self) -> bool {
        self.isTerminated()
    }

    fn is_hidden(&self) -> bool {
        self.isHidden()
    }

    fn hide(&self) -> bool {
        self.hide()
    }

    fn unhide(&self) -> bool {
        self.unhide()
    }

    fn activate(&self) -> bool {
        self.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows)
    }
}

fn hide_application(app: &impl RunningApplicationControl) -> Result<(), String> {
    if app.is_terminated() {
        return Err("browser application has already exited".into());
    }
    if app.is_hidden() || app.hide() {
        Ok(())
    } else {
        Err("macOS refused the browser hide request".into())
    }
}

fn show_application(app: &impl RunningApplicationControl) -> Result<(), String> {
    if app.is_terminated() {
        return Err("browser application has already exited".into());
    }
    if app.is_hidden() && !app.unhide() {
        return Err("macOS refused the browser unhide request".into());
    }
    if !app.activate() {
        return Err("macOS refused the browser activation request".into());
    }
    Ok(())
}

fn running_application(pid: u32) -> Result<objc2::rc::Retained<NSRunningApplication>, String> {
    let pid = i32::try_from(pid).map_err(|_| "browser PID is outside the macOS range")?;
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .ok_or_else(|| format!("PID {pid} is not a running macOS application"))
}

pub fn focus(pid: u32) -> Result<(), String> {
    let app = running_application(pid)?;
    show_application(&*app)
}

pub fn hide(pid: u32) -> Result<MacPlacement, String> {
    let app = running_application(pid)?;
    hide_application(&*app)?;
    Ok(MacPlacement::application_hidden())
}

/// Re-hide an already verified browser PID. `NSRunningApplication::hide` is
/// application-scoped, so it also covers full-screen Spaces, popups, and newly
/// created windows without enumerating or moving individual windows.
pub fn park_on_screen(pid: u32) -> Result<(), String> {
    let app = running_application(pid)?;
    hide_application(&*app)
}

pub fn restore(pid: u32, placement: MacPlacement) -> Result<(), String> {
    if placement.platform != "macos" || !placement.application_hidden {
        return Err("invalid macOS application hide state".into());
    }
    let app = running_application(pid)?;
    show_application(&*app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct FakeApplication {
        terminated: bool,
        hidden: bool,
        hide_result: bool,
        unhide_result: bool,
        activate_result: bool,
        hide_calls: Cell<u32>,
        unhide_calls: Cell<u32>,
        activate_calls: Cell<u32>,
    }

    impl FakeApplication {
        fn visible() -> Self {
            Self {
                terminated: false,
                hidden: false,
                hide_result: true,
                unhide_result: true,
                activate_result: true,
                hide_calls: Cell::new(0),
                unhide_calls: Cell::new(0),
                activate_calls: Cell::new(0),
            }
        }
    }

    impl RunningApplicationControl for FakeApplication {
        fn is_terminated(&self) -> bool {
            self.terminated
        }

        fn is_hidden(&self) -> bool {
            self.hidden
        }

        fn hide(&self) -> bool {
            self.hide_calls.set(self.hide_calls.get() + 1);
            self.hide_result
        }

        fn unhide(&self) -> bool {
            self.unhide_calls.set(self.unhide_calls.get() + 1);
            self.unhide_result
        }

        fn activate(&self) -> bool {
            self.activate_calls.set(self.activate_calls.get() + 1);
            self.activate_result
        }
    }

    #[test]
    fn hide_visible_application_once() {
        let app = FakeApplication::visible();
        assert_eq!(hide_application(&app), Ok(()));
        assert_eq!(app.hide_calls.get(), 1);
    }

    #[test]
    fn hide_is_idempotent_when_application_is_already_hidden() {
        let mut app = FakeApplication::visible();
        app.hidden = true;
        assert_eq!(hide_application(&app), Ok(()));
        assert_eq!(app.hide_calls.get(), 0);
    }

    #[test]
    fn show_unhides_then_activates() {
        let mut app = FakeApplication::visible();
        app.hidden = true;
        assert_eq!(show_application(&app), Ok(()));
        assert_eq!(app.unhide_calls.get(), 1);
        assert_eq!(app.activate_calls.get(), 1);
    }

    #[test]
    fn show_visible_application_skips_unhide_but_activates() {
        let app = FakeApplication::visible();
        assert_eq!(show_application(&app), Ok(()));
        assert_eq!(app.unhide_calls.get(), 0);
        assert_eq!(app.activate_calls.get(), 1);
    }

    #[test]
    fn native_refusals_are_reported() {
        let mut hide_refused = FakeApplication::visible();
        hide_refused.hide_result = false;
        assert!(hide_application(&hide_refused).is_err());

        let mut unhide_refused = FakeApplication::visible();
        unhide_refused.hidden = true;
        unhide_refused.unhide_result = false;
        assert!(show_application(&unhide_refused).is_err());
        assert_eq!(unhide_refused.activate_calls.get(), 0);

        let mut activation_refused = FakeApplication::visible();
        activation_refused.activate_result = false;
        assert!(show_application(&activation_refused).is_err());
    }

    #[test]
    fn terminated_application_is_refused_without_actions() {
        let mut app = FakeApplication::visible();
        app.terminated = true;
        assert!(hide_application(&app).is_err());
        assert!(show_application(&app).is_err());
        assert_eq!(app.hide_calls.get(), 0);
        assert_eq!(app.unhide_calls.get(), 0);
        assert_eq!(app.activate_calls.get(), 0);
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
