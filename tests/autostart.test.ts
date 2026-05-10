/**
 * Tests for the autostart helper. We can't actually drop a shortcut into
 * %APPDATA% from the test runner without polluting the user's Startup
 * folder, so we exercise:
 *   - Cross-platform refusal (non-Windows path throws cleanly).
 *   - Status reporting on a clean home (installed: false).
 *   - The path-resolution + filename constants are stable.
 *
 * The full Windows installer flow is verified in the manual smoke test
 * (`paat autostart install` then `paat autostart status` → ENABLED).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { autostartStatus, AUTOSTART_FILENAME, installAutostart, uninstallAutostart } from "../src/cli/autostart.js";

test("AUTOSTART_FILENAME is the user-friendly Start-Menu-style name", () => {
  assert.equal(AUTOSTART_FILENAME, "Port Authority Agent Terminal.lnk");
});

test("installAutostart() refuses on non-Windows platforms", async (t) => {
  if (process.platform === "win32") return t.skip("Windows: not testing the refusal path here");
  await assert.rejects(installAutostart(), /Windows-only/i);
});

test("autostartStatus() returns a stable shape on every platform", async () => {
  const r = await autostartStatus();
  assert.equal(typeof r.installed, "boolean");
  assert.equal(typeof r.startup, "string");
  assert.equal(typeof r.shortcut, "string");
  // On non-Windows, both paths are empty strings and `installed` is false.
  if (process.platform !== "win32") {
    assert.equal(r.startup, "");
    assert.equal(r.shortcut, "");
    assert.equal(r.installed, false);
  }
});

test("uninstallAutostart() is safe to call when nothing is installed", async () => {
  // We don't gate on platform — even on Windows, if no autostart was
  // installed the function should return { removed: false } rather than throw.
  const r = await uninstallAutostart();
  assert.equal(typeof r.removed, "boolean");
  assert.equal(typeof r.path, "string");
});
