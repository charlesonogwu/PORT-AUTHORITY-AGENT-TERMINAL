# Windows Stability Hardening Design

## Goal

Fix every reproducible Windows defect found in the July 2026 PortPilot stress audit without changing lane semantics, weakening profile isolation, or touching users' normal browser profiles.

## Safety boundaries

- Dashboard actions must fail closed unless the current process still matches the selected PortPilot lane's browser, PID, debugging port, and isolated profile.
- Browser launch success must mean the executable started and the expected browser became verifiable; a relay or failed child PID is not sufficient.
- Tests that launch browsers must use disposable `PORTPILOT_HOME` roots and disposable profile directories.
- Existing Chrome, Edge, Firefox, CDP, BiDi, lane persistence, and stale-lane behavior remain compatible.
- The user's existing dirty checkout remains untouched; implementation happens in an isolated worktree.

## Architecture

### 1. Native dashboard action safety

Add a shared verification path that refreshes the selected lane immediately before Show, Hide, Unhide, Kill, or Erase. The verified target must include lane identity, browser, PID, port, and profile. Rust retains native window operations, but it must not trust a naked PID supplied by the webview. Hidden-window tracking stores verified targets rather than arbitrary PIDs and drops targets that no longer verify.

Snapshot failures become explicit errors. The frontend retains the last valid snapshot and displays a warning instead of replacing live sessions with an empty dashboard.

### 2. Browser launch correctness

Browser discovery checks executable existence for explicit paths, environment overrides, and platform candidates. Launching waits for either the child `spawn` event or an actionable error. A per-lane launch lock serializes check-launch-ready transitions. Registry PID metadata is updated from the browser process verified on the debugging port, not blindly from the initial child returned by `spawn`.

### 3. Identity, configuration, and registry hardening

Windows lane identity uses a resolved, separator-normalized, case-insensitive cwd key while preserving a human-readable cwd value. Port ranges are validated centrally as integers from 1 through 65535 with ordered bounds. Registry lock acquisition receives bounded retry/backoff under heavy cross-process contention. Robustness tests allocate free ports dynamically.

### 4. Build, packaging, and dependency hygiene

The dashboard bootstrap invokes npm in a Windows-safe way without relying on `spawnSync("npm.cmd", shell:false)`. Packaging never deletes the developer's root `node_modules`; package-content checks prove dependencies are excluded from the tarball. Tauri receives a restrictive production CSP compatible with the bundled dashboard. Compatible patched dependency versions replace known vulnerable lockfile entries without forced major-version upgrades.

## Verification

- Regression tests are written before each implementation.
- Run the complete Node test suite and TypeScript lint.
- Run Rust tests, formatting, Clippy, and the strict Tauri build where installed tooling permits.
- Run `npm pack --dry-run` while proving `node_modules` survives.
- Run production dependency audit and report any remaining transitive advisory with reachability context.
- Repeat disposable-profile Windows stress tests for browser launch, concurrent open, snapshots, and registry allocation.

## Delivery

The completed branch is left local for user testing. It is not merged, published, globally installed, or released until the user separately approves shipping.
