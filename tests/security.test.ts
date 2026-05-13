import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLaunchPlan,
  isChromeBinaryPath,
  isSafeInitialUrl,
  resolveChromeBinary,
  UnsafeChromeArgError,
} from "../src/core/chrome.js";
import { inferOwnerFromProfile } from "../src/dashboard/sources.js";
import { findExistingLane } from "../src/core/allocator.js";
import { Lane, KNOWN_LLM_OWNERS, nowIso } from "../src/core/lane.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

/* -------------------------------------------------------------------------- */
/*  #1 CRITICAL — initialUrl flag-injection                                   */
/* -------------------------------------------------------------------------- */

function laneOn(port = 9322): Lane {
  return {
    id: "lane_security",
    owner: "claude",
    project: "test",
    cwd: "/tmp/test",
    sessionId: "default",
    chromeDebugPort: port,
    chromeProfileDir: "/tmp/test/profile",
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
  };
}

test("isSafeInitialUrl: accepts http/https/about/file/chrome/view-source/data", () => {
  for (const url of [
    "http://example.com",
    "https://example.com",
    "about:blank",
    "file:///tmp/x.html",
    "chrome://newtab/",
    "view-source:https://example.com",
    "data:text/html,hi",
  ]) {
    assert.equal(isSafeInitialUrl(url), true, url);
  }
});

test("isSafeInitialUrl: rejects ANY value that looks like a flag", () => {
  for (const url of [
    "--load-extension=C:\\evil",
    "--proxy-server=http://attacker:1337",
    "--disable-web-security",
    "--user-data-dir=/somewhere/else",
    "-flag",
    "--",
  ]) {
    assert.equal(isSafeInitialUrl(url), false, url);
  }
});

test("isSafeInitialUrl: rejects unknown / unsafe schemes", () => {
  for (const url of ["javascript:alert(1)", "ftp://example.com", "vbscript:msgbox(1)", "ws://x", ""]) {
    assert.equal(isSafeInitialUrl(url), false, url);
  }
});

test("isSafeInitialUrl: rejects null/undefined/empty", () => {
  assert.equal(isSafeInitialUrl(undefined), false);
  assert.equal(isSafeInitialUrl(""), false);
});

test("buildLaunchPlan: throws UnsafeChromeArgError on Chrome-flag injection via initialUrl", () => {
  for (const evil of [
    "--load-extension=C:\\evil",
    "--proxy-server=http://attacker:1337",
    "--disable-web-security",
    "-something-not-a-url",
  ]) {
    assert.throws(
      () => buildLaunchPlan(laneOn(), { binaryPath: "/usr/bin/chrome", initialUrl: evil }),
      UnsafeChromeArgError,
      `should reject ${evil}`,
    );
  }
});

test("buildLaunchPlan: still accepts safe http/https URLs", () => {
  const plan = buildLaunchPlan(laneOn(), { binaryPath: "/usr/bin/chrome", initialUrl: "https://example.com" });
  assert.equal(plan.args[plan.args.length - 1], "https://example.com");
});

/* -------------------------------------------------------------------------- */
/*  #2 HIGH — binaryPath allowlist                                            */
/* -------------------------------------------------------------------------- */

test("isChromeBinaryPath: accepts known Chromium-family binaries", () => {
  for (const p of [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/brave",
    "chrome.exe",
    "msedge.exe",
  ]) {
    assert.equal(isChromeBinaryPath(p), true, p);
  }
});

test("isChromeBinaryPath: rejects arbitrary binaries", () => {
  for (const p of [
    "C:\\Users\\dev\\Downloads\\evil.exe",
    "C:\\Windows\\System32\\cmd.exe",
    "/bin/sh",
    "/usr/bin/python",
    "node.exe",
    "powershell.exe",
    "C:\\evil-chrome.exe",  // basename "evil-chrome.exe" is not in allowlist
  ]) {
    assert.equal(isChromeBinaryPath(p), false, p);
  }
});

test("resolveChromeBinary: throws UnsafeChromeArgError on non-Chromium binary", () => {
  assert.throws(
    () => resolveChromeBinary("C:\\Users\\dev\\Downloads\\evil.exe"),
    UnsafeChromeArgError,
  );
  assert.throws(() => resolveChromeBinary("C:\\Windows\\System32\\cmd.exe"), UnsafeChromeArgError);
});

test("resolveChromeBinary: passes through valid Chrome paths unchanged", () => {
  const p = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(resolveChromeBinary(p), p);
});

test("resolveChromeBinary: empty/undefined falls back to platform default (no validation)", () => {
  // No throw expected when explicit is empty / undefined.
  const r = resolveChromeBinary();
  assert.ok(typeof r === "string" && r.length > 0);
});

test("buildLaunchPlan: throws when binaryPath looks like an evil exe", () => {
  assert.throws(
    () => buildLaunchPlan(laneOn(), { binaryPath: "C:\\evil.exe" }),
    UnsafeChromeArgError,
  );
});

/* -------------------------------------------------------------------------- */
/*  #3 HIGH — findExistingLane matches legacy owners by canonical             */
/* -------------------------------------------------------------------------- */

function legacyLane(overrides: Partial<Lane>): Lane {
  return {
    id: "lane_legacy_x",
    owner: "codex-test-alpha",  // pre-canonicalization raw string
    project: "proj",
    cwd: "/tmp/proj",
    sessionId: "test-alpha",
    chromeProfileDir: "/tmp/proj/profile",
    chromeDebugPort: 9322,
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
    ...overrides,
  };
}

test("findExistingLane: still strict-matches when owner is already canonical", () => {
  const lanes = [legacyLane({ id: "L1", owner: "codex", sessionId: "test-alpha" })];
  const found = findExistingLane(lanes, "codex", "/tmp/proj", "test-alpha");
  assert.ok(found);
  assert.equal(found!.id, "L1");
});

test("findExistingLane: matches a legacy lane via canonicalized owner equality", () => {
  // Stored owner is the raw string "codex-test-alpha", caller is asking
  // for canonical "codex" with sessionId "test-alpha". Without the fix,
  // this returns undefined and allocateLane creates a duplicate.
  const lanes = [legacyLane({ id: "L_legacy", owner: "codex-test-alpha", sessionId: "test-alpha" })];
  const found = findExistingLane(lanes, "codex", "/tmp/proj", "test-alpha");
  assert.ok(found, "legacy lane should be discoverable by canonical owner");
  assert.equal(found!.id, "L_legacy");
});

test("findExistingLane: still rejects mismatched cwd/session even with canonical match", () => {
  const lanes = [legacyLane({ id: "L_legacy", owner: "codex-test-alpha", sessionId: "test-alpha" })];
  // Different cwd
  assert.equal(findExistingLane(lanes, "codex", "/tmp/other", "test-alpha"), undefined);
  // Different sessionId
  assert.equal(findExistingLane(lanes, "codex", "/tmp/proj", "different"), undefined);
});

test("findExistingLane: skips released lanes regardless of canonical match", () => {
  const lanes = [
    legacyLane({ id: "L_released", owner: "codex-test-alpha", sessionId: "test-alpha", status: "released" }),
  ];
  assert.equal(findExistingLane(lanes, "codex", "/tmp/proj", "test-alpha"), undefined);
});

/* -------------------------------------------------------------------------- */
/*  #4 HIGH — inferOwnerFromProfile uses KNOWN_LLM_OWNERS                     */
/* -------------------------------------------------------------------------- */

test("inferOwnerFromProfile: recognises every name in KNOWN_LLM_OWNERS", () => {
  for (const name of KNOWN_LLM_OWNERS) {
    const probe = `C:\\Users\\dev\\.portpilot\\profiles\\${name}-some-project`;
    assert.equal(inferOwnerFromProfile(probe), name, `should recognise '${name}' in path`);
  }
});

test("inferOwnerFromProfile: copilot and chatgpt no longer fall to 'external'", () => {
  // Regression: these two names existed in KNOWN_LLM_OWNERS but were
  // missing from the dashboard's hardcoded list.
  assert.equal(inferOwnerFromProfile("/profiles/copilot-x"), "copilot");
  assert.equal(inferOwnerFromProfile("/profiles/chatgpt-y"), "chatgpt");
});

test("inferOwnerFromProfile: returns 'external' for unknown names", () => {
  assert.equal(inferOwnerFromProfile("/profiles/random-vendor-x"), "external");
  assert.equal(inferOwnerFromProfile(undefined), "external");
});

/* -------------------------------------------------------------------------- */
/*  #5 HIGH - rejected global-key hook dependency stays out of release metadata */
/* -------------------------------------------------------------------------- */

test("publish/readiness metadata does not recommend the rejected global key listener", () => {
  const packageJson = readRepoFile("package.json");
  const packageLock = readRepoFile("package-lock.json");
  const notes = readRepoFile("docs/CROSS_PLATFORM_NOTES.md");

  assert.doesNotMatch(packageJson, /node-global-key-listener|WinKeyServer/i);
  assert.doesNotMatch(packageLock, /node-global-key-listener|WinKeyServer/i);
  assert.doesNotMatch(notes, /\[x\].*node-global-key-listener/i);
  assert.doesNotMatch(notes, /uses\s+node-global-key-listener/i);
});

test("postinstall messaging does not advertise removed hotkey or extension flows", () => {
  const postinstall = readRepoFile("scripts/postinstall.cjs");

  assert.doesNotMatch(postinstall, /Ctrl\+Shift\+H/i);
  assert.doesNotMatch(postinstall, /extension install/i);
});

test("build-only image packages are not installed during global runtime install", () => {
  const pkg = JSON.parse(readRepoFile("package.json"));
  const prodDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };

  assert.equal(prodDeps.sharp, undefined);
  assert.equal(prodDeps["png-to-ico"], undefined);
  assert.equal(pkg.devDependencies?.sharp, "^0.34.5");
  assert.equal(pkg.devDependencies?.["png-to-ico"], "^3.0.1");
});

test("git install pack input excludes temporary node_modules", () => {
  const pkg = JSON.parse(readRepoFile("package.json"));
  const npmignore = readRepoFile(".npmignore");
  const prepack = readRepoFile("scripts/prepack.cjs");

  assert.equal(pkg.scripts?.prepack, "node scripts/prepack.cjs");
  assert.match(npmignore, /^node_modules\/$/m);
  assert.match(prepack, /rmSync\(rootNodeModules, \{ recursive: true, force: true \}\)/);
});

test("installer and CLI help do not advertise removed extension or hotkey flows", () => {
  for (const path of ["scripts/install.ps1", "src/cli/help.ts"]) {
    const content = readRepoFile(path);
    assert.doesNotMatch(content, /Ctrl\+Shift\+H/i, path);
    assert.doesNotMatch(content, /extension install/i, path);
    assert.doesNotMatch(content, /Hand to portpilot/i, path);
    assert.doesNotMatch(content, /tab handoff/i, path);
    assert.doesNotMatch(content, /global hotkey listener/i, path);
  }
});
