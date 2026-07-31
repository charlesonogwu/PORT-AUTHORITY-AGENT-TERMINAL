import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import {
  BrowserBinaryNotFoundError,
  assertBrowserBinaryAvailable,
  launchChromeForLane,
} from "../src/core/chrome.js";
import { launchBrowserForLaneWithDeps } from "../src/core/browsers.js";
import type { Lane } from "../src/core/lane.js";
import type { PortObservation, ScanResult } from "../src/core/scanner.js";
import { withTempHome } from "./helpers.js";

function lane(profileDir: string): Lane {
  const now = new Date().toISOString();
  return {
    id: "lane-launch-safe",
    owner: "codex",
    project: "launch-safe",
    cwd: "C:\\work\\launch-safe",
    sessionId: "default",
    chromeDebugPort: 9444,
    chromeProfileDir: profileDir,
    status: "reserved",
    createdAt: now,
    lastSeen: now,
  };
}

test("launch validation rejects a missing recognized browser executable", async () => {
  await withTempHome(async (home) => {
    const missing = join(home, "missing", "chrome.exe");
    assert.throws(
      () => assertBrowserBinaryAvailable(missing, "Chrome"),
      BrowserBinaryNotFoundError,
    );
  });
});

test("spawn ENOENT is returned as a launch error instead of an unhandled child error", async () => {
  await withTempHome(async (home) => {
    const missing = join(home, "missing", "chrome.exe");
    await assert.rejects(
      launchChromeForLane(lane(join(home, "profile")), {
        binaryPath: missing,
        detached: false,
      }),
      /not found|launch/i,
    );
  });
});

test("concurrent launches serialize and both return the verified browser pid", async () => {
  await withTempHome(async (home) => {
    const targetLane = lane(join(home, "profile"));
    let launches = 0;
    let observations: PortObservation[] = [];
    const scanPorts = async (): Promise<ScanResult> => ({
      observations,
      source: "native",
      errors: [],
    });
    const launch = async () => {
      launches++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      observations = [{
        port: 9444,
        pid: 7777,
        command: "chrome.exe",
        commandLine: `chrome.exe --remote-debugging-port=9444 --user-data-dir="${targetLane.chromeProfileDir}"`,
        protocol: "tcp",
        source: "native",
      }];
      return {
        pid: 1111,
        binary: "chrome.exe",
        args: [],
        spawned: true,
        mode: "visible" as const,
      };
    };

    const [first, second] = await Promise.all([
      launchBrowserForLaneWithDeps(targetLane, {}, { scanPorts, launch }),
      launchBrowserForLaneWithDeps(targetLane, {}, { scanPorts, launch }),
    ]);

    assert.equal(launches, 1);
    assert.equal(first.pid, 7777);
    assert.equal(second.pid, 7777);
    assert.deepEqual([first.spawned, second.spawned].sort(), [false, true]);
  });
});
