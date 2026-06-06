import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateChromeAttach,
  extractUserDataDir,
  isChromeProcess,
  buildLaunchPlan,
  modeLaunchArgs,
  normalizeChromeMode,
  resolveChromeMode,
  OFFSCREEN_WINDOW_ARGS,
} from "../src/core/chrome.js";
import { Lane, nowIso } from "../src/core/lane.js";
import { PortObservation } from "../src/core/scanner.js";

function laneWith(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "lane_a",
    owner: "codex",
    project: "vend",
    cwd: "/tmp/vend",
    sessionId: "default",
    chromeDebugPort: 9322,
    chromeProfileDir: "/tmp/profiles/codex-vend",
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
    ...overrides,
  };
}

test("extractUserDataDir parses --user-data-dir=value", () => {
  assert.equal(
    extractUserDataDir("chrome.exe --user-data-dir=C:\\tmp\\codex-vend --remote-debugging-port=9322"),
    "C:\\tmp\\codex-vend",
  );
});

test("extractUserDataDir parses quoted values with spaces", () => {
  assert.equal(
    extractUserDataDir(`chrome --user-data-dir="C:\\Users\\jane doe\\profile" --remote-debugging-port=9322`),
    "C:\\Users\\jane doe\\profile",
  );
});

test("extractUserDataDir parses --user-data-dir <value> form", () => {
  assert.equal(
    extractUserDataDir("chromium --user-data-dir /home/jane/p --remote-debugging-port=9323"),
    "/home/jane/p",
  );
});

test("isChromeProcess detects common Chromium-family executables", () => {
  assert.equal(isChromeProcess({ port: 0, source: "native", command: "chrome.exe" }), true);
  assert.equal(isChromeProcess({ port: 0, source: "native", command: "Google Chrome" }), true);
  assert.equal(isChromeProcess({ port: 0, source: "native", command: "chromium-browser" }), true);
  assert.equal(isChromeProcess({ port: 0, source: "native", command: "msedge.exe" }), true);
  assert.equal(isChromeProcess({ port: 0, source: "native", command: "node.exe" }), false);
  assert.equal(isChromeProcess({ port: 0, source: "native" }), false);
});

test("evaluateChromeAttach: free port is safe-free", () => {
  const v = evaluateChromeAttach(laneWith(), []);
  assert.equal(v.kind, "safe-free");
});

test("evaluateChromeAttach: matching Chrome profile is safe-attach", () => {
  const obs: PortObservation[] = [
    {
      port: 9322,
      source: "native",
      protocol: "tcp",
      command: "chrome.exe",
      commandLine: "chrome.exe --remote-debugging-port=9322 --user-data-dir=/tmp/profiles/codex-vend",
    },
  ];
  const v = evaluateChromeAttach(laneWith(), obs);
  assert.equal(v.kind, "safe-attach");
});

test("evaluateChromeAttach: foreign Chrome profile is unsafe", () => {
  const obs: PortObservation[] = [
    {
      port: 9322,
      source: "native",
      protocol: "tcp",
      command: "chrome.exe",
      commandLine: "chrome.exe --remote-debugging-port=9322 --user-data-dir=/tmp/profiles/claude-something",
    },
  ];
  const v = evaluateChromeAttach(laneWith(), obs);
  assert.equal(v.kind, "unsafe-foreign-chrome");
  if (v.kind === "unsafe-foreign-chrome") {
    assert.equal(v.foundProfile, "/tmp/profiles/claude-something");
  }
});

test("evaluateChromeAttach: Chrome without --user-data-dir is treated as foreign", () => {
  const obs: PortObservation[] = [
    {
      port: 9322,
      source: "native",
      protocol: "tcp",
      command: "chrome.exe",
      commandLine: "chrome.exe --remote-debugging-port=9322",
    },
  ];
  const v = evaluateChromeAttach(laneWith(), obs);
  assert.equal(v.kind, "unsafe-foreign-chrome");
});

test("evaluateChromeAttach: non-Chrome occupant is unsafe-unknown", () => {
  const obs: PortObservation[] = [
    {
      port: 9322,
      source: "native",
      protocol: "tcp",
      command: "node.exe",
      commandLine: "node server.js",
    },
  ];
  const v = evaluateChromeAttach(laneWith(), obs);
  assert.equal(v.kind, "unsafe-unknown");
});

test("evaluateChromeAttach: lane with no Chrome port returns safe-free port=0", () => {
  const v = evaluateChromeAttach(laneWith({ chromeDebugPort: undefined }), []);
  assert.equal(v.kind, "safe-free");
  assert.equal(v.port, 0);
});

test("buildLaunchPlan includes the required Chrome flags", () => {
  const plan = buildLaunchPlan(laneWith(), { binaryPath: "/usr/bin/chrome" });
  assert.equal(plan.binary, "/usr/bin/chrome");
  assert.ok(plan.args.includes("--remote-debugging-port=9322"));
  assert.ok(plan.args.includes("--user-data-dir=/tmp/profiles/codex-vend"));
  assert.ok(plan.args.includes("--no-first-run"));
  assert.ok(plan.args.includes("--no-default-browser-check"));
});

test("buildLaunchPlan throws when the lane has no Chrome debug port", () => {
  assert.throws(() => buildLaunchPlan(laneWith({ chromeDebugPort: undefined })), /no chromeDebugPort/i);
});

test("buildLaunchPlan appends initialUrl as the trailing positional arg", () => {
  const plan = buildLaunchPlan(laneWith(), { binaryPath: "/usr/bin/chrome", initialUrl: "https://example.com" });
  assert.equal(plan.args[plan.args.length - 1], "https://example.com");
});

test("buildLaunchPlan keeps initialUrl after extraArgs", () => {
  const plan = buildLaunchPlan(laneWith(), {
    binaryPath: "/usr/bin/chrome",
    extraArgs: ["--headless=new", "--disable-gpu"],
    initialUrl: "https://example.com",
  });
  // last arg must be the URL
  assert.equal(plan.args[plan.args.length - 1], "https://example.com");
  // headless flag must still be present
  assert.ok(plan.args.includes("--headless=new"));
});

test("buildLaunchPlan does not include URL slot when initialUrl is empty/missing", () => {
  const plan = buildLaunchPlan(laneWith(), { binaryPath: "/usr/bin/chrome" });
  // last arg should be one of the boolean flags, not a URL
  assert.match(plan.args[plan.args.length - 1]!, /^--/);
});

/* ── Launch modes ─────────────────────────────────────────────────────── */

test("normalizeChromeMode accepts the three modes case-insensitively, rejects junk", () => {
  assert.equal(normalizeChromeMode("visible"), "visible");
  assert.equal(normalizeChromeMode("Background"), "background");
  assert.equal(normalizeChromeMode("  HEADLESS  "), "headless");
  assert.equal(normalizeChromeMode("invisible"), undefined);
  assert.equal(normalizeChromeMode(""), undefined);
  assert.equal(normalizeChromeMode(undefined), undefined);
  assert.equal(normalizeChromeMode(42), undefined);
});

test("modeLaunchArgs maps each mode to the right Chrome flags", () => {
  assert.deepEqual(modeLaunchArgs("visible"), []);
  assert.deepEqual(modeLaunchArgs("headless"), ["--headless=new"]);
  assert.deepEqual(modeLaunchArgs("background"), [...OFFSCREEN_WINDOW_ARGS]);
  // off-screen flags must actually push the window off the desktop
  assert.ok(modeLaunchArgs("background").some((a) => a.includes("--window-position=-32000,-32000")));
});

test("resolveChromeMode precedence: per-call > env > config > visible", () => {
  // per-call beats everything
  assert.equal(resolveChromeMode("visible", "background", "headless"), "visible");
  // env beats config when no per-call
  assert.equal(resolveChromeMode(undefined, "visible", "background"), "background");
  // config used when no per-call and no env
  assert.equal(resolveChromeMode(undefined, "headless", undefined), "headless");
  // default when nothing supplied
  assert.equal(resolveChromeMode(undefined, undefined, undefined), "visible");
  // junk values are ignored and fall through
  assert.equal(resolveChromeMode("nonsense", undefined, "background"), "background");
});

test("buildLaunchPlan injects off-screen flags for background mode, URL still last", () => {
  const plan = buildLaunchPlan(laneWith(), {
    binaryPath: "/usr/bin/chrome",
    mode: "background",
    initialUrl: "https://example.com",
  });
  assert.ok(plan.args.includes("--window-position=-32000,-32000"));
  assert.ok(plan.args.includes("--window-size=1280,1000"));
  // required base flags are still present
  assert.ok(plan.args.includes("--remote-debugging-port=9322"));
  // URL must remain the trailing positional arg
  assert.equal(plan.args[plan.args.length - 1], "https://example.com");
});

test("buildLaunchPlan injects --headless=new for headless mode", () => {
  const plan = buildLaunchPlan(laneWith(), { binaryPath: "/usr/bin/chrome", mode: "headless" });
  assert.ok(plan.args.includes("--headless=new"));
  assert.ok(!plan.args.includes("--window-position=-32000,-32000"));
});

test("buildLaunchPlan visible mode is unchanged (no mode flags) — regression guard", () => {
  const visible = buildLaunchPlan(laneWith(), { binaryPath: "/usr/bin/chrome", mode: "visible" });
  const omitted = buildLaunchPlan(laneWith(), { binaryPath: "/usr/bin/chrome" });
  assert.deepEqual(visible.args, omitted.args);
  assert.ok(!visible.args.some((a) => a.includes("--headless")));
  assert.ok(!visible.args.some((a) => a.includes("--window-position")));
});
