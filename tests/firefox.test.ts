import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { Lane, laneBrowser, nowIso } from "../src/core/lane.js";
import { profileDirFor } from "../src/core/paths.js";
import { PortObservation } from "../src/core/scanner.js";
import {
  assertModeSupported,
  evaluateBrowserAttach,
  normalizeBrowserKind,
  supportedModes,
} from "../src/core/browsers.js";
import {
  UnsupportedFirefoxModeError,
  buildFirefoxLaunchPlan,
  evaluateFirefoxAttach,
  extractFirefoxProfileDir,
  isFirefoxBinaryPath,
  resolveFirefoxBinary,
} from "../src/core/firefox.js";
import { UnsafeChromeArgError } from "../src/core/chrome.js";
import { allocateLane } from "../src/core/allocator.js";
import { findAllAgentFirefoxes, findLiveFirefoxes } from "../src/dashboard/sources.js";

function laneWith(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "lane_ff",
    owner: "codex",
    project: "vend",
    cwd: "/tmp/vend",
    sessionId: "default",
    chromeDebugPort: 9350,
    chromeProfileDir: "C:/pp/profiles/codex-vend-firefox",
    browser: "firefox",
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

test("normalizeBrowserKind accepts chrome/firefox case-insensitively, rejects junk", () => {
  assert.equal(normalizeBrowserKind("firefox"), "firefox");
  assert.equal(normalizeBrowserKind("Firefox"), "firefox");
  assert.equal(normalizeBrowserKind("CHROME"), "chrome");
  assert.equal(normalizeBrowserKind("safari"), undefined);
  assert.equal(normalizeBrowserKind(""), undefined);
  assert.equal(normalizeBrowserKind(undefined), undefined);
  assert.equal(normalizeBrowserKind(5), undefined);
});

test("laneBrowser treats absent/unknown as chrome", () => {
  assert.equal(laneBrowser({}), "chrome");
  assert.equal(laneBrowser({ browser: "chrome" }), "chrome");
  assert.equal(laneBrowser({ browser: "firefox" }), "firefox");
  assert.equal(laneBrowser({ browser: "weird" }), "chrome");
});

// ── modes ────────────────────────────────────────────────────────────────────

test("supportedModes: chrome has background, firefox does not", () => {
  assert.deepEqual(supportedModes("chrome"), ["visible", "background", "headless"]);
  assert.deepEqual(supportedModes("firefox"), ["visible", "headless"]);
});

test("assertModeSupported: firefox background throws; visible/headless ok; chrome background ok", () => {
  assert.doesNotThrow(() => assertModeSupported("firefox", "visible"));
  assert.doesNotThrow(() => assertModeSupported("firefox", "headless"));
  assert.throws(() => assertModeSupported("firefox", "background"), UnsupportedFirefoxModeError);
  assert.doesNotThrow(() => assertModeSupported("chrome", "background"));
});

// ── profile path generation ──────────────────────────────────────────────────

test("profileDirFor: chrome paths are byte-identical to pre-firefox (no suffix)", () => {
  const noBrowser = profileDirFor("codex", "vend", { sessionId: "default" });
  const chrome = profileDirFor("codex", "vend", { sessionId: "default", browser: "chrome" });
  assert.equal(chrome, noBrowser);
  assert.match(chrome, /codex-vend$/);
});

test("profileDirFor: firefox gets a -firefox suffix so it can't collide with chrome", () => {
  const chrome = profileDirFor("codex", "vend", { browser: "chrome" });
  const firefox = profileDirFor("codex", "vend", { browser: "firefox" });
  assert.notEqual(chrome, firefox);
  assert.match(firefox, /codex-vend-firefox$/);
});

test("profileDirFor: session then firefox suffix order", () => {
  assert.match(profileDirFor("codex", "vend", { sessionId: "task2", browser: "firefox" }), /codex-vend-task2-firefox$/);
});

// ── firefox launch plan ──────────────────────────────────────────────────────

test("buildFirefoxLaunchPlan: -profile, -no-remote, BiDi port; NEVER --user-data-dir", () => {
  const lane = laneWith({ chromeDebugPort: 9350, chromeProfileDir: "C:/pp/ff" });
  const plan = buildFirefoxLaunchPlan(lane, { mode: "visible" });
  assert.match(plan.binary.toLowerCase(), /firefox/);
  const i = plan.args.indexOf("-profile");
  assert.ok(i >= 0 && plan.args[i + 1] === "C:/pp/ff", "must pass -profile <laneProfileDir>");
  assert.ok(plan.args.includes("-no-remote"), "must pass -no-remote so it never joins the user's Firefox");
  const p = plan.args.indexOf("--remote-debugging-port");
  assert.ok(p >= 0 && plan.args[p + 1] === "9350");
  assert.ok(!plan.args.some((a) => a.includes("--user-data-dir")), "Firefox must not get Chrome's --user-data-dir");
  assert.ok(!plan.args.includes("-headless"));
});

test("buildFirefoxLaunchPlan: headless adds -headless", () => {
  assert.ok(buildFirefoxLaunchPlan(laneWith(), { mode: "headless" }).args.includes("-headless"));
});

test("buildFirefoxLaunchPlan: background mode is refused (no faking)", () => {
  assert.throws(() => buildFirefoxLaunchPlan(laneWith(), { mode: "background" }), UnsupportedFirefoxModeError);
});

test("buildFirefoxLaunchPlan: safe initialUrl passes, a flag-as-url is refused", () => {
  const ok = buildFirefoxLaunchPlan(laneWith(), { initialUrl: "https://example.com" });
  assert.equal(ok.args[ok.args.length - 1], "https://example.com");
  assert.throws(() => buildFirefoxLaunchPlan(laneWith(), { initialUrl: "-headless" }), UnsafeChromeArgError);
});

test("buildFirefoxLaunchPlan: throws when the lane has no debug port", () => {
  assert.throws(() => buildFirefoxLaunchPlan(laneWith({ chromeDebugPort: undefined }), {}));
});

// ── firefox binary gate ──────────────────────────────────────────────────────

test("isFirefoxBinaryPath recognises firefox-family binaries only", () => {
  assert.equal(isFirefoxBinaryPath("C:/Program Files/Mozilla Firefox/firefox.exe"), true);
  assert.equal(isFirefoxBinaryPath("/usr/bin/firefox-esr"), true);
  assert.equal(isFirefoxBinaryPath("librewolf"), true);
  assert.equal(isFirefoxBinaryPath("C:/x/chrome.exe"), false);
  assert.equal(isFirefoxBinaryPath(undefined), false);
});

test("resolveFirefoxBinary refuses a non-firefox explicit binary", () => {
  assert.throws(() => resolveFirefoxBinary("C:/x/chrome.exe"), UnsafeChromeArgError);
});

// ── firefox attach verdicts ──────────────────────────────────────────────────

test("evaluateFirefoxAttach: free port → safe-free", () => {
  assert.equal(evaluateFirefoxAttach(laneWith({ chromeDebugPort: 9350 }), []).kind, "safe-free");
});

test("evaluateFirefoxAttach: matching -profile → safe-attach", () => {
  const lane = laneWith({ chromeDebugPort: 9350, chromeProfileDir: "C:/pp/ff" });
  const v = evaluateFirefoxAttach(lane, [obs(9350, "firefox.exe", 'firefox.exe -profile "C:/pp/ff" -no-remote --remote-debugging-port 9350')]);
  assert.equal(v.kind, "safe-attach");
});

test("evaluateFirefoxAttach: different -profile → unsafe-foreign", () => {
  const lane = laneWith({ chromeDebugPort: 9350, chromeProfileDir: "C:/pp/ff" });
  const v = evaluateFirefoxAttach(lane, [obs(9350, "firefox.exe", 'firefox.exe -profile "C:/other" --remote-debugging-port 9350')]);
  assert.equal(v.kind, "unsafe-foreign-chrome");
});

test("evaluateFirefoxAttach: Firefox without -profile is refused", () => {
  const v = evaluateFirefoxAttach(laneWith({ chromeDebugPort: 9350 }), [
    obs(9350, "firefox", "firefox --remote-debugging-port 9350"),
  ]);
  assert.equal(v.kind, "unsafe-foreign-chrome");
});

test("evaluateFirefoxAttach: Firefox without a command line is refused", () => {
  const v = evaluateFirefoxAttach(laneWith({ chromeDebugPort: 9350 }), [{
    port: 9350,
    source: "native",
    protocol: "tcp",
    command: "firefox",
  }]);
  assert.equal(v.kind, "unsafe-foreign-chrome");
});

test("evaluateFirefoxAttach: a non-firefox process on the port → unsafe-unknown", () => {
  const v = evaluateFirefoxAttach(laneWith({ chromeDebugPort: 9350 }), [obs(9350, "node.exe", "node server.js")]);
  assert.equal(v.kind, "unsafe-unknown");
});

test("evaluateBrowserAttach routes a firefox lane through the firefox evaluator (chrome on its port ≠ attach)", () => {
  const lane = laneWith({ browser: "firefox", chromeDebugPort: 9350, chromeProfileDir: "C:/pp/ff" });
  const v = evaluateBrowserAttach(lane, [obs(9350, "chrome.exe", "chrome.exe --user-data-dir=C:/pp/ff --remote-debugging-port=9350")]);
  assert.equal(v.kind, "unsafe-unknown"); // chrome is not a firefox process; must NOT be read as a match
});

// ── extractFirefoxProfileDir ─────────────────────────────────────────────────

test("extractFirefoxProfileDir handles quoted + single-dash + double-dash", () => {
  assert.equal(extractFirefoxProfileDir('firefox -profile "C:/a b/ff" -no-remote'), "C:/a b/ff");
  assert.equal(extractFirefoxProfileDir("firefox --profile /home/x/ff"), "/home/x/ff");
  assert.equal(extractFirefoxProfileDir("firefox -no-remote"), undefined);
});

// ── macOS/native scanner dashboard discovery ────────────────────────────────

test("findLiveFirefoxes accepts only an isolated no-remote Firefox listener", () => {
  const found = findLiveFirefoxes([{
    port: 9350,
    pid: 42,
    source: "native",
    protocol: "tcp",
    command: "firefox",
    commandLine: 'firefox -profile "/tmp/portpilot/profiles/ff" -no-remote --remote-debugging-port 9350',
  }]);
  assert.deepEqual(found, [{
    port: 9350,
    pid: 42,
    source: undefined,
    debugMode: "port",
    command: "firefox",
    commandLine: 'firefox -profile "/tmp/portpilot/profiles/ff" -no-remote --remote-debugging-port 9350',
    profileDir: "/tmp/portpilot/profiles/ff",
    browser: "firefox",
  }].map(({ source: _source, ...rest }) => rest));
});

test("findLiveFirefoxes refuses missing profile, no-remote, command line, and content children", () => {
  const base = { port: 9350, source: "native" as const, protocol: "tcp" as const, command: "firefox" };
  assert.deepEqual(findLiveFirefoxes([
    { ...base, pid: 1, commandLine: "firefox -no-remote --remote-debugging-port 9350" },
    { ...base, pid: 2, commandLine: "firefox -profile /tmp/ff --remote-debugging-port 9350" },
    { ...base, pid: 3 },
    { ...base, pid: 4, commandLine: "firefox -contentproc -profile /tmp/ff -no-remote --remote-debugging-port 9350" },
  ]), []);
});

test("findAllAgentFirefoxes requires profile plus no-remote and ignores content processes", () => {
  const process = (pid: number, commandLine: string) => ({
    pid,
    ppid: 1,
    name: "firefox",
    commandLine,
  });
  const found = findAllAgentFirefoxes({
    processes: new Map([
      [10, process(10, "firefox -profile /tmp/portpilot/ff -no-remote --remote-debugging-port 9350")],
      [11, process(11, "firefox -profile /tmp/foreign --remote-debugging-port 9351")],
      [12, process(12, "firefox -no-remote --remote-debugging-port 9352")],
      [13, process(13, "firefox -contentproc -profile /tmp/child -no-remote --remote-debugging-port 9353")],
      [14, process(14, "")],
    ]),
  });
  assert.deepEqual(found.map((entry) => entry.pid), [10]);
  assert.equal(found[0]?.profileDir, "/tmp/portpilot/ff");
});

// ── allocator: registry metadata + chrome backwards compatibility ────────────

test("allocateLane firefox: lane records browser=firefox + a -firefox profile dir", async () => {
  await withTempHome(async () => {
    const r = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "firefox", observations: [] });
    assert.equal(r.lane.browser, "firefox");
    assert.match(r.lane.chromeProfileDir, /codex-vend-firefox$/);
  });
});

test("allocateLane chrome (default): NO browser field persisted (byte-compat), no -firefox suffix", async () => {
  await withTempHome(async () => {
    const r = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    assert.equal(r.lane.browser, undefined);
    assert.doesNotMatch(r.lane.chromeProfileDir, /-firefox$/);
    assert.match(r.lane.chromeProfileDir, /codex-vend$/);
  });
});

test("allocateLane: chrome and firefox for the same (owner,cwd,session) are DISTINCT lanes, each idempotent", async () => {
  await withTempHome(async () => {
    const c = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    const f = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "firefox", observations: [] });
    assert.notEqual(c.lane.id, f.lane.id);
    assert.notEqual(c.lane.chromeProfileDir, f.lane.chromeProfileDir);
    assert.notEqual(c.lane.chromeDebugPort, f.lane.chromeDebugPort);
    const c2 = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    const f2 = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "firefox", observations: [] });
    assert.equal(c2.lane.id, c.lane.id);
    assert.equal(f2.lane.id, f.lane.id);
  });
});
