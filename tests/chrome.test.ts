import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateChromeAttach, extractUserDataDir, isChromeProcess, buildLaunchPlan } from "../src/core/chrome.js";
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
