import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { Lane, laneBrowser, nowIso } from "../src/core/lane.js";
import { profileDirFor } from "../src/core/paths.js";
import { PortObservation } from "../src/core/scanner.js";
import {
  assertModeSupported,
  browserLabel,
  evaluateBrowserAttach,
  normalizeBrowserKind,
  supportedModes,
} from "../src/core/browsers.js";
import {
  buildEdgeLaunchPlan,
  evaluateEdgeAttach,
  isEdgeBinaryPath,
  resolveEdgeBinary,
} from "../src/core/edge.js";
import { OFFSCREEN_WINDOW_ARGS, UnsafeChromeArgError } from "../src/core/chrome.js";
import { allocateLane } from "../src/core/allocator.js";

function laneWith(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "lane_edge",
    owner: "codex",
    project: "vend",
    cwd: "/tmp/vend",
    sessionId: "default",
    chromeDebugPort: 9360,
    chromeProfileDir: "C:/pp/profiles/codex-vend-edge",
    browser: "edge",
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
    ...overrides,
  };
}

function obs(port: number, command: string, commandLine: string): PortObservation {
  return { port, source: "native", protocol: "tcp", command, commandLine };
}

// ── browser selection ────────────────────────────────────────────────────────

test("normalizeBrowserKind accepts edge (and the msedge alias)", () => {
  assert.equal(normalizeBrowserKind("edge"), "edge");
  assert.equal(normalizeBrowserKind("Edge"), "edge");
  assert.equal(normalizeBrowserKind("EDGE"), "edge");
  assert.equal(normalizeBrowserKind("msedge"), "edge");
  assert.equal(normalizeBrowserKind("safari"), undefined);
});

test("laneBrowser reads edge lanes; absent/unknown still chrome", () => {
  assert.equal(laneBrowser({ browser: "edge" }), "edge");
  assert.equal(laneBrowser({}), "chrome");
  assert.equal(laneBrowser({ browser: "weird" }), "chrome");
});

test("browserLabel maps all three backends", () => {
  assert.equal(browserLabel("chrome"), "Chrome");
  assert.equal(browserLabel("edge"), "Edge");
  assert.equal(browserLabel("firefox"), "Firefox");
});

// ── modes: edge is Chromium, gets everything including background ────────────

test("supportedModes: edge supports all three modes like chrome", () => {
  assert.deepEqual(supportedModes("edge"), ["visible", "background", "headless"]);
});

test("assertModeSupported: edge background is allowed", () => {
  assert.doesNotThrow(() => assertModeSupported("edge", "background"));
  assert.doesNotThrow(() => assertModeSupported("edge", "visible"));
  assert.doesNotThrow(() => assertModeSupported("edge", "headless"));
});

// ── profile path generation ──────────────────────────────────────────────────

test("profileDirFor: edge gets a -edge suffix, distinct from chrome AND firefox", () => {
  const chrome = profileDirFor("codex", "vend", {});
  const edge = profileDirFor("codex", "vend", { browser: "edge" });
  const firefox = profileDirFor("codex", "vend", { browser: "firefox" });
  assert.match(edge, /codex-vend-edge$/);
  assert.notEqual(edge, chrome);
  assert.notEqual(edge, firefox);
});

test("profileDirFor: session then edge suffix order", () => {
  assert.match(profileDirFor("codex", "vend", { sessionId: "task2", browser: "edge" }), /codex-vend-task2-edge$/);
});

// ── edge launch plan: identical shape to Chrome's, edge binary ───────────────

test("buildEdgeLaunchPlan: edge binary + Chrome-style args (--user-data-dir, CDP port)", () => {
  const lane = laneWith({ chromeDebugPort: 9360, chromeProfileDir: "C:/pp/edge" });
  const plan = buildEdgeLaunchPlan(lane, { mode: "visible", binaryPath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" });
  assert.match(plan.binary.toLowerCase(), /msedge|microsoft.edge/);
  assert.ok(plan.args.includes("--remote-debugging-port=9360"));
  assert.ok(plan.args.includes("--user-data-dir=C:/pp/edge"));
  assert.ok(plan.args.includes("--no-first-run"));
});

test("buildEdgeLaunchPlan: background mode injects the off-screen window args", () => {
  const plan = buildEdgeLaunchPlan(laneWith(), { mode: "background", binaryPath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" });
  for (const a of OFFSCREEN_WINDOW_ARGS) assert.ok(plan.args.includes(a), `missing ${a}`);
});

test("buildEdgeLaunchPlan: headless adds --headless=new", () => {
  assert.ok(buildEdgeLaunchPlan(laneWith(), { mode: "headless", binaryPath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }).args.includes("--headless=new"));
});

test("buildEdgeLaunchPlan: safe initialUrl passes, a flag-as-url is refused", () => {
  const binaryPath = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const ok = buildEdgeLaunchPlan(laneWith(), { initialUrl: "https://example.com", binaryPath });
  assert.equal(ok.args[ok.args.length - 1], "https://example.com");
  assert.throws(
    () => buildEdgeLaunchPlan(laneWith(), { initialUrl: "--load-extension=C:/evil", binaryPath }),
    UnsafeChromeArgError,
  );
});

// ── edge binary gate ─────────────────────────────────────────────────────────

test("isEdgeBinaryPath recognises edge-family binaries only", () => {
  assert.equal(isEdgeBinaryPath("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"), true);
  assert.equal(isEdgeBinaryPath("/usr/bin/microsoft-edge-stable"), true);
  assert.equal(isEdgeBinaryPath("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"), true);
  assert.equal(isEdgeBinaryPath("C:/x/chrome.exe"), false);
  assert.equal(isEdgeBinaryPath("C:/x/firefox.exe"), false);
  assert.equal(isEdgeBinaryPath(undefined), false);
});

test("resolveEdgeBinary refuses a non-edge explicit binary", () => {
  assert.throws(() => resolveEdgeBinary("C:/x/chrome.exe"), UnsafeChromeArgError);
  assert.throws(() => resolveEdgeBinary("C:/x/firefox.exe"), UnsafeChromeArgError);
});

// ── edge attach verdicts ─────────────────────────────────────────────────────

test("evaluateEdgeAttach: free port → safe-free", () => {
  assert.equal(evaluateEdgeAttach(laneWith({ chromeDebugPort: 9360 }), []).kind, "safe-free");
});

test("evaluateEdgeAttach: matching --user-data-dir on an msedge process → safe-attach", () => {
  const lane = laneWith({ chromeDebugPort: 9360, chromeProfileDir: "C:/pp/edge" });
  const v = evaluateEdgeAttach(lane, [obs(9360, "msedge.exe", 'msedge.exe --user-data-dir=C:/pp/edge --remote-debugging-port=9360')]);
  assert.equal(v.kind, "safe-attach");
});

test("evaluateEdgeAttach: edge with a different profile → unsafe-foreign", () => {
  const lane = laneWith({ chromeDebugPort: 9360, chromeProfileDir: "C:/pp/edge" });
  const v = evaluateEdgeAttach(lane, [obs(9360, "msedge.exe", "msedge.exe --user-data-dir=C:/other --remote-debugging-port=9360")]);
  assert.equal(v.kind, "unsafe-foreign-chrome");
});

test("evaluateEdgeAttach: Edge without --user-data-dir is refused", () => {
  const lane = laneWith({ chromeDebugPort: 9360, chromeProfileDir: "C:/pp/edge" });
  const v = evaluateEdgeAttach(lane, [obs(9360, "msedge", "msedge --remote-debugging-port=9360")]);
  assert.equal(v.kind, "unsafe-foreign-chrome");
});

test("evaluateEdgeAttach: Edge without a command line is refused", () => {
  const lane = laneWith({ chromeDebugPort: 9360, chromeProfileDir: "C:/pp/edge" });
  const v = evaluateEdgeAttach(lane, [{ port: 9360, source: "native", protocol: "tcp", command: "msedge" }]);
  assert.equal(v.kind, "unsafe-foreign-chrome");
});

test("evaluateEdgeAttach: a CHROME on an edge lane's port is NOT ours → unsafe-unknown", () => {
  const lane = laneWith({ chromeDebugPort: 9360, chromeProfileDir: "C:/pp/edge" });
  const v = evaluateEdgeAttach(lane, [obs(9360, "chrome.exe", "chrome.exe --user-data-dir=C:/pp/edge --remote-debugging-port=9360")]);
  assert.equal(v.kind, "unsafe-unknown");
});

test("evaluateEdgeAttach: a non-browser process on the port → unsafe-unknown", () => {
  const v = evaluateEdgeAttach(laneWith({ chromeDebugPort: 9360 }), [obs(9360, "node.exe", "node server.js")]);
  assert.equal(v.kind, "unsafe-unknown");
});

test("evaluateBrowserAttach routes an edge lane through the edge evaluator", () => {
  const lane = laneWith({ browser: "edge", chromeDebugPort: 9360, chromeProfileDir: "C:/pp/edge" });
  const v = evaluateBrowserAttach(lane, [obs(9360, "msedge.exe", "msedge.exe --user-data-dir=C:/pp/edge --remote-debugging-port=9360")]);
  assert.equal(v.kind, "safe-attach");
});

// ── allocator: registry metadata + three-way distinctness ────────────────────

test("allocateLane edge: lane records browser=edge + a -edge profile dir", async () => {
  await withTempHome(async () => {
    const r = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "edge", observations: [] });
    assert.equal(r.lane.browser, "edge");
    assert.match(r.lane.chromeProfileDir, /codex-vend-edge$/);
  });
});

test("allocateLane: chrome, edge, and firefox lanes for the same key are all distinct, each idempotent", async () => {
  await withTempHome(async () => {
    const c = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    const e = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "edge", observations: [] });
    const f = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "firefox", observations: [] });
    const ids = new Set([c.lane.id, e.lane.id, f.lane.id]);
    assert.equal(ids.size, 3);
    const profiles = new Set([c.lane.chromeProfileDir, e.lane.chromeProfileDir, f.lane.chromeProfileDir]);
    assert.equal(profiles.size, 3);
    const e2 = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "edge", observations: [] });
    assert.equal(e2.lane.id, e.lane.id);
    // chrome default stays byte-compat: no browser field
    assert.equal(c.lane.browser, undefined);
  });
});
