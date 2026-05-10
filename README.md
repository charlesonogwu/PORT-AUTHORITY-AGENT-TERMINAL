<p align="center">
  <img src="assets/paat-readme-banner.png" alt="Port Authority Agent Terminal" width="720" />
</p>

# Port Authority Agent Terminal — `paat`

> Windows-first lane coordinator for AI coding agents.
> Stops Claude Desktop, Codex Desktop, and friends from stomping on each other's
> dev servers, Chrome debug ports, and Chrome profiles when they all run on the
> same machine.

`paat` is a small CLI + MCP server + live dashboard you run locally. Each agent
asks `paat` for a **lane** — an app port, a Chrome remote-debugging port, and a
dedicated Chrome user-data-dir — before launching any browser automation. `paat`
then enforces, on every re-check, that the agent only ever attaches to a Chrome
running with **its own** profile, never a sibling agent's.

[![Windows-first](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4?logo=windows)]()
[![CI](https://img.shields.io/github/actions/workflow/status/charlesonogwu/port-authority-agent-terminal/ci.yml?branch=main)](https://github.com/charlesonogwu/port-authority-agent-terminal/actions)
[![npm](https://img.shields.io/npm/v/port-authority-agent-terminal-mcp.svg)](https://www.npmjs.com/package/port-authority-agent-terminal-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## Quick install (Windows)

One PowerShell line. Auto-installs from npm if published, else from this repo.

```powershell
iwr -useb https://raw.githubusercontent.com/charlesonogwu/port-authority-agent-terminal/main/scripts/install.ps1 | iex
```

The installer:

1. Verifies Node.js ≥ 18.17 + npm.
2. Installs the package globally (npm if available, GitHub source as fallback).
3. Auto-detects your machine's RAM and writes a sensible per-machine config.
4. Tells you the next three commands to run.

After install, you have **three CLI aliases** (all the same binary):

```
paat              # the short one you'll actually type
port-authority    # the readable one for scripts
portpilot         # legacy alias
```

> **Platform support.** Windows 10/11 only is officially tested. The code has
> Mac/Linux fallback branches but they are not part of CI. PRs welcome if
> Mac/Linux matters to you.

---

## The problem

You run more than one local AI coding agent. Today you might have:

- **Codex** in `Downloads\vend-site` running `next dev` on port 3000 and a Chrome controlled via CDP on port 9222.
- **Claude** in `Downloads\vendingbids` doing the same — also wanting port 3000 and 9222.
- **A third agent** in `Downloads\research` driving Chrome with Playwright, also picking 9222 because that's what every CDP tutorial uses.

When two agents reuse the same Chrome debug port, the second one **silently attaches to the first one's browser session**. It tests the wrong app, inherits stale cookies, overwrites work. You usually only notice when an agent confidently reports "the homepage looks great" — about a different repo.

Worse, two agents reusing the same `--user-data-dir` will **corrupt each other's profile**: Chrome's SingletonLock breaks, sessions invalidate, extensions reset.

`paat` reserves a separate **lane** per (agent, project) pair so that never happens.

## What a lane is

| Field             | What it is                                                            |
|-------------------|-----------------------------------------------------------------------|
| `owner`           | Agent identifier — `claude`, `codex`, `gemini`, `cursor`, `copilot`, … |
| `project`         | Slug derived from the project working directory                       |
| `cwd`             | Absolute project working directory                                    |
| `task`            | Free-form description                                                  |
| `appPort`         | A free port in the app range (default `3000-3099`)                    |
| `chromeDebugPort` | A free port in the Chrome debug range (default `9322-9399`)           |
| `chromeProfileDir`| Dedicated `--user-data-dir`, e.g. `~/.portpilot/profiles/claude-vend-site` |
| `sessionId`       | Optional parallel-session id when one agent runs many Chromes in the same project |
| `status`          | `reserved` → `active` → `stale` → `released`                          |

Lanes live in `C:\Users\<you>\.portpilot\lanes.json`, guarded by a lockfile so two agents writing concurrently can't corrupt the registry.

## CLI

| Command | Purpose |
|---|---|
| `paat list`                               | List every lane |
| `paat status`                             | List + live port observations + warnings |
| `paat reserve --owner <n> --cwd <p> --task <s>`   | Reserve a lane (idempotent for owner+cwd+session) |
| `paat check --owner <n> --cwd <p>`        | Verify the lane is safe to use right now |
| `paat release --owner <n> --cwd <p>`      | Release a lane (does NOT kill Chrome) |
| `paat next [--range 9322-9399]`           | Print the next free port in a range |
| `paat doctor`                             | Audit registry vs. live ports |
| `paat launch-chrome --owner <n> --cwd <p>` | Launch Chrome bound to the lane's debug port + profile |
| `paat prune [--all] [--older-than 24h]`   | Garbage-collect released lanes |
| `paat config show`                        | Show per-machine config |
| `paat config init`                        | Recompute & write defaults from your RAM |
| `paat dashboard`                          | Open the live dashboard at http://127.0.0.1:7321/ |
| `paat shortcut install`                   | Put a clickable dashboard launcher on your Desktop |
| `paat mcp`                                | Run as an MCP stdio server |

Add `--json` to any command for machine-readable output.

## Wire it into Claude Desktop / Codex Desktop

Both desktops accept MCP servers. Add this block to their config:

**Claude Desktop** — `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "paat": {
      "command": "paat",
      "args": ["mcp"]
    }
  }
}
```

**Codex Desktop** — `~\.codex\config.toml`:

```toml
[mcp_servers.paat]
command = "paat"
args = ["mcp"]
```

Restart the desktop app and the agent now has these tools available:

- `open` — reserve + launch Chrome + navigate, in one call (recommended)
- `reserve_lane` / `check_lane` / `release_lane` / `launch_chrome_lane`
- `list_lanes` / `find_free_lane` / `scan_ports` / `doctor`

A natural-language prompt that just works once both desktops are wired:

> *Open https://example.com via paat in this folder.*

The agent picks up that "via paat" → calls `open` → the session shows up on
the live dashboard within 2 seconds.

## Safety contract

| Verdict from `check_lane` | Meaning |
|---|---|
| `safe-free`              | Debug port is free. You may launch Chrome with this lane's profile. |
| `safe-attach`            | Debug port is held by Chrome **with the matching `--user-data-dir`**. You may attach. |
| `unsafe-foreign-chrome`  | Debug port is held by Chrome with a *different* profile. **Do not attach.** |
| `unsafe-unknown`         | Debug port is held by a non-Chrome process. **Do not attach.** |

`unsafe-*` verdicts cause `paat check` to exit code 3 and `launch-chrome` /
`open` to refuse. **`paat` will never kill a process on its own.** The
dashboard's manual Kill button is the only path to termination, and it
refuses to kill anything that isn't a Chromium-family process.

## Live dashboard

`paat dashboard` opens a real-time view at [http://127.0.0.1:7321/](http://127.0.0.1:7321/). It shows:

- One row per **live Chrome process** with `--remote-debugging-port`
- Grouped by project folder
- Current tabs (title + URL) for each session, polled via CDP every 2s
- Conflict banner when two registries disagree about a port
- A "Kill" button per row (click-to-confirm, refuses non-Chrome pids)

The dashboard auto-installs as a **Chrome app-mode window** when you run
`paat shortcut install` — its own taskbar entry, its own icon, separate
from your regular browser.

## Examples

A multi-agent scenario the project is designed to handle:

```text
Codex working in:
  C:\Users\<you>\Downloads\vend-site
  → app port 3000, Chrome debug 9322,
    profile  C:\Users\<you>\.portpilot\profiles\codex-vend-site

Claude working in:
  C:\Users\<you>\Downloads\vendingbids
  → app port 3001, Chrome debug 9323,
    profile  C:\Users\<you>\.portpilot\profiles\claude-vendingbids

Cursor working in:
  C:\Users\<you>\Downloads\research
  → no app server, Chrome debug 9324,
    profile  C:\Users\<you>\.portpilot\profiles\cursor-research
```

Each agent calls `paat check` before every Chrome step. If Codex's terminal
accidentally launches Chrome on 9323 (Claude's lane), `paat check` for Codex
returns `unsafe-foreign-chrome` and the agent backs off instead of clobbering
Claude's session.

## Storage layout

```
~/.portpilot/
├── config.json             # per-machine cap, port ranges
├── lanes.json              # registry — single source of intent
├── lanes.json.lock         # exclusive lock for read-modify-write
└── profiles/
    ├── codex-vend-site/
    ├── claude-vendingbids/
    └── cursor-research/
```

Override the location with `PORTPILOT_HOME=<path>`.

## Building from source

```powershell
git clone https://github.com/charlesonogwu/port-authority-agent-terminal.git
cd port-authority-agent-terminal
npm install
npm --prefix dashboard-ui/portpilot-dashboard install
npm run build
npm link        # exposes paat / port-authority / portpilot on PATH
```

`npm test` runs the full suite — currently 130+ tests covering allocator,
registry, lockfile, Chrome safety verdicts, prune semantics, security
validators, and end-to-end CLI integration.

## Architecture

```
src/
  core/                  pure logic, no Node-only assumptions beyond fs/spawn
    lane.ts              types, slugs, canonicalize, staleness
    paths.ts             ~/.portpilot/* path resolution (PORTPILOT_HOME-aware)
    lockfile.ts          cross-platform exclusive lock + atomic JSON write
    registry.ts          lanes.json read-modify-write under the lock + pruning
    scanner.ts           sonar + Windows native + Unix fallbacks
    chrome.ts            launch planning + safety verdicts + URL/binary validators
    allocator.ts         port + profile selection (live observations + reserved)
    config.ts            per-machine config (cap, ranges)
  cli/                   argument parsing + command dispatch (no deps)
  dashboard/             HTTP server + snapshot builder + kill endpoint
  mcp/                   McpServer wrapper exposing the same core lib
  ui/dashboard.ts        AUTO-GENERATED inlined React+shadcn dashboard
dashboard-ui/             source for the React+Vite dashboard
scripts/                 install.ps1, build helpers, robust-test, chrome.ts
tests/                   node:test suites
```

## Contributing

Bug reports, ideas, and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
