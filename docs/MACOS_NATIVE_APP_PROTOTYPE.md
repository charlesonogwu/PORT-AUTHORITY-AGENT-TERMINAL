# macOS native app prototype

PortPilot's Release B prototype is a local, unsigned arm64 prototype. It is not
the signed and notarized public macOS release. The npm CLI and MCP package remain
separate from this app.

## Runtime boundary

The prototype uses a configured Node executable and PortPilot npm runtime from a
verified absolute path. It does not search or execute an arbitrary `PATH` entry.
The configured runtime version must match the version expected by the app. A
public build should instead bundle a version-matched arm64 runtime sidecar so an
end user does not need Node or npm.

## App lifecycle

- Closing the red window button hides the dashboard while its background watcher
  continues running.
- Opening PortPilot again or clicking its Dock icon restores the existing window
  and does not start a second instance.
- Command+Q quits PortPilot and stops its watcher. It does not install or leave a
  helper process behind. A browser that was already hidden can remain hidden
  after quit, but PortPilot will not enforce hidden state for a newly restarted
  browser while the app is not running.

## Browser application control

Show and Hide use Apple’s public `NSRunningApplication` API for one exact process
identifier. They do not require Accessibility permission or a System Settings
approval. Before every action, PortPilot still revalidates the registered lane,
process identifier, process start time, browser profile, and command line. An
unknown, replaced, or mismatched process is refused before AppKit is called.

Hiding is application-scoped, so normal windows, popup windows, and full-screen
Spaces belonging to the same verified browser process are handled together
without enumerating or moving individual windows. Show requests an unhide and
activation for that same PID. Repeated watcher requests are idempotent.

The full-screen, multiple-window, minimized-window, restart-while-hidden, and
Hide All paths still require physical Mac validation before this prototype is
release-ready. PortPilot does not use private macOS APIs.
