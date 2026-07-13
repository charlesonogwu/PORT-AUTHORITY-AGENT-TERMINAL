import { test } from "node:test";
import assert from "node:assert/strict";
import { HARDENING_ARGS, buildLaunchPlan } from "../src/core/chrome.js";
import { buildEdgeLaunchPlan } from "../src/core/edge.js";
import { buildFirefoxLaunchPlan } from "../src/core/firefox.js";
import { Lane, nowIso } from "../src/core/lane.js";

/**
 * Windows shell URL-hijack regression coverage.
 *
 * Bug scenario: a URL clicked in an external app (Terminal, IDE, chat, PDF)
 * lands INSIDE a running PortPilot lane rather than opening a fresh
 * default-profile browser. Live reproduction across 4 scenarios on Windows 11
 * + Edge 150 with the current launch flags showed the URL always spawned a
 * fresh default-profile Edge process (or reused an existing one) — never the
 * lane. Isolation rests on three invariants; these tests pin them so a future
 * refactor can't accidentally weaken any of them.
 */

function laneWith(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "lane_iso",
    owner: "agent",
    project: "iso",
    cwd: "/tmp/iso",
    sessionId: "default",
    chromeDebugPort: 9400,
    chromeProfileDir: "C:/pp/profiles/agent-iso",
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
    ...overrides,
  };
}

// ── Chrome / Edge (CDP): the three isolation invariants ─────────────────────

test("Chrome lane launch: --user-data-dir is set to the lane's dedicated profile", () => {
  // The primary isolation mechanism: Chromium's process singleton is a file
  // lock inside the user-data-dir, so a msedge.exe fired by the shell (with
  // the default user-data-dir) can never collide with a lane's singleton.
  const plan = buildLaunchPlan(laneWith({ chromeProfileDir: "C:/pp/profiles/x" }));
  const udd = plan.args.find((a) => a.startsWith("--user-data-dir="));
  assert.equal(udd, "--user-data-dir=C:/pp/profiles/x");
  // And nothing points it at the OS default profile location.
  assert.ok(!plan.args.some((a) => /Local[\\/]Microsoft[\\/]Edge/.test(a)));
  assert.ok(!plan.args.some((a) => /Local[\\/]Google[\\/]Chrome/.test(a)));
});

test("Chrome lane launch: --no-default-browser-check + --no-first-run present", () => {
  const plan = buildLaunchPlan(laneWith());
  assert.ok(plan.args.includes("--no-default-browser-check"));
  assert.ok(plan.args.includes("--no-first-run"));
});

test("Chrome lane launch: HARDENING_ARGS applied on every mode", () => {
  // Defence-in-depth flags that stop a lane from being registered as a
  // Windows shell URL target. Every mode gets them (visible, background,
  // headless).
  for (const mode of ["visible", "background", "headless"] as const) {
    const plan = buildLaunchPlan(laneWith(), { mode });
    for (const flag of HARDENING_ARGS) {
      assert.ok(plan.args.includes(flag), `${mode} lane missing hardening flag: ${flag}`);
    }
  }
});

test("Chrome lane hardening: --disable-default-apps present", () => {
  // Stops Chrome/Edge from auto-installing built-in "default web apps"
  // (Adblock Plus in Edge, Docs offline in Chrome) into the lane's profile.
  // Those install pages appearing in the CDP tab list is the visible symptom
  // that reads as "a URL joined my lane".
  assert.ok(HARDENING_ARGS.includes("--disable-default-apps"));
  assert.ok(buildLaunchPlan(laneWith()).args.includes("--disable-default-apps"));
});

test("Chrome lane hardening: --no-service-autorun present", () => {
  // Opts the lane out of the Windows Service Autorun that Chromium may
  // otherwise register under the running profile.
  assert.ok(HARDENING_ARGS.includes("--no-service-autorun"));
  assert.ok(buildLaunchPlan(laneWith()).args.includes("--no-service-autorun"));
});

test("Chrome lane hardening: --disable-background-networking present", () => {
  // Stops background Google Update / Edge Autofill pings that also touch
  // the profile's cookie jar.
  assert.ok(HARDENING_ARGS.includes("--disable-background-networking"));
  assert.ok(buildLaunchPlan(laneWith()).args.includes("--disable-background-networking"));
});

test("Chrome lane hardening: flags come BEFORE any caller extraArgs (caller can't remove them by overriding)", () => {
  const plan = buildLaunchPlan(laneWith(), { extraArgs: ["--custom-flag"] });
  const hardeningIdx = plan.args.indexOf("--disable-default-apps");
  const customIdx = plan.args.indexOf("--custom-flag");
  assert.ok(hardeningIdx >= 0);
  assert.ok(customIdx >= 0);
  assert.ok(hardeningIdx < customIdx);
});

// ── Edge: same plan, so isolation carries through ───────────────────────────

test("Edge lane launch: inherits the same three isolation invariants", () => {
  const plan = buildEdgeLaunchPlan(laneWith({ chromeProfileDir: "C:/pp/profiles/edge-x" }));
  assert.equal(plan.args.find((a) => a.startsWith("--user-data-dir=")), "--user-data-dir=C:/pp/profiles/edge-x");
  assert.ok(plan.args.includes("--no-default-browser-check"));
  for (const flag of HARDENING_ARGS) {
    assert.ok(plan.args.includes(flag), `edge lane missing hardening flag: ${flag}`);
  }
  // And uses an Edge binary, not Chrome's.
  assert.match(plan.binary.toLowerCase(), /msedge|microsoft.edge/);
});

// ── Firefox (BiDi): its own definitive isolation flag ───────────────────────

test("Firefox lane launch: -no-remote is set (the definitive isolation flag)", () => {
  // Firefox's `-no-remote` is the definitive per-instance isolation switch;
  // it forces a brand-new instance rather than dispatching to whatever
  // Firefox is currently running for the user. Without it, an external URL
  // fired at the user's default Firefox could reach the lane's instance.
  const plan = buildFirefoxLaunchPlan(laneWith({ chromeDebugPort: 9411, chromeProfileDir: "C:/pp/profiles/ff-x" }));
  assert.ok(plan.args.includes("-no-remote"));
  const i = plan.args.indexOf("-profile");
  assert.equal(plan.args[i + 1], "C:/pp/profiles/ff-x");
});

// ── Documentation invariant: no launch plan ever leaks the lane's --user-data-dir
//    to a location that overlaps the OS default browser profile. ─────────────

test("no launch plan points at an OS-default profile path (regression guard)", () => {
  const chromePlan = buildLaunchPlan(laneWith());
  const edgePlan = buildEdgeLaunchPlan(laneWith());
  const ffPlan = buildFirefoxLaunchPlan(laneWith());
  const forbidden = [
    /Local[\\/]Microsoft[\\/]Edge[\\/]User Data/i, // Edge default on Windows
    /Local[\\/]Google[\\/]Chrome[\\/]User Data/i, // Chrome default on Windows
    /AppData[\\/]Roaming[\\/]Mozilla[\\/]Firefox/i, // Firefox default on Windows
  ];
  for (const plan of [chromePlan, edgePlan, ffPlan]) {
    for (const arg of plan.args) {
      for (const bad of forbidden) {
        assert.ok(!bad.test(arg), `launch plan leaks an OS-default profile path: ${arg}`);
      }
    }
  }
});
