// Read-path commands (Phase 4): parse ~/.portpilot/*.json directly.
// Write-path commands (Phase 6): real impl shells out to the `paat` CLI.
// Some write paths (kill, focus, hide) are stubbed in Phase 5 so the
// invoke() bridge in gui/src/api/client.ts compiles.

pub mod action_safety;
pub mod config;
pub mod doctor;
pub mod erase;
pub mod focus;
pub mod kill;
pub mod lanes;
pub mod snapshot;
