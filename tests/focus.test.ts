/**
 * Tests for the focus module's input validation and safety checks.
 *
 * The actual Win32 SetForegroundWindow call is impossible to verify in
 * a unit test (it requires a real desktop session and a real Chrome
 * window), so we focus on the validation contract:
 *
 *   - Reject non-Windows platforms cleanly
 *   - Reject malformed PIDs without invoking PowerShell
 *   - Reject PIDs that aren't a Chromium-family process per the live
 *     port scan (the same safety check kill.ts uses)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { focusChromeWindow, hideChromeWindow } from "../src/dashboard/focus.js";

describe("focusChromeWindow — input validation", () => {
  it("rejects non-integer pid", async () => {
    const r = await focusChromeWindow(NaN);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /invalid pid/i);
  });

  it("rejects negative pid", async () => {
    const r = await focusChromeWindow(-5);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /invalid pid/i);
  });

  it("rejects pid 0", async () => {
    const r = await focusChromeWindow(0);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /invalid pid/i);
  });
});

describe("focusChromeWindow — safety check (real port scan)", () => {
  // We can't synthesize a chrome process to focus, but we CAN verify the
  // function rejects PIDs not present in the port scan. Pick a PID that
  // is exceedingly unlikely to be a chrome listening on a port.
  it("rejects a pid that isn't in the port scan", async () => {
    if (process.platform !== "win32") return; // skip on non-Windows
    const r = await focusChromeWindow(99_999_999);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not found in port scan|process exited/i);
  });

  it("returns a clear error on non-Windows platforms", async () => {
    if (process.platform === "win32") return;
    const r = await focusChromeWindow(1);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /windows-only/i);
  });
});

describe("hideChromeWindow — input validation", () => {
  it("rejects non-integer pid", async () => {
    const r = await hideChromeWindow(NaN);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /invalid pid/i);
  });

  it("rejects negative pid", async () => {
    const r = await hideChromeWindow(-5);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /invalid pid/i);
  });

  it("rejects pid 0", async () => {
    const r = await hideChromeWindow(0);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /invalid pid/i);
  });
});

describe("hideChromeWindow — safety check (real port scan)", () => {
  it("rejects a pid that isn't in the port scan", async () => {
    if (process.platform !== "win32") return;
    const r = await hideChromeWindow(99_999_999);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not found in port scan|process exited/i);
  });

  it("returns a clear error on non-Windows platforms", async () => {
    if (process.platform === "win32") return;
    const r = await hideChromeWindow(1);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /windows-only/i);
  });
});
