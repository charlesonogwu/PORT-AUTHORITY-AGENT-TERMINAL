import assert from "node:assert/strict";
import test from "node:test";
import { isAuthoritativeLsofResult, scanNative } from "../src/core/scanner.js";

test("lsof no-match is authoritative but a killed/timed-out command is not", () => {
  assert.equal(isAuthoritativeLsofResult({ stdout: "", stderr: "", code: 1 }), true);
  assert.equal(isAuthoritativeLsofResult({ stdout: "", stderr: "", code: null }), false);
});

test("an aborted native scan fails closed instead of reporting an authoritative empty port set", async () => {
  const reason = new Error("scanner deadline expired");
  await assert.rejects(
    scanNative({ signal: AbortSignal.abort(reason) }),
    /scanner deadline expired/,
  );
});
