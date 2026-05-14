# Changelog

All notable changes to `port-authority-agent-terminal-mcp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
