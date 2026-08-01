# Windows Stability Hardening Implementation Plan

1. Establish the current test/build baseline in the clean worktree.
2. Add native dashboard regression coverage for stale/reused targets and snapshot command failures.
3. Implement shared target verification and fail-closed dashboard actions.
4. Add browser discovery, spawn-handshake, concurrent-launch, and actual-PID regression tests.
5. Implement transactional browser launch and per-lane launch serialization.
6. Add and implement Windows cwd canonicalization, strict port validation, lock retry/backoff, and dynamic test ports.
7. Add build-script and packaging regressions, then repair npm bootstrap and prepack behavior.
8. Add a compatible Tauri CSP and update vulnerable dependencies conservatively.
9. Run complete verification, repeat the Windows disposable-profile stress scenarios, and document any remaining toolchain limitation.
