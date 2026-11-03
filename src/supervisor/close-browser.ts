import { spawnSync } from "node:child_process";
import { evaluateBrowserAttach } from "../core/browsers.js";
import type { Lane } from "../core/lane.js";
import { scanNative, type ScanResult } from "../core/scanner.js";

export interface CloseBrowserDependencies {
  scan?: () => Promise<ScanResult>;
  terminate?: (pid: number) => Promise<void>;
}

async function terminateTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`browser close failed for pid ${pid}: ${result.stderr?.toString("utf8").trim() || "taskkill failed"}`);
    }
    return;
  }
  process.kill(pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 600));
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

/** Explicitly close one lane browser after a fresh browser/port/profile check. */
export async function closeBrowserForLane(lane: Lane, deps: CloseBrowserDependencies = {}): Promise<boolean> {
  const scanNow = deps.scan ?? (async () => ({ observations: await scanNative(), source: "native" as const, errors: [] }));
  const scan = await scanNow();
  const verdict = evaluateBrowserAttach(lane, scan.observations);
  if (verdict.kind === "safe-free") return false;
  if (verdict.kind !== "safe-attach") {
    throw new Error(`refusing to close lane ${lane.id}: ${verdict.kind}`);
  }
  const pid = verdict.observation.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`refusing to close lane ${lane.id}: matching browser pid is unavailable`);
  }
  if (lane.browserPid !== undefined && lane.browserPid !== pid) {
    throw new Error(
      `refusing to close lane ${lane.id}: recorded pid ${lane.browserPid} does not match observed ${pid}`,
    );
  }
  if (
    lane.browserStartedAt !== undefined &&
    process.platform === "win32" &&
    verdict.observation.processStartedAt === undefined
  ) {
    throw new Error(`refusing to close lane ${lane.id}: browser creation identity is unavailable`);
  }
  if (
    lane.browserStartedAt !== undefined &&
    verdict.observation.processStartedAt !== undefined &&
    lane.browserStartedAt !== verdict.observation.processStartedAt
  ) {
    throw new Error(`refusing to close lane ${lane.id}: browser creation identity changed`);
  }
  // Narrow the scan-to-kill race: identity must still match immediately
  // before termination. A PID that disappeared or was reused fails closed.
  const finalVerdict = evaluateBrowserAttach(lane, (await scanNow()).observations);
  if (
    finalVerdict.kind !== "safe-attach" ||
    finalVerdict.observation.pid !== pid ||
    (verdict.observation.processStartedAt !== undefined &&
      finalVerdict.observation.processStartedAt !== verdict.observation.processStartedAt)
  ) {
    throw new Error(`refusing to close lane ${lane.id}: browser identity changed before termination`);
  }
  await (deps.terminate ?? terminateTree)(pid);
  return true;
}
