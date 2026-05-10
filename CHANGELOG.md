# Changelog

All notable changes to `port-authority-agent-terminal-mcp` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
