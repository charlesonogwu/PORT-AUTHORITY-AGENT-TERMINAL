/**
 * One-shot collector for the data agent-inference needs:
 *
 *   - All processes on the box, with PID, PPID, name, and command line.
 *   - All established TCP connections, with local/remote port and the
 *     owning PID on this side.
 *
 * Both come from a single PowerShell round-trip to keep snapshot latency
 * predictable. We shell out once per dashboard refresh (~every 2s) rather
 * than once per Chrome instance — Win32_Process listing is the slow bit
 * (~200-500ms) so amortising it across the whole snapshot matters.
 *
 * On non-Windows we return an empty snapshot (no inference possible).
 * Inference falls back to the legacy profile-keyword heuristic.
 */

import { spawn } from "node:child_process";
import process from "node:process";

export interface ProcessRecord {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
  /** Working-set size in bytes. Powers the dashboard's per-lane RAM column.
   *  Optional: absent/0 when unavailable (non-Windows, synthetic records). */
  memoryBytes?: number;
}

export interface TcpConnection {
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  owningPid: number;
}

export interface ProcessSnapshot {
  /** PID → process record. */
  processes: Map<number, ProcessRecord>;
  /** Established TCP connections, both halves of each loopback link. */
  connections: TcpConnection[];
}

export const EMPTY_PROCESS_SNAPSHOT: ProcessSnapshot = {
  processes: new Map(),
  connections: [],
};

/**
 * The PowerShell script we run. Emits one JSON object on stdout. Wrapped
 * in -ErrorAction SilentlyContinue so individual process / connection
 * lookups that get denied don't kill the whole listing — we'd rather get
 * partial data than no data.
 */
const COLLECT_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {",
  "  [pscustomobject]@{",
  "    pid = [int]$_.ProcessId",
  "    ppid = [int]$_.ParentProcessId",
  "    name = $_.Name",
  "    commandLine = $_.CommandLine",
  "    memoryBytes = [int64]$_.WorkingSetSize",
  "  }",
  "}",
  "$conns = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | ForEach-Object {",
  "  [pscustomobject]@{",
  "    localPort = [int]$_.LocalPort",
  "    remoteAddress = [string]$_.RemoteAddress",
  "    remotePort = [int]$_.RemotePort",
  "    owningPid = [int]$_.OwningProcess",
  "  }",
  "}",
  "$out = [pscustomobject]@{ processes = @($procs); connections = @($conns) }",
  "$out | ConvertTo-Json -Depth 4 -Compress",
].join("\n");

interface RawSnapshot {
  processes: Array<Partial<ProcessRecord>>;
  connections: Array<Partial<TcpConnection>>;
}

/**
 * Run the PowerShell collector and parse the result. Always resolves —
 * never rejects — because partial data is more useful than no data when
 * computing the dashboard snapshot.
 */
export async function collectProcessSnapshot(opts: { timeoutMs?: number } = {}): Promise<ProcessSnapshot> {
  if (process.platform !== "win32") return EMPTY_PROCESS_SNAPSHOT;
  const timeoutMs = opts.timeoutMs ?? 4000;

  return new Promise<ProcessSnapshot>((resolve) => {
    let settled = false;
    const settle = (v: ProcessSnapshot): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", COLLECT_SCRIPT],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch {
      settle(EMPTY_PROCESS_SNAPSHOT);
      return;
    }

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      settle(EMPTY_PROCESS_SNAPSHOT);
    }, timeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      settle(EMPTY_PROCESS_SNAPSHOT);
    });

    child.on("close", () => {
      clearTimeout(timer);
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return settle(EMPTY_PROCESS_SNAPSHOT);
        const raw = JSON.parse(trimmed) as RawSnapshot;
        settle(parseSnapshot(raw));
      } catch {
        settle(EMPTY_PROCESS_SNAPSHOT);
      }
    });
  });
}

/**
 * Sum the working-set memory of a process AND all its descendants, in MB.
 * This is what a browser lane actually costs: the parent browser process
 * plus every renderer/GPU/utility child it spawned. Returns undefined when
 * the snapshot has no memory data (non-Windows, or the root is unknown) so
 * callers can distinguish "0 MB" from "don't know".
 *
 * Cycle-safe: a visited set guards against pathological ppid loops (PID
 * reuse can make a descendant appear to parent an ancestor).
 */
export function sumTreeMemoryMB(rootPid: number, processes: Map<number, ProcessRecord>): number | undefined {
  const root = processes.get(rootPid);
  if (!root) return undefined;
  // Build child index once — the map is small (one snapshot).
  const children = new Map<number, ProcessRecord[]>();
  for (const p of processes.values()) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const visited = new Set<number>();
  let bytes = 0;
  let sawMemory = false;
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur.pid)) continue;
    visited.add(cur.pid);
    const mem = cur.memoryBytes ?? 0;
    if (mem > 0) sawMemory = true;
    bytes += mem;
    for (const child of children.get(cur.pid) ?? []) stack.push(child);
  }
  if (!sawMemory) return undefined;
  return Math.round(bytes / (1024 * 1024));
}

/** Pure normaliser — exported for the unit tests. */
export function parseSnapshot(raw: RawSnapshot): ProcessSnapshot {
  const processes = new Map<number, ProcessRecord>();
  for (const p of raw.processes ?? []) {
    if (typeof p.pid !== "number" || p.pid <= 0) continue;
    processes.set(p.pid, {
      pid: p.pid,
      ppid: typeof p.ppid === "number" ? p.ppid : 0,
      name: typeof p.name === "string" ? p.name : "",
      commandLine: typeof p.commandLine === "string" ? p.commandLine : "",
      memoryBytes: typeof p.memoryBytes === "number" && p.memoryBytes > 0 ? p.memoryBytes : 0,
    });
  }
  const connections: TcpConnection[] = [];
  for (const c of raw.connections ?? []) {
    if (typeof c.localPort !== "number" || typeof c.remotePort !== "number" || typeof c.owningPid !== "number") continue;
    connections.push({
      localPort: c.localPort,
      remoteAddress: typeof c.remoteAddress === "string" ? c.remoteAddress : "",
      remotePort: c.remotePort,
      owningPid: c.owningPid,
    });
  }
  return { processes, connections };
}
