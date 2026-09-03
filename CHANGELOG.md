# Changelog

All notable changes to `port-authority-agent-terminal-mcp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.4.2] — immutable PPID reconnect

### Fixed

- Persistent browser profiles can be reopened by immutable lane ID with
  `--lane-id`, even after release, staleness, supervisor restart, or debug-port
  reassignment. Exact reopen never silently creates a replacement profile.
- Tuple lookup now fails closed when one owner/project/session maps to distinct
  profiles, and reports the candidate PPIDs instead of choosing arbitrarily.
- Duplicate records for the same browser profile deterministically retain one
  stable PPID and retire the redundant port claims.

### Added

- CLI and MCP exact-ID selection for open, check, page control, browser close,
  release, and existing-lane launch operations.
- Guarded orphan-profile adoption, restricted to existing directories beneath
  PortPilot's own profiles directory; normal browser profiles are refused.
- The dashboard shows and copies the exact `paat open --lane-id <PPID>` reconnect
  command.

---

## [0.4.1] — persistent browser supervisor

### Fixed

- Persistent browser processes are now launched by a user-scoped PortPilot
  supervisor started by the native dashboard, rather than by disposable MCP
  workers. Cancelling or restarting an MCP controller no longer owns the
  browser process lifetime.
- MCP and CLI reconnect through an authenticated local socket and reverify the
  lane's browser, profile, debugging port, and process before reuse.

### Added

- `close_browser` (MCP) and `close-browser` (CLI) explicitly terminate one
  reverified lane browser. `release_lane` remains bookkeeping-only.
- Registry metadata distinguishes browser lifecycle and supervisor identity
  without changing existing lane-allocation status semantics.
- Windows lifecycle coverage proves a supervised process survives controller
  termination, reconnects with the same PID, and exits only on explicit close.

---

## [0.4.0] — macOS browser safety/runtime foundation

### Added

- macOS listener scanning enriches `lsof` records with an argument-safe `ps`
  command-line lookup, allowing Chrome, Edge, and Firefox profile ownership to
  be proven before attachment.
- Browser discovery covers `/Applications`, `~/Applications`, and common
  Chrome, Edge, and Firefox variants. Missing Edge never falls back to Chrome.

### Changed

- Node.js **22.4+** is required because CDP and WebDriver BiDi use Node's
  native WebSocket implementation. `zod` is now a direct runtime dependency.
- macOS CI is labeled as a generic hosted runner and logs its architecture; it
  does not claim Apple-silicon coverage.

### Safety

- Missing, malformed, or unverifiable process command lines fail closed:
  PortPilot refuses attachment instead of guessing a browser profile.

### Limitations

- This release does not add a macOS `.app`, signing/notarization, Dock or
  Applications integration, LaunchAgents, or macOS Show/Hide parity.

## [0.3.17] — reliable Windows Show and dashboard shortcut recovery

### Fixed

- **Dashboard Show now restores minimized Chromium windows correctly.** Windows
  reports a minimized Chrome/Edge tabbed frame as a tiny off-screen placeholder;
  the old Show path rejected it and went through PowerShell, which could leave a
  blank black window instead of the browser. Show now finds the real tabbed
  frame, restores it before repositioning it, then raises it with native Win32
  calls. It never launches a PowerShell console.
- **Windows shortcut recovery is verified against the stable dashboard install
  path.** Reinstalling the package stages the dashboard and its icon together
  in `%LOCALAPPDATA%\\PAAT`, so the desktop and Start Menu shortcuts do not
  depend on a transient package-cache path.

### Tests

- Rust unit tests cover selection of the real minimized Chrome frame and
  rejection of blank/zero-sized helper windows.

---

## [0.3.16] — dashboard: bulk buttons only when there's something to bulk

### Changed

- **"Hide all (1)" / "Kill all (1)" no longer render for single-session
  groups** — with one lane, the row's own Show/Hide/Kill/Erase buttons
  already cover it, so the group-header bulk buttons were pure noise. They
  appear only when a project directory has 2+ live sessions. Same rule for
  the top-level Hide all / Kill all next to the Default-browser picker:
  hidden when only one session is live machine-wide.

## [0.3.15] — belt-and-suspenders isolation from Windows shell URL hijack

### Fixed

- **Chrome and Edge lanes no longer silently install "default web apps"
  into their profiles.** Edge's onboarding auto-installed Adblock Plus and
  (on some profiles) other recommended extensions the moment a lane spawned
  — a welcome tab and an extension background page appeared in the lane's
  CDP tab list, which reads as "an external URL joined my lane" even though
  it was really Edge's own onboarding. Every lane now launches with
  `--disable-default-apps`, so a fresh lane's tab list contains only what
  the agent asked for.

### Hardened

- **Additional isolation flags on every Chrome/Edge launch mode**
  (`--disable-default-apps`, `--no-service-autorun`,
  `--disable-background-networking`). None of these change what an agent
  can do; each closes a specific vector a Windows-shell URL could reach the
  lane's profile through (default-app registration, Windows Service
  autorun, background networking). Applied BEFORE any caller `extraArgs`
  so nothing can override them.
- Firefox lanes already rely on `-no-remote`, Firefox's definitive
  isolation switch — unchanged.

### Investigation notes

Four controlled reproduction attempts (visible + background mode; with and
without Edge Startup Boost; with and without a running default-profile
Edge) on Windows 11 + Edge 150 with the 0.3.14 flags all showed external
URLs correctly spawning or reusing a fresh default-profile Edge, never
joining a PortPilot lane. Primary isolation (Chromium's process singleton
is a file lock per `--user-data-dir`) is working. The new flags are
defense-in-depth against untested scenarios and — most importantly — fix
the extension auto-install intrusion above, which we now believe is the
actual symptom being reported.

### Tests

- New `tests/shell-url-isolation.test.ts` locks in the three isolation
  invariants a refactor could easily weaken:
  1. every launch plan sets `--user-data-dir` to the lane's dedicated
     profile (never to an OS-default profile path);
  2. every launch plan carries `--no-first-run --no-default-browser-check`
     plus the hardening flags on every mode;
  3. hardening flags come BEFORE caller `extraArgs` so a caller can't
     override them by passing a duplicate.
- 10 new tests; suite: 336 pass / 0 fail.

## [0.3.14] — dashboard Show works on background lanes

### Fixed

- **"Show" now works for background-mode lanes.** Background lanes spawn
  their browser parked off-screen AND with the initial window state hidden,
  so the old lookup (Process.MainWindowHandle, visible-only) found nothing
  and errored — Show had never worked for exactly the lanes users most want
  to bring forward. The window is now located via EnumWindows including
  hidden windows (real-sized, page-titled ones preferred over Chrome's
  IME/compositor helpers), un-hidden, moved on-screen if parked, and
  focused: Show literally means "show me this browser" for every launch
  mode now.
- **Readable window-action errors.** PowerShell's Write-Error prefixes the
  entire embedded script to stderr, which rendered every Show/Hide/Unhide
  failure toast as truncated "$ErrorActio…" garbage. Errors now emit just
  the message (e.g. "PID 1234 has no browser window (headless browsers have
  none)").

## [0.3.13] — atomic port reclaim (fixes the two-lanes-one-port conflict)

### Fixed

- **Reclaiming a stale lane's port now retires the stale lane's claim in the
  same transaction.** 0.3.12 let new lanes reuse ports held by stale lanes
  whose browser was gone, but left the port on the stale lane's registry
  record — so both lanes claimed the port and the dashboard (correctly)
  reported "2 reservations claim port …" plus a profile-mismatch conflict.
  The stale lane keeps its identity and profile; only the port reference is
  dropped.
- **A lane that comes back after losing its port gets a fresh one.** The
  existing-lane (reconnect) path now tops up any port this call needs and
  the lane is missing — same lane id, same profile (logins survive), new
  port, and never a double-claim. Lanes reserved with `--no-chrome-port` /
  `--no-app-port` stay portless when the caller still opts out.

## [0.3.12] — conserve RAM: page_newtab + a RAM column

The first-principles problem: every lane is a WHOLE browser (~0.5-1.5 GB),
agents were opening one lane per subtask, and nothing made the cost visible.
This release attacks both ends.

### Added

- **`page_newtab`** (MCP) / **`paat page newtab [--url]`** (CLI) — open an
  additional tab in the lane's EXISTING browser instead of reserving another
  lane. A tab costs ~100-200 MB; an extra lane costs a whole browser. Returns
  the new tab's id/url/title; use that id as the `tab` argument of the other
  page_* tools to drive each tab independently. Works on chrome/edge (CDP,
  via PUT /json/new) and firefox (BiDi, browsingContext.create) with the
  same wait-for-load navigation semantics as page_goto.
- **RAM column on the dashboard** — each session row shows the working-set
  memory of the lane's whole browser tree (parent + renderer processes),
  amber when it crosses 1 GB. Comes from the same per-refresh process sweep
  the dashboard already ran, so it costs nothing extra.
- The MCP `open`/`reserve_lane` sessionId descriptions now steer agents:
  extra sessions are whole browsers — use `page_newtab` when you just need
  more pages.

### Fixed

- **Stale lanes no longer squat debug ports forever.** The allocator treated
  every non-released lane's port as reserved — including stale lanes whose
  browser died long ago — so abandoned lanes eventually consumed the whole
  range and every `open` failed with "No free Chrome debug port" (observed
  live: 74 stale lanes holding all 78 ports while 5 were listening). A stale
  lane's port is now reusable unless something actually listens on it;
  active/reserved lanes keep hard reservations, and an agent returning to a
  reclaimed port gets a safe `unsafe-*` refusal from check_lane rather than
  attaching to a stranger's browser.

## [0.3.11] — Browser column, default browser, more agents

### Added

- **Browser column on the dashboard** (between Project and Current page):
  each live session row shows which backend it runs — Chrome, Edge, or
  Firefox — as plain text matching the rest of the UI. The tooltip states
  the driving protocol (Chrome/Edge over CDP, Firefox over WebDriver BiDi),
  and the expanded row shows backend + protocol alongside the version.
  The inline Firefox/Edge badges next to the agent name are gone; the
  browser is now a first-class column whether it was chosen by the LLM in
  the MCP call or because the user told the agent which browser to use.
- **"Default browser" picker on the dashboard** (and
  `paat config set defaultBrowser chrome|edge|firefox`). Decides which
  browser an agent gets when it calls PortPilot WITHOUT naming one — i.e.
  the user never told the agent which browser to use. Resolution order:
  1. an explicit `browser` in the call always wins,
  2. an existing lane for the same (owner, cwd, session) keeps its browser
     — changing the default never rebinds or duplicates existing lanes,
  3. the configured `defaultBrowser`,
  4. `chrome`.
  Stored in `~/.portpilot/config.json`; a junk value falls back to chrome.
- **goose and opencode recognized as agent owners.** Lanes opened by Block's
  Goose or OpenCode now show under their own name in the dashboard's AGENT
  column instead of the generic "agent". Owner-name matching is now
  word-boundary aware, so short names can't false-match inside unrelated
  words ("mongoose" is not goose, "opencoder" is not opencode).

### Fixed

- **Stopped advertising the dead `http://127.0.0.1:7321/` web dashboard.**
  That URL has been dead since the dashboard became a native app in 0.2.0,
  but MCP tool responses, `paat help`, and the installer still pointed users
  and agents at it (agents forwarded it as a broken link). All three now
  describe the native dashboard app. The legacy `dashboard`
  `--port/--host/--allow-remote/--no-open` flags remain accepted-but-ignored
  so old shortcuts don't break.
- **The published `paat-dashboard.exe` no longer embeds the build machine's
  home path.** The Tauri build now remaps source path prefixes
  (`--remap-path-prefix`), so panic-location metadata in the shipped binary
  reads `/build/home/...` instead of `C:\Users\<builder>\...`.

### Docs

- README brought up to date with everything since 0.3.6: the three browser
  backends table, the `page_*` tool family, `paat open` / `paat page` CLI,
  updated drop-in agent prompt (browser choice, BiDi-vs-CDP guidance,
  current owner list), safety-verdict wording, and storage layout.

---

## [0.3.10] — dashboard: Firefox rows fixed (dedupe + readable note)

### Fixed

- **Firefox lanes no longer appear twice.** On Windows, Firefox runs a
  launcher process that spawns the real browser with an identical command
  line; the dashboard counted both. The launcher is now dropped — one row per
  Firefox, with the pid of the process that actually owns the window/port.
- **The Firefox "CDP error" text no longer wrecks the row layout.** The long
  message overflowed the Current-page column across port/source/action cells.
  It is now truncated, and Firefox lanes show a neutral note — "Firefox lane —
  tab list unavailable (BiDi); drive it with the page_* tools" — instead of a
  red error tint: not being CDP is not an error.
- Snapshot JSON message updated to point at the page_* tools.

## [0.3.9] — drive Firefox like Chrome: page control over BiDi + CDP

Firefox lanes launched fine since 0.3.7, but agents fluent in Chrome CDP had
no way to actually DRIVE Firefox (its port speaks WebDriver BiDi). This
release adds a uniform page-control layer so Firefox is as agent-controllable
as Chrome/Edge — same tools, same semantics, any backend.

### Added

- **`page_*` MCP tools** — one interface for every lane browser, routed to
  WebDriver BiDi (firefox) or CDP (chrome/edge) under the hood:
  - `page_tabs` — list open tabs (id, url, title)
  - `page_goto` — navigate + wait for the load to complete, returns final
    url + title (reliable navigation confirmation)
  - `page_eval` — evaluate a JS expression in the page, get its JSON value
    (DOM/page-state inspection)
  - `page_text` — visible text of the page or a selector (capped 20k chars)
  - `page_click` — click by CSS selector (scrolled into view first)
  - `page_fill` — set a form field with React-safe native setter +
    input/change events
  - `page_screenshot` — PNG to disk (default `~/.portpilot/shots/`)
- **`paat page <tabs|goto|eval|text|click|fill|screenshot>`** — the same
  seven verbs as CLI commands, for shell-based agents.
- Both are built on one in-page JS layer, so Chrome, Edge, and Firefox
  behave IDENTICALLY from the agent's point of view.
- Zero new dependencies — uses Node's built-in WebSocket + fetch (Node ≥ 22).

### Safety

- Page control REFUSES to touch a port unless the lane's attach verdict is
  `safe-attach` — i.e. the process on the port is the lane's own browser
  with the lane's own dedicated profile. PortPilot will never inject
  JavaScript into a browser it didn't launch (in particular, never the
  user's personal browser).
- `page_goto` enforces the same URL scheme allowlist as launch.

### Notes

- Verified live against Firefox 152 (BiDi), Edge 150 and Chrome (CDP).
- Interactions are dispatched in-page (element.click(), native value setter
  + events) — the right tradeoff for form/DOM automation; sites that demand
  trusted OS-level input events may still behave differently.

## [0.3.8] — Microsoft Edge lanes

### Added

- **`--browser edge`** — the third lane backend, alongside `chrome` (default)
  and `firefox`. Because Edge IS Chromium, an Edge lane behaves exactly like a
  Chrome lane where it matters:
  - the debug port serves **real Chrome CDP** (tab enumeration works, agents
    drive it with any CDP client),
  - **all three modes** work: `visible`, `background` (off-screen), `headless`,
  - profile isolation via `--user-data-dir` with a dedicated PortPilot dir
    (`-edge` suffix) — never your personal Edge profile.
- Works everywhere the browser option exists: `paat open --browser edge`,
  `paat reserve --browser edge`, and the MCP `open` / `reserve_lane` /
  `launch_browser_lane` tools (`msedge` accepted as an alias).
- **Binary auto-detection** probes both Edge install dirs on Windows
  (`Program Files` and `Program Files (x86)`), plus macOS and Linux paths.
  Override with `PORTPILOT_EDGE_BIN`.
- **Dashboard "Edge" badge**; live msedge processes are tagged so they match
  their Edge lanes.
- `check_lane` on an Edge lane requires an **Edge** process on the port — a
  Chrome squatting there reports `unsafe-unknown`, not a false attach.
- CLI now rejects an unknown `--browser` value loudly instead of silently
  falling back to Chrome.

### Compatibility

- Chrome and Firefox lanes are untouched; `browser` is still only persisted
  when it isn't `chrome`. Chrome/Edge/Firefox lanes for the same
  (owner, cwd, session) are three distinct lanes with separate profiles.

## [0.3.7] — Firefox lanes (opt-in), alongside Chrome

### Added

- **`--browser firefox` on lanes.** Every lane now has a browser backend —
  `chrome` (default) or `firefox`. Chrome behaviour is unchanged; Firefox is
  purely opt-in, for agents that want to browse or sign in with Firefox.
- **`paat open` — one-step reserve + launch + navigate**, for either browser:
  ```
  paat open --owner codex --cwd <project> --browser firefox --mode visible --url about:blank
  ```
  (`paat reserve` and the MCP \`open\` tool also take \`--browser\` / \`browser\`.)
- **A generic \`launch_browser_lane\` MCP tool** that launches whichever browser
  the lane was reserved for. \`launch_chrome_lane\` is untouched (back-compat).
- **Dashboard shows a "Firefox" badge** on Firefox lanes, with browser type,
  pid, profile dir, cwd, owner, session and task in the row as before.

### Firefox: what it does and does NOT do (no faking)

- **Dedicated profile, never yours.** Firefox launches with
  \`-profile <PortPilot dir>\` + \`-no-remote\`, so it uses an isolated PortPilot
  profile and never joins or mutates your real/default Firefox. The profile dir
  gets a \`-firefox\` suffix so it can never collide with a Chrome lane's profile.
- **Launch + coordinate only.** \`--remote-debugging-port\` on Firefox serves
  **WebDriver BiDi** (\`ws://127.0.0.1:<port>/session\`), **not** Chrome CDP.
  Agents drive it with a BiDi/WebDriver client (e.g. Playwright's firefox).
  PortPilot itself never drives the browser.
- **No tab enumeration.** Because the port is BiDi not CDP, the dashboard
  cannot list a Firefox lane's tabs (it says so on the row instead of guessing).
- **\`visible\` and \`headless\` only.** Firefox has no off-screen window
  positioning, so \`--mode background\` is **refused** for Firefox rather than
  faked. Use \`chrome\` if you need background.
- **\`check_lane\` understands Firefox lanes** — it inspects the \`-profile\` of the
  process on the port and does NOT treat a Firefox lane as a Chrome CDP lane.

### Compatibility

- Existing Chrome lanes are byte-identical: the \`browser\` field is only written
  when it is \`firefox\`, and Chrome profile paths are unchanged (no suffix).

## [0.3.6] — erase a session's saved data from the dashboard

### Added

- **Dashboard "Erase" button + a "saved data" marker.** Each live session
  whose Chrome profile holds a login now shows a small **saved** marker, and a
  new per-row **Erase** button closes that Chrome AND wipes its profile
  (logins, cookies, history), then drops the lane so the row disappears.
  Unlike **Kill** — which closes Chrome but keeps the saved login, so the agent
  reopens still signed in — Erase is a true "forget this session": the next
  open is a fresh, logged-out browser. Two-click confirm (mirrors Kill), since
  it is irreversible.
- **`paat profiles forget --profile-dir <path> [--lane <id>]`** — the CLI
  operation the Erase button calls: a guarded profile delete (only ever inside
  `~/.portpilot/profiles`, never the user's real Chrome) plus lane removal.
  Chrome must already be closed; the dashboard kills the pid first.

### Notes

- The saved-data marker is a cheap check (a couple of `stat` calls for a
  cookie / localStorage / login-data store), not a full profile-size walk, so
  it adds nothing meaningful to the dashboard's 2-second poll.
- Ships a rebuilt `paat-dashboard.exe` (the new `erase_chrome` Tauri command).

---

## [0.3.5] — reclaim disk with `paat profiles` (list + prune)

### Added

- **`paat profiles list`** — inventory every per-lane Chrome profile under
  `~/.portpilot/profiles`: size on disk, the owning lane (owner/project/
  session), its effective status (active / reserved / stale / released /
  orphaned), when it was last used, plus a total and how much is reclaimable
  right now.
- **`paat profiles prune`** — delete abandoned profile folders to reclaim disk.
  **Preview-only by default** (shows what it would remove + the space freed);
  pass `--yes` to actually delete. **Never** touches active or reserved lanes.
  The conservative default targets only orphaned (no lane record) and
  explicitly released profiles; widen with `--stale`, `--all`,
  `--older-than <dur>`, or target specific folders by name/glob. A hard guard
  refuses to operate on anything outside the profiles directory, so it can
  never reach the user's real Chrome profile.

### Notes

- Profiles persist logins across sessions by design (each lane gets its own
  `--user-data-dir`), but were never reclaimed — so they accumulate (one
  machine had 108 profiles / ~50 GB). This adds visibility and safe, opt-in
  cleanup. Deleting a profile gives up its saved logins, which is why the
  default is conservative and prune previews before it deletes.

---

## [0.3.4] — survive transient Windows file locks when writing the registry

### Fixed

- **Registry writes could fail and strand a temp file on Windows.** Every
  registry update writes a sibling temp file and renames it over `lanes.json`.
  On Windows that rename intermittently fails with `EPERM` (or `EACCES` /
  `EBUSY`) when the file is momentarily locked by antivirus, the Search
  indexer, the dashboard, or a second PortPilot process — which both **lost
  the write** and left an orphaned `.lanes.json.<pid>.<ts>.tmp` behind (these
  accumulated; one machine had nine). The rename is now retried through
  transient locks with a short linear backoff (~1.1s over 10 tries), and the
  temp file is **always** cleaned up if the write or rename ultimately fails.
  POSIX behaviour is unchanged.

---

## [0.3.3] — actionable error when the MCP server can't load its deps

### Fixed

- **A missing `node_modules` made the MCP server fail with no explanation.**
  When PortPilot's MCP server is registered to run from a working checkout
  (e.g. `node <repo>/dist/src/cli/index.js mcp`) and that checkout later loses
  its `node_modules` (a clean, a fresh pull, a disk tidy), the server's
  `import` of `@modelcontextprotocol/sdk` threw `ERR_MODULE_NOT_FOUND` at
  startup and the process died before printing anything — the calling agent
  just saw "MCP server disconnected". The `mcp` command now catches that one
  failure mode and prints a single actionable line (which install is missing
  its deps, and the two ways to fix it) before exiting `78` (EX_CONFIG).
  Cross-platform; no behavior change on a healthy install.

---

## [0.3.2] — remove the dead "Show" button on hidden rows

### Fixed

- **"Show" did nothing on a hidden session.** Once a window was hidden
  (parked off-screen at `-32000`), the per-row "Show" button only called
  `SW_RESTORE` + foreground, which re-activates the window without moving it
  back on-screen — so it stayed invisible, and the watcher would re-park it
  regardless. It sat right next to "Unhide" (which *does* bring the window
  back), so users clicked the broken one. Hidden rows now show only **Unhide**
  (and Kill); "Show" remains on visible rows where it works (bring a Chrome to
  the foreground).

---

## [0.3.1] — persistent "Hide" that actually stays hidden

### Fixed

- **Hidden Chrome windows kept popping back onto the desktop.** "Hide" used
  to call `SW_HIDE` once, which the agent's next `Page.bringToFront` (or a
  page navigation) undid immediately, so an actively-working agent's window
  reappeared constantly. Hide now moves the window fully off-screen
  (`-32000, -32000`) instead of toggling its visibility bit. Position, unlike
  show-state, is never changed by activation or z-order calls, so the window
  stays off every monitor no matter how often the agent raises it.
- **Sign-in / OAuth popups and "Restore pages?" bubbles still appeared.**
  Those are independent top-level windows that don't follow the main window
  off-screen. Hide now parks *every* top-level window the Chrome process owns,
  not just the main one.
- **New popups and Chrome restarts no longer flash.** A native background
  watcher thread (Windows) re-parks any on-screen window of a hidden lane
  every ~150 ms — imperceptible, and microseconds of work natively (no
  PowerShell in the loop). The hidden set is keyed by debug-port + profile, so
  a restarted Chrome's new pid is re-hidden automatically.

### Added

- `Unhide` restores a hidden window to its exact original position and
  maximized/normal state. Hide state persists across dashboard restarts.

### Changed

- The dashboard's per-row and per-group Hide buttons toggle to **Unhide** once
  a session is hidden.

---

## [0.3.0] — background Chrome launch mode

### Added

- **`background` Chrome launch mode** for non-intrusive automation. A real
  *headed* Chrome is launched fully off-screen
  (`--window-position=-32000,-32000 --window-size=1280,1000`) so it never
  appears on the visible desktop and never steals focus, while keeping
  cookies, extensions, and anti-bot fingerprint identical to a normal
  browser (unlike `headless`, which many sites block). Ideal for CDP
  read/click automation that needs no human.
- A **`mode` parameter** (`visible` | `background` | `headless`) on both the
  `open` and `launch_chrome_lane` MCP tools, and a `--mode` flag on
  `paat launch-chrome`.
- A **machine-wide default**: set `chromeMode` in `~/.portpilot/config.json`
  or the `PORTPILOT_CHROME_MODE` env var. Precedence is
  **per-call `mode` > `PORTPILOT_CHROME_MODE` > config `chromeMode` >
  `visible`**, so an agent can still force a `visible` window for a login
  step even when the global default is `background`.
- README section documenting the modes, the global default, and the CDP
  client contract for background mode (do not call `Page.bringToFront()` or
  `Browser.setWindowBounds` with on-screen coordinates).

### Changed

- The `open` tool's `headless: boolean` is now **deprecated** in favour of
  `mode: "headless"`. It still works: when `headless` is `true` and `mode`
  is unset, the launch is headless. Pre-existing callers are unaffected.

### Notes

- Hybrid strategy on Windows: Chrome is spawned directly (so the returned
  pid is the real Chrome pid the dashboard + Kill button use), relying on
  the off-screen flags plus the Windows foreground lock — no `start /min`
  shim that would hand back a short-lived launcher pid.
- `visible` mode is byte-for-byte unchanged (regression-guarded by tests).

---

## [0.2.1] — desktop shortcut icon fix

### Fixed

- **Desktop shortcut showed a blank-document icon after a `npm install -g
  github:...#v0.2.0`.** The 0.2.0 installer baked `<package-root>/assets/
  paat.ico` into the .lnk's `IconLocation`, but for github installs the
  package root is `%LOCALAPPDATA%\npm-cache\_cacache\tmp\git-cloneXXXX\`,
  which npm deletes right after install finishes. Windows then couldn't
  find the icon and fell back to the generic document glyph.
- `installShortcut()` now stages `paat.ico` into `%LOCALAPPDATA%\PAAT\`
  next to the dashboard binary, and the .lnk's `IconLocation` points at
  that stable path.
- `installAutostart()` looks up the same staged path so the Start Menu /
  Login Item shortcut also picks up the correct icon.
- The Tauri window itself was always working in 0.2.0 — it just looked
  unresponsive briefly during the first port scan, which Windows surfaces
  as "Not Responding" in the title bar. No code change needed for that;
  the perception will fix itself when the underlying icon stops looking
  broken.

### Notes

No changes to the Tauri binary, no .exe rebuild required for end users.
Re-running `npm install -g github:charlesonogwu/port-authority-agent-terminal#v0.2.1`
re-runs the postinstall, which re-creates the shortcut with the stable
icon path.

---

## [0.2.0] — Tauri dashboard, cross-platform

### Added

- **Native Tauri dashboard**. The dashboard is now a real desktop app
  (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) shipped as
  `paat-dashboard.exe` (Windows) / `paat-dashboard` (macOS, Linux). The
  React UI talks to the lane registry via Tauri's IPC bridge — no HTTP
  server, no localhost port, no remote attack surface.
- **macOS support**. `npm install -g port-authority-agent-terminal-mcp` now
  works on macOS. The CLI + MCP integrations are fully cross-platform. The
  GUI builds from source on first install if Rust is available; Windows
  ships a prebuilt `.exe` and macOS users get a clear "install Rust then
  reinstall" message if the toolchain is missing.
- **Single-instance plugin** (`tauri-plugin-single-instance`): clicking
  the dashboard shortcut twice now focuses the existing window instead of
  spawning a duplicate — handled server-side by Tauri, no PowerShell mutex.
- `scripts/build-dashboard-tauri.cjs`: runs `cargo tauri build` from `gui/`
  and copies the output to `bin/`. Cross-platform; soft-fails when the
  Rust toolchain is missing (committed binary is the source of truth).

### Changed

- `paat dashboard` now spawns the Tauri binary directly via
  `src/dashboard/launch.ts`. The Express HTTP server, port-binding flags
  (`--port`, `--host`, `--allow-remote`), and Chrome `--app=` middleman are
  gone. Legacy flags are accepted-but-ignored with a deprecation warning.
- `paat shortcut install` and `paat autostart install` now point the `.lnk`
  at `paat-dashboard.exe` instead of `paat-launcher.exe`. The old Go
  launcher is gone.
- Build pipeline: `npm run build` now invokes the Tauri build script
  instead of the legacy `dashboard-ui/portpilot-dashboard` Vite project.
- npm package now ships `gui/` source so macOS users can build the binary
  via the postinstall hook.

### Removed

- `src/dashboard/server.ts` (Express server).
- `src/ui/dashboard.ts` (legacy inlined HTML).
- `dashboard-ui/` (legacy Vite project).
- `cmd/paat-launcher/` + `bin/paat-launcher.exe` (legacy Go launcher).
- `scripts/build-launcher.cjs`, `scripts/sync-dashboard-html.mjs`.
- `tests/server-config.test.ts`, `tests/server-cors.test.ts`.

### Security

- The dashboard no longer binds to a local TCP port, eliminating the
  category of attacks where another process on the same machine could
  reach the dashboard's `/api/kill`, `/api/focus`, or `/api/hide`
  endpoints. Window control is now in-process via Tauri IPC.

---

## [0.1.x] — Windows-first, Express + Go launcher

### Added

- This file.

### Changed

- Repo and package renamed to `port-authority-agent-terminal-mcp`. The binary
  now installs as **`paat`** (with `port-authority` and `portpilot` as legacy
  aliases). Windows-first scope is now explicit.
- README now leads with the one-line PowerShell installer and Windows-first
  positioning.

### Security

- _none in this entry yet — see prior 0.1.0 work for the four CRITICAL/HIGH
  fixes already in main._

---

## [0.1.0] — first internal cut

### Added

- CLI: `list`, `status`, `reserve`, `check`, `release`, `next`, `doctor`,
  `launch-chrome`, `prune`, `config`, `dashboard`, `shortcut`, `mcp`.
- MCP server (stdio) exposing `open`, `reserve_lane`, `check_lane`,
  `release_lane`, `launch_chrome_lane`, `find_free_lane`, `list_lanes`,
  `scan_ports`, and `doctor`.
- Cross-process registry under `~/.portpilot/lanes.json` with an exclusive
  lockfile + atomic JSON writes.
- Windows-native scanner via `Get-NetTCPConnection` + `Get-CimInstance
  Win32_Process`, plus best-effort Mac/Linux fallbacks.
- Live dashboard at `http://127.0.0.1:7321/` with grouped session table,
  conflict banner, registry-health collapsible, and per-row Kill button.
- Real React + Tailwind v4 + shadcn/ui dashboard (Vite single-file build,
  inlined into the server at compile time).
- Auto-canonicalization of agent owner names (claude / codex / gemini / …)
  with `sessionId` auto-promotion when callers pass custom suffixes.
- Auto-staling of zombie lanes — both inside `allocateLane` and on every
  dashboard snapshot — so the capacity meter reflects current truth.
- `paat shortcut install` produces a Windows desktop shortcut that opens the
  dashboard in Chrome's `--app=` mode (chromeless window, own taskbar entry).
- One-line PowerShell installer at `scripts/install.ps1`.
- 130+ tests under `node --test`, plus a real-Chrome integration smoke test
  at `scripts/robust-test.ts`.

### Security

- POST `/api/kill` validates pid is a Chromium-family process before
  invoking `taskkill /T /F`.
- MCP tool inputs reject Chrome-flag injection via `url` and refuse
  arbitrary `binaryPath` values that aren't on the Chromium-family allowlist.
- Body size cap (1 MiB) on the kill endpoint.

### Notes

- This is a pre-1.0 cut. APIs (especially MCP tool shapes) may change before
  1.0; subscribe to releases on GitHub for breaking-change notes.

---

[Unreleased]: https://github.com/charlesonogwu/port-authority-agent-terminal/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/charlesonogwu/port-authority-agent-terminal/releases/tag/v0.1.0
