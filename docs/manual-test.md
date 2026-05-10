# Manual cross-agent test

Goal: prove portpilot prevents Codex desktop and Claude desktop from colliding
when they both want Chrome on the same machine. You will run real agents in
two different project folders and watch portpilot keep them in separate lanes.

## Pre-flight

```powershell
# 1. portpilot binary on PATH
portpilot help                                # should print usage

# 2. portpilot MCP wired into both desktop apps
#    Claude Desktop: %APPDATA%\Claude\claude_desktop_config.json
#    Codex Desktop:  ~\.codex\config.toml
#    (already done by your assistant)
```

Have two agent windows ready:

- **Window A** — Claude Desktop, opened in some Project A
- **Window B** — Codex Desktop, opened in some Project B

Project A and Project B can be any two folders you have, e.g.
`C:\Users\<you>\Downloads\vend-site` and
`C:\Users\<you>\Downloads\vendingbids`.

## Step 1 — each agent reserves its own lane

In **Window A (Claude)**, ask the agent:

> Use the portpilot MCP to reserve a lane for owner=claude in the current
> directory, with task="manual cross-agent test". Then call check_lane.

Expected: `reserve_lane` returns a lane with some `chromeDebugPort` (e.g.
9322) and `chromeProfileDir` ending in `claude-<projectA>`. `check_lane`
returns verdict `safe-free`.

In **Window B (Codex)**, ask the agent:

> Use the portpilot MCP to reserve a lane for owner=codex in the current
> directory, with task="manual cross-agent test". Then call check_lane.

Expected: a *different* `chromeDebugPort` (e.g. 9323), a *different*
`chromeProfileDir` ending in `codex-<projectB>`, verdict `safe-free`.

Sanity-check from any third Git Bash terminal:

```bash
portpilot list
```

You should see both lanes listed with non-overlapping ports.

## Step 2 — each agent launches Chrome in its own lane

In **Window A (Claude)**:

> Run `tsx scripts/chrome.ts launch --owner claude --cwd "$(pwd)" --headless`
> using the Bash tool, then `tsx scripts/chrome.ts status --owner claude --cwd "$(pwd)"`.

(Adjust the path to `scripts/chrome.ts` if you copied it into Project A.
You can also call the CLI form directly:
`portpilot launch-chrome --owner claude --cwd "$(pwd)"`.)

Expected: `launched: Chrome/<version> (pid=...) on :9322`. Status reports
verdict `safe-attach`.

In **Window B (Codex)**, do the same with `--owner codex`. Different pid,
different port, both Chrome instances running side-by-side.

## Step 3 — the collision attempt (the real test)

This is what the safety contract is for. We deliberately make Codex try to
attach to **Claude's** lane.

In **Window B (Codex)**, ask the agent:

> Call `portpilot.check_lane` with owner=codex but cwd set to Claude's
> project directory, e.g. `C:\Users\<you>\Downloads\vend-site`.

If a lane exists for owner=codex/cwd=ProjectA: portpilot returns the codex
lane (which points at codex's port, NOT claude's). To force the dangerous
case, modify `~/.portpilot/lanes.json` by hand and change the codex lane's
`chromeDebugPort` to claude's port (9322 in the example). Then re-run
`check_lane`:

Expected: `verdict: "unsafe-foreign-chrome"`, with `foundProfile` showing
claude's profile path. The agent should refuse to attach.

Restore the registry:

```bash
portpilot release --owner codex --cwd "<projectB>" --remove
portpilot reserve --owner codex --cwd "<projectB>"
```

## Step 4 — clean up

```bash
# Close tabs and release, do NOT kill Chrome:
portpilot release --owner claude --cwd "<projectA>"
portpilot release --owner codex  --cwd "<projectB>"
# Then close the Chrome windows yourself.
```

## What success looks like

- Two Chrome processes running simultaneously, never sharing a profile.
- Each agent only ever attaches to **its own** debug port.
- Any cross-agent attempt is rejected with `unsafe-foreign-chrome` and a
  clear `foundProfile` field telling you whose Chrome is on the port.
- `portpilot doctor` always reports `ok: true` while both agents are
  behaving, and surfaces a CRITICAL the moment a port is held by the wrong
  process.

## What if portpilot is wrong?

The MCP tool returns full structured data. If you ever see a verdict you
disagree with, run:

```bash
portpilot status --json | jq '.observations[] | select(.port == <port>)'
```

That dumps the raw scanner observation portpilot is reasoning from. The
mismatch will be in the `commandLine` field — either Chrome ran without
`--user-data-dir`, or with one that doesn't equal the lane's profile.

## Automated proof

The same four verdicts are exercised end-to-end (real Chrome, real PIDs,
real CDP, real cleanup) by:

```bash
npm run robust-test
```

That's the regression check. It runs in a temp `PORTPILOT_HOME` so it
never touches your real registry.
