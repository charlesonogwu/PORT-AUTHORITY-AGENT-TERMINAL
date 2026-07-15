import assert from "node:assert/strict";
import { test } from "node:test";
import { macOsChromeCandidates } from "../src/core/chrome.js";
import { macOsEdgeCandidates } from "../src/core/edge.js";
import { macOsFirefoxCandidates } from "../src/core/firefox.js";

test("macOS Chrome discovery covers system and per-user Applications variants", () => {
  const candidates = macOsChromeCandidates("/Users/alice");
  assert.ok(candidates.includes("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
  assert.ok(candidates.includes("/Users/alice/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"));
  assert.ok(candidates.includes("/Applications/Chromium.app/Contents/MacOS/Chromium"));
});

test("macOS Edge discovery never falls back to Chrome", () => {
  const candidates = macOsEdgeCandidates("/Users/alice");
  assert.ok(candidates.includes("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"));
  assert.ok(candidates.includes("/Users/alice/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary"));
  assert.equal(candidates.some((candidate) => candidate.includes("Google Chrome")), false);
});

test("macOS Firefox discovery covers Developer Edition and Nightly", () => {
  const candidates = macOsFirefoxCandidates("/Users/alice");
  assert.ok(candidates.includes("/Applications/Firefox.app/Contents/MacOS/firefox"));
  assert.ok(candidates.includes("/Users/alice/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"));
  assert.ok(candidates.includes("/Applications/Firefox Nightly.app/Contents/MacOS/firefox"));
});
