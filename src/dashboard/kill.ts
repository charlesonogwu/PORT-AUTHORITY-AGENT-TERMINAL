/**
 * Process termination for the dashboard's "kill" button.
 *
 * Safety contract:
 *   - Refuses to kill a pid we cannot identify as a Chromium-family process.
 *     The check happens against a fresh port scan, so even if the dashboard's
 *     UI is showing slightly stale data, we won't terminate the wrong pid.
 *   - Never kills automatically. This module is invoked only from a POST
 *     handler that exists to serve a deliberate user click.
 *   - When the killed Chrome's port + profile match a portpilot lane, the
 *     lane is marked released so the registry stays consistent. External
 *     Chromes (any process not in portpilot's registry) are killed without
 *     registry mutation.
 */

import { spawn, spawnSync } from "node:child_process";
import { setLaneStatus, listLanes } from "../core/registry.js";
import { scanPorts } from "../core/scanner.js";
import { extractUserDataDir, isChromeProcess } from "../core/chrome.js";
import { normalizeCwd } from "../core/lane.js";

export interface KillResult {
  ok: boolean;
  error?: string;
  killed?: { pid: number; command?: string; port?: number; profileDir?: string };
  releasedLaneId?: string;
}

function profilesEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeCwd(a).toLowerCase() === normalizeCwd(b).toLowerCase();
}

function killWindowsTree(pid: number): { ok: boolean; stderr: string } {
  // /T = whole process tree (Chrome spawns many helper processes).
  // /F = force, no graceful shutdown — necessary because Chrome doesn't
  //      respond to SIGTERM equivalent on Windows in a useful timeframe.
  const r = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    stderr: r.stderr ? r.stderr.toString("utf8") : "",
  };
}

async function killUnix(pid: number): Promise<{ ok: boolean; stderr: string }> {
  // SIGTERM first; if still alive after a beat, SIGKILL.
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    return { ok: false, stderr: (err as Error).message };
  }
  await new Promise((r) => setTimeout(r, 600));
  try {
    process.kill(pid, 0); // existence check
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited — that's success.
  }
  return { ok: true, stderr: "" };
}

void spawn; // satisfy unused export check for downstream consumers

/**
 * Verify-and-kill a pid claimed to be an agent-driven Chrome.
 * Order:
 *   1. Re-scan TCP listeners. The pid must show up as a listening port owner.
 *   2. The owning command must be Chromium-family (chrome, chromium, edge, brave).
 *      Anything else: refuse.
 *   3. Capture port + profile path BEFORE killing (so we can match the lane
 *      after the process is gone).
 *   4. Cross-platform terminate.
 *   5. If a portpilot lane matches the killed Chrome's (port, profile),
 *      release it so the registry doesn't keep stale "active" rows.
 */
export async function killChromeByPid(pid: number): Promise<KillResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: `invalid pid: ${pid}` };
  }

  const scan = await scanPorts();
  const obs = scan.observations.find((o) => o.pid === pid);
  if (!obs) {
    return { ok: false, error: `pid ${pid} is not a process we can see listening on a port — refusing to kill` };
  }
  if (!isChromeProcess(obs)) {
    return {
      ok: false,
      error: `pid ${pid} is "${obs.command ?? "unknown"}", not a Chromium-family process — refusing to kill`,
    };
  }

  const port = obs.port;
  const profileDir = extractUserDataDir(obs.commandLine);

  const result = process.platform === "win32" ? killWindowsTree(pid) : await killUnix(pid);
  if (!result.ok) {
    return { ok: false, error: `kill failed: ${result.stderr.trim() || "(no stderr)"}` };
  }

  // Best-effort lane bookkeeping: if a portpilot lane points at this exact
  // port+profile, mark it released. This keeps the registry honest.
  let releasedLaneId: string | undefined;
  try {
    const lanes = await listLanes();
    const lane = lanes.find(
      (l) =>
        l.chromeDebugPort === port &&
        profilesEqual(l.chromeProfileDir, profileDir) &&
        l.status !== "released",
    );
    if (lane) {
      await setLaneStatus(lane.id, "released");
      releasedLaneId = lane.id;
    }
  } catch {
    // Registry mutation is non-essential — the process is already dead.
  }

  const killed: NonNullable<KillResult["killed"]> = { pid };
  if (obs.command !== undefined) killed.command = obs.command;
  if (port !== undefined) killed.port = port;
  if (profileDir !== undefined) killed.profileDir = profileDir;

  const out: KillResult = { ok: true, killed };
  if (releasedLaneId !== undefined) out.releasedLaneId = releasedLaneId;
  return out;
}
