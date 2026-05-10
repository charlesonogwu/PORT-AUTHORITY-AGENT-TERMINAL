#!/usr/bin/env -S node --import=tsx
/**
 * scripts/robust-test.ts — exercise every portpilot safety verdict under
 * real conditions: actual Chrome processes, actual port observations, actual
 * registry state. No mocks.
 *
 * Test plan:
 *   Scenario 1 — safe-free:
 *     reserve lane for owner=alice in /tmp/test-alice
 *     check_lane → expect "safe-free"
 *
 *   Scenario 2 — safe-attach (real Chrome, matching profile):
 *     launch Chrome on alice's port + profile (--headless=new, unobtrusive)
 *     wait for CDP /json/version
 *     scan ports → confirm portpilot SEES Chrome there
 *     check_lane → expect "safe-attach"
 *
 *   Scenario 3 — unsafe-foreign-chrome (Chrome with WRONG profile):
 *     spin up a SECOND Chrome process on a separate port with a foreign
 *     profile. Then craft a synthetic lane that *thinks* it owns that
 *     foreign port — i.e. simulating registry drift. evaluateChromeAttach
 *     must return "unsafe-foreign-chrome".
 *
 *   Scenario 4 — unsafe-unknown (non-Chrome process on the port):
 *     start a tiny Node HTTP server on a free port, craft a synthetic lane
 *     pointing there. evaluateChromeAttach must return "unsafe-unknown".
 *
 * Cleanup:
 *   kill any Chrome process we spawned, close the HTTP server, remove the
 *   test PORTPILOT_HOME directory entirely.
 *
 * Usage:
 *   npm run robust-test
 *   # or directly:
 *   tsx scripts/robust-test.ts [--keep] [--verbose]
 *
 *   --keep      do not delete the temp PORTPILOT_HOME at the end
 *   --verbose   print every scan / lane mutation
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import process from "node:process";

// We import from the COMPILED dist so we don't need the tsx runtime to
// resolve the project's relative .ts paths transitively. This script is run
// via tsx itself, but the imported module graph is plain JS.
import { allocateLane, checkLane } from "../src/core/allocator.js";
import { findLane, listLanes, removeLane, updateRegistry, upsertLane } from "../src/core/registry.js";
import { scanPorts } from "../src/core/scanner.js";
import { evaluateChromeAttach, launchChromeForLane, resolveChromeBinary } from "../src/core/chrome.js";
import { Lane, newLaneId, nowIso } from "../src/core/lane.js";
import { portpilotHome } from "../src/core/paths.js";

interface Args { keep: boolean; verbose: boolean }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return { keep: argv.includes("--keep"), verbose: argv.includes("--verbose") };
}

const argv = parseArgs();

interface ScenarioResult {
  name: string;
  passed: boolean;
  expected: string;
  got: string;
  detail?: string;
}

const results: ScenarioResult[] = [];

function log(msg: string): void {
  process.stdout.write(msg + "\n");
}
function logv(msg: string): void {
  if (argv.verbose) process.stdout.write(`    [v] ${msg}\n`);
}

function record(name: string, expected: string, got: string, detail?: string): boolean {
  const passed = got === expected;
  results.push({ name, passed, expected, got, detail });
  log(`  ${passed ? "PASS" : "FAIL"}  ${name}  expected=${expected}  got=${got}${detail ? `  (${detail})` : ""}`);
  return passed;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function waitForCdp(port: number, totalMs: number): Promise<{ Browser: string }> {
  const deadline = Date.now() + totalMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      return await fetchJson<{ Browser: string }>(`http://127.0.0.1:${port}/json/version`, 1000);
    } catch (err) {
      lastErr = err as Error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`CDP did not come up on :${port} within ${totalMs}ms (last: ${lastErr?.message})`);
}

const spawnedChildren: { name: string; pid: number; port?: number }[] = [];

async function killChildren(): Promise<void> {
  for (const entry of spawnedChildren) {
    try {
      if (process.platform === "win32") {
        // /T = kill the whole tree; Chrome spawns many helper procs.
        spawnSync("taskkill.exe", ["/PID", String(entry.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        try { process.kill(entry.pid, "SIGTERM"); } catch { /* ignore */ }
      }
      logv(`killed ${entry.name} pid=${entry.pid}`);
    } catch {
      // ignore
    }
  }
  // Give the OS a moment to release the ports
  await new Promise((r) => setTimeout(r, 500));
}

async function setupTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "portpilot-robust-"));
  process.env.PORTPILOT_HOME = home;
  log(`PORTPILOT_HOME=${home}`);
  return home;
}

async function teardown(home: string): Promise<void> {
  await killChildren();
  if (!argv.keep) {
    await rm(home, { recursive: true, force: true }).catch(() => {});
    log(`cleaned up ${home}`);
  } else {
    log(`kept ${home} (--keep)`);
  }
}

// -----------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------

async function scenario1_safeFree(): Promise<Lane> {
  log("\n[1/4] safe-free — fresh reservation, port not bound");
  const cwd = join(process.env.PORTPILOT_HOME!, "alice-project");
  await mkdir(cwd, { recursive: true });
  const r = await allocateLane({ owner: "alice", cwd, task: "safe-free scenario" });
  logv(`reserved lane ${r.lane.id} port=${r.lane.chromeDebugPort} profile=${r.lane.chromeProfileDir}`);
  const check = await checkLane(r.lane);
  record("safe-free verdict", "safe-free", check.verdict.kind);
  return r.lane;
}

async function scenario2_safeAttach(aliceLane: Lane): Promise<void> {
  log("\n[2/4] safe-attach — real Chrome on lane port + profile");
  await mkdir(aliceLane.chromeProfileDir, { recursive: true });
  const launch = await launchChromeForLane(aliceLane, { extraArgs: ["--headless=new", "--disable-gpu"] });
  if (!launch.pid || !launch.spawned) {
    record("Chrome spawn", "spawned", "failed", "could not start Chrome");
    return;
  }
  spawnedChildren.push({ name: "alice-chrome", pid: launch.pid, port: aliceLane.chromeDebugPort });
  logv(`launched Chrome pid=${launch.pid} port=${aliceLane.chromeDebugPort}`);
  try {
    const v = await waitForCdp(aliceLane.chromeDebugPort!, 15_000);
    logv(`CDP responding: ${v.Browser}`);
  } catch (err) {
    record("CDP comes up", "ok", "failed", (err as Error).message);
    return;
  }
  // Now scan ports and confirm portpilot sees Chrome on this port.
  const scan = await scanPorts();
  const obs = scan.observations.find((o) => o.port === aliceLane.chromeDebugPort);
  logv(`scanner saw :${aliceLane.chromeDebugPort} → ${obs?.command ?? "(not seen)"}  cmdline=${obs?.commandLine ?? "(none)"}`);
  record("scanner sees Chrome on lane port", "seen", obs ? "seen" : "missing", obs?.command);
  const check = await checkLane(aliceLane);
  record("safe-attach verdict", "safe-attach", check.verdict.kind, check.verdict.kind === "unsafe-foreign-chrome" ? `foundProfile=${(check.verdict as { foundProfile?: string }).foundProfile ?? "?"}` : undefined);
}

async function scenario3_unsafeForeignChrome(): Promise<void> {
  log("\n[3/4] unsafe-foreign-chrome — Chrome with WRONG profile on lane port");
  // Pick a free port well above what scenario 2 used.
  const foreignPort = 9398;
  const foreignProfile = join(process.env.PORTPILOT_HOME!, "foreign-chrome-profile");
  await mkdir(foreignProfile, { recursive: true });
  // Launch Chrome with a profile that DOES NOT belong to any portpilot lane.
  const binary = resolveChromeBinary();
  logv(`launching foreign Chrome: ${binary} on :${foreignPort} with profile=${foreignProfile}`);
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${foreignPort}`,
      `--user-data-dir=${foreignProfile}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdio: "ignore", windowsHide: false, detached: true },
  );
  if (!child.pid) {
    record("foreign Chrome spawn", "spawned", "failed");
    return;
  }
  child.unref();
  spawnedChildren.push({ name: "foreign-chrome", pid: child.pid, port: foreignPort });
  try {
    await waitForCdp(foreignPort, 15_000);
  } catch (err) {
    record("foreign CDP up", "ok", "failed", (err as Error).message);
    return;
  }
  // Now: synthesize a lane that THINKS it owns that port, but its expected
  // profile is some other path. This simulates the dangerous registry-drift
  // scenario portpilot is designed to catch.
  const expectedProfile = join(process.env.PORTPILOT_HOME!, "profiles", "bob-someproject");
  const driftedLane: Lane = {
    id: newLaneId(),
    owner: "bob",
    project: "someproject",
    cwd: join(process.env.PORTPILOT_HOME!, "bob-someproject"),
    chromeDebugPort: foreignPort,
    chromeProfileDir: expectedProfile,
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
  };
  // Stick it into the registry so it's a realistic state.
  await upsertLane(driftedLane);
  logv(`synthesized drifted lane: expects port=${foreignPort} profile=${expectedProfile}`);
  // Run the live check — must come back unsafe.
  const result = await checkLane(driftedLane);
  record(
    "unsafe-foreign-chrome verdict",
    "unsafe-foreign-chrome",
    result.verdict.kind,
    result.verdict.kind === "unsafe-foreign-chrome" ? `foundProfile=${(result.verdict as { foundProfile?: string }).foundProfile}` : undefined,
  );
  // Also verify via the offline evaluator with the live observations
  const scan = await scanPorts();
  const direct = evaluateChromeAttach(driftedLane, scan.observations);
  record("direct evaluator agrees", "unsafe-foreign-chrome", direct.kind);
  // Tidy: remove the synthetic lane from registry.
  await removeLane(driftedLane.id);
}

async function scenario4_unsafeUnknown(): Promise<{ server: Server; port: number } | null> {
  log("\n[4/4] unsafe-unknown — non-Chrome process on the lane port");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hello from a node http server, definitely not chrome\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) {
    record("HTTP server bind", "ok", "failed");
    server.close();
    return null;
  }
  const port = addr.port;
  logv(`node http server listening on :${port}`);
  // Synthesize a lane pointing at this non-Chrome port.
  const lane: Lane = {
    id: newLaneId(),
    owner: "carol",
    project: "noderver",
    cwd: join(process.env.PORTPILOT_HOME!, "carol-noderver"),
    chromeDebugPort: port,
    chromeProfileDir: join(process.env.PORTPILOT_HOME!, "profiles", "carol-noderver"),
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
  };
  await upsertLane(lane);
  const result = await checkLane(lane);
  // On Windows, the native scanner identifies the listener's process as
  // node.exe — so the verdict should be "unsafe-unknown". On systems where
  // the scanner cannot determine the command name, the verdict is still
  // unsafe-unknown because the command would not match any Chrome variant.
  record("unsafe-unknown verdict", "unsafe-unknown", result.verdict.kind);
  await removeLane(lane.id);
  return { server, port };
}

// -----------------------------------------------------------------------

async function main(): Promise<void> {
  const home = await setupTempHome();
  let httpHandle: { server: Server; port: number } | null = null;
  let exitCode = 0;
  try {
    const aliceLane = await scenario1_safeFree();
    await scenario2_safeAttach(aliceLane);
    await scenario3_unsafeForeignChrome();
    httpHandle = await scenario4_unsafeUnknown();

    log("\n--- Final lane snapshot (post-cleanup of synthetic lanes) ---");
    const lanes = await listLanes();
    for (const l of lanes) log(`  ${l.id}  ${l.owner}/${l.project}  port=${l.chromeDebugPort ?? "-"}  status=${l.status}`);

    log("\n--- Summary ---");
    let pass = 0;
    let fail = 0;
    for (const r of results) {
      log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
      if (r.passed) pass++;
      else fail++;
    }
    log(`  ${pass}/${results.length} passed`);
    if (fail > 0) exitCode = 1;
  } catch (err) {
    log(`\nFATAL: ${(err as Error).stack ?? (err as Error).message}`);
    exitCode = 2;
  } finally {
    if (httpHandle) {
      await new Promise<void>((resolve) => httpHandle!.server.close(() => resolve()));
    }
    await teardown(home);
  }
  process.exit(exitCode);
}

void portpilotHome; // ensure the home resolver is wired before tests
void findLane;
void updateRegistry;
main();
