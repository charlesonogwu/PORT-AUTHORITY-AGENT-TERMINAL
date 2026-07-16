import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLaneAction } from "../src/core/action-safety.js";
import type { Lane } from "../src/core/lane.js";

function lane(browser: "chrome" | "edge" | "firefox" = "chrome"): Lane {
  return {
    id: "lane-release-b",
    owner: "codex",
    project: "release-b",
    cwd: "/tmp/release-b",
    sessionId: "default",
    browser,
    chromeDebugPort: 9444,
    chromeProfileDir: `/tmp/portpilot/profiles/release-b-${browser}`,
    status: "active",
    createdAt: new Date(0).toISOString(),
    lastSeen: new Date().toISOString(),
    pid: 4242,
  };
}

test("action validation accepts only the matching Chrome PID and profile", () => {
  const target = lane();
  const result = evaluateLaneAction(target, 4242, [{
    port: 9444,
    pid: 4242,
    source: "native",
    protocol: "tcp",
    command: "Google Chrome",
    commandLine: `Google Chrome --remote-debugging-port=9444 --user-data-dir=${target.chromeProfileDir}`,
  }]);
  assert.equal(result.lane.id, target.id);
  assert.equal(result.pid, 4242);
});

test("action validation accepts matching Firefox only with -profile and -no-remote", () => {
  const target = lane("firefox");
  assert.equal(evaluateLaneAction(target, 4343, [{
    port: 9444,
    pid: 4343,
    source: "native",
    protocol: "tcp",
    command: "firefox",
    commandLine: `firefox -profile ${target.chromeProfileDir} -no-remote --remote-debugging-port 9444`,
  }]).pid, 4343);
});

test("action validation refuses PID mismatch, foreign profile, missing command, and released lane", () => {
  const target = lane();
  const matching = [{
    port: 9444,
    pid: 4242,
    source: "native" as const,
    protocol: "tcp" as const,
    command: "Google Chrome",
    commandLine: `Google Chrome --user-data-dir=${target.chromeProfileDir}`,
  }];
  assert.throws(() => evaluateLaneAction(target, 9999, matching), /PID/i);
  assert.throws(() => evaluateLaneAction(target, 4242, [{ ...matching[0]!, commandLine: "Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome" }]), /safe-attach/i);
  assert.throws(() => evaluateLaneAction(target, 4242, [{ ...matching[0]!, commandLine: undefined }]), /safe-attach/i);
  assert.throws(() => evaluateLaneAction({ ...target, status: "released" }, 4242, matching), /released/i);
});
