# Changelog

All notable changes to `port-authority-agent-terminal-mcp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
