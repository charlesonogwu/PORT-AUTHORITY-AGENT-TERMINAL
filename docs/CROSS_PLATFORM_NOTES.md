# Cross-Platform Readiness - autonomous-loop checkpoint

**Cron job ID:** `e75bbbf5` (every 10 min, fires at `:03/:13/:23/:33/:43/:53`)
**Started:** 2026-05-05
**Goal:** ship `port-authority-agent-terminal-mcp` to npm + GitHub with first-class
support for **Windows AND macOS**.

This is the SHARED_TASK_NOTES.md for the autonomous loop. Every iteration
starts by reading this file, picks the next un-done item, implements + tests,
commits, then updates this file. When every box is checked, the iteration that
notices calls `CronDelete e75bbbf5` and writes a final "READY TO PUSH" marker.

## Done

- [x] git repo initialized
- [x] this checkpoint file exists

## Foundation (Phase 0) - DONE

- [x] `.gitignore` excludes node_modules, dist, .portpilot, dashboard-ui/dist, etc.
- [x] Initial commit of current working tree (`065f55f`)
- [x] `charlesonogwu` placeholders documented; left as `charlesonogwu` until user provides real GitHub username

## Keystone (Phase 1) - global hotkey / tab handoff - REVERTED

The cross-platform global-hotkey attempt was reverted in `8a6ae9f`.
Rejected package: `node-global-key-listener`.

Security decision: do not ship an npm package that installs unsigned
OS-level keyboard-hook binaries. On Windows, that package installed
`WinKeyServer.exe`, which uses a low-level keyboard hook API and triggered
Microsoft Defender keylogger heuristics.

- [x] Removed the rejected global-key dependency from `package.json` and `package-lock.json`
- [x] Removed `scripts/hotkey-listener.mjs` and `scripts/hotkey-listener.ps1`
- [x] Removed dashboard hotkey/handoff/extension bridge code
- [x] Removed MCP tab-handoff tools
- [x] Added a security regression test so release metadata cannot recommend the rejected package again
- [ ] Redesign tab handoff, if still wanted, around an explicit browser or dashboard action rather than OS-wide keyboard capture

## macOS Desktop Integration (Phase 2)

- [ ] `src/cli/shortcut.ts` - branch on platform: macOS path adds the launcher
      script as a Login Item via `osascript` and creates a `.command` script in
      `~/Applications/` (no .app bundle needed)
- [ ] `src/cli/autostart.ts` - branch on platform: macOS path writes a
      `~/Library/LaunchAgents/com.portauthority.agent-terminal.plist`
      with `RunAtLoad: true` and a path to the launcher
- [ ] Browser extension support was removed with tab handoff; reintroduce it
      only if the design avoids OS-wide keyboard capture

## Installer (Phase 3)

- [ ] `scripts/install.sh` - bash equivalent of install.ps1; checks node >= 20,
      installs the npm package, runs `paat shortcut install` + `paat autostart install`
- [ ] `scripts/postinstall.cjs` - extend `shouldSkip()` to allow macOS;
      currently it bails on non-Windows
- [ ] README - add macOS one-liner using `curl | bash` for `install.sh`

## CI (Phase 4)

- [ ] `.github/workflows/ci.yml` - add macos-latest to the matrix alongside windows-latest
- [ ] Verify tests pass on both platforms; CI must be green before this loop completes

## Polish (Phase 5)

- [ ] `npm publish --dry-run` - must be clean, files whitelist correct, and no rejected keyboard-hook dependency
- [ ] `docs/manual-test.md` - add a macOS verification path
- [ ] CHANGELOG entry for the cross-platform release

## Completion Criteria

When ALL boxes above are checked:

1. `npm test` exits 0 on Windows.
2. `npm publish --dry-run` is clean.
3. If user has set up macOS CI runner, the macos-latest CI run is green.
4. This file ends with a `## READY TO PUSH` section listing the final commit hash.
5. `CronDelete e75bbbf5` is called to stop the loop.

## Iteration Log

### Iteration 1 (DONE)

- [x] Audited current state (10 Windows-only code paths, 7 files with `charlesonogwu`)
- [x] Created git repo, .gitignore, initial commit (`065f55f`)
- [x] Wrote this checkpoint file
- [x] Reverted global hotkey/tab handoff after Defender flagged the rejected keyboard-hook package
- 146/147 tests passing after the revert (1 skipped is the non-Windows refusal path, intentional)
- Next iter target: macOS launchd plist for autostart + macOS shortcut Login Items

### Security cleanup (2026-05-07)

- [x] Confirmed current tracked code has no dependency on the rejected keyboard-hook package
- [x] Confirmed `npm pack --dry-run` does not include node_modules or `WinKeyServer.exe`
- [x] Added regression coverage for publish/readiness metadata
