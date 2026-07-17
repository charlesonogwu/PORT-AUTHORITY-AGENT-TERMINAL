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

Show and Hide use Apple’s Process Manager compatibility API for one exact
process identifier, then use `NSRunningApplication` to verify the observed
result. The compatibility calls are public but deprecated; they remain exported
by the macOS 15.5 SDK and were physically validated against two independent
Chrome processes on Sequoia 15.5. They do not require Accessibility permission
or a System Settings approval. A nonzero OSStatus fails closed. Before every
action, PortPilot still revalidates the registered lane, process identifier,
process start time, browser profile, and command line. An unknown, replaced, or
mismatched process is refused before the macOS process API is called.

Hiding is application-scoped, so normal windows, popup windows, and full-screen
Spaces belonging to the same verified browser process are handled together
without enumerating or moving individual windows. For Chrome and Edge, Show
first activates the exact tab displayed in the lane's Current page column by
calling `/json/activate/<target-id>` on the lane's revalidated loopback CDP
port. A mismatched port, browser, invalid target ID, or non-200 response fails
closed. PortPilot then marks the exact process visible and fronts only that
process's leading non-floating window with Apple's user-caused option. Finally,
it verifies that the exact PID actually became visible and frontmost instead of
treating an immediate status code as proof of success. Repeated watcher
requests are idempotent.

The full-screen, multiple-window, minimized-window, restart-while-hidden, and
Hide All paths still require physical Mac validation before this prototype is
release-ready. PortPilot does not use private macOS APIs.
