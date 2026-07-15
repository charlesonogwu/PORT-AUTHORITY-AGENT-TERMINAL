import { spawn } from "node:child_process";
import { isWindows } from "./paths.js";

/**
 * One observation of a TCP listener on the local machine.
 */
export interface PortObservation {
  port: number;
  pid?: number;
  command?: string;
  commandLine?: string;
  protocol?: "tcp" | "tcp6";
  source: "sonar" | "native";
  raw?: unknown;
}

export interface ScanOptions {
  preferSonar?: boolean;
  includeIpv6?: boolean;
  signal?: AbortSignal;
}

export interface ScanResult {
  observations: PortObservation[];
  source: "sonar" | "native" | "empty";
  errors: string[];
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCommand(cmd: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
    }, opts.timeoutMs ?? 8000);
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Detect whether the user has Sonar installed and on PATH.
 * We probe `sonar --help` rather than `--version` because some builds report a
 * non-zero exit code for `--version`.
 */
export async function hasSonar(): Promise<boolean> {
  try {
    const res = await runCommand("sonar", ["--help"], { timeoutMs: 3000 });
    return res.code === 0 || res.stdout.length > 0;
  } catch {
    return false;
  }
}

interface SonarEntry {
  port?: number;
  pid?: number;
  process?: string;
  command?: string;
  cmdline?: string;
  cmd?: string;
  protocol?: string;
  proto?: string;
}

function parseSonarOutput(stdout: string): PortObservation[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  // Sonar may output an array, an object with `entries`, or NDJSON.
  let entries: SonarEntry[] = [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) entries = parsed as SonarEntry[];
    else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.entries)) entries = obj.entries as SonarEntry[];
      else if (Array.isArray(obj.connections)) entries = obj.connections as SonarEntry[];
      else if (Array.isArray(obj.listeners)) entries = obj.listeners as SonarEntry[];
    }
  } catch {
    // NDJSON
    for (const line of trimmed.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s) as SonarEntry;
        entries.push(e);
      } catch {
        // ignore unparseable lines
      }
    }
  }
  const out: PortObservation[] = [];
  for (const e of entries) {
    const port = typeof e.port === "number" ? e.port : Number(e.port);
    if (!Number.isInteger(port) || port <= 0) continue;
    const protocolRaw = (e.protocol ?? e.proto ?? "tcp").toString().toLowerCase();
    const protocol: "tcp" | "tcp6" = protocolRaw.includes("6") ? "tcp6" : "tcp";
    const obs: PortObservation = {
      port,
      pid: typeof e.pid === "number" ? e.pid : undefined,
      command: e.command ?? e.process ?? e.cmd,
      commandLine: e.cmdline ?? e.cmd,
      protocol,
      source: "sonar",
      raw: e,
    };
    out.push(obs);
  }
  return out;
}

export async function scanWithSonar(opts: ScanOptions = {}): Promise<PortObservation[]> {
  const res = await runCommand("sonar", ["list", "-a", "--json"], { signal: opts.signal, timeoutMs: 8000 });
  if (res.code !== 0 && !res.stdout.trim()) {
    throw new Error(`sonar list failed (code ${res.code}): ${res.stderr.trim()}`);
  }
  return parseSonarOutput(res.stdout);
}

interface ProcessLookup {
  byPid: Map<number, { command?: string; commandLine?: string }>;
}

/** Parse `ps -o pid= -o command=` output without invoking a shell. The command
 * column deliberately stays intact: browser profile flags are what make an
 * attachment safe, so truncating it would be worse than returning nothing. */
export function parseUnixPsOutput(stdout: string): Map<number, { command?: string; commandLine?: string }> {
  const byPid = new Map<number, { command?: string; commandLine?: string }>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = match[2];
    if (!Number.isInteger(pid) || pid <= 0 || !commandLine) continue;
    // lsof already supplies the process name. `command` can begin with an
    // unquoted path containing spaces on macOS, so only trust ps for the full
    // command line used by profile verification.
    byPid.set(pid, { commandLine });
  }
  return byPid;
}

async function lookupUnixProcesses(pids: Iterable<number>): Promise<ProcessLookup> {
  const byPid = new Map<number, { command?: string; commandLine?: string }>();
  const wanted = Array.from(new Set(Array.from(pids).filter((pid) => Number.isInteger(pid) && pid > 0)));
  // Keep argv small on hosts with many listeners. Values are numeric PIDs only;
  // runCommand uses spawn(cmd, args), never a shell.
  for (let start = 0; start < wanted.length; start += 100) {
    const batch = wanted.slice(start, start + 100);
    try {
      const res = await runCommand("ps", ["-ww", "-p", batch.join(","), "-o", "pid=", "-o", "command="], { timeoutMs: 8_000 });
      for (const [pid, meta] of parseUnixPsOutput(res.stdout)) byPid.set(pid, meta);
    } catch {
      // Best effort only. Callers refuse browser attachment without a profile
      // command line, so an unavailable ps can never cause a blind attach.
    }
  }
  return { byPid };
}

async function lookupWindowsProcesses(pids: Iterable<number>): Promise<ProcessLookup> {
  const byPid = new Map<number, { command?: string; commandLine?: string }>();
  const wanted = Array.from(new Set(Array.from(pids).filter((p) => Number.isInteger(p) && p > 0)));
  if (wanted.length === 0) return { byPid };
  const filter = wanted.map((p) => `ProcessId=${p}`).join(" OR ");
  const ps = `Get-CimInstance Win32_Process -Filter "${filter.replace(/"/g, '\\"')}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3`;
  try {
    const res = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeoutMs: 8000 });
    if (!res.stdout.trim()) return { byPid };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { byPid };
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as { ProcessId?: number; Name?: string; CommandLine?: string };
      if (typeof o.ProcessId === "number") {
        byPid.set(o.ProcessId, { command: o.Name, commandLine: o.CommandLine ?? undefined });
      }
    }
  } catch {
    // Best effort — we can still return port/PID without command names.
  }
  return { byPid };
}

async function scanWindowsNative(_opts: ScanOptions): Promise<PortObservation[]> {
  // Get-NetTCPConnection is the modern API; fall back to netstat if missing.
  const ps = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess,LocalAddress | ConvertTo-Json -Compress -Depth 3`;
  let stdout = "";
  try {
    const res = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeoutMs: 8000 });
    stdout = res.stdout;
  } catch {
    // fall through to netstat
  }
  const seen = new Map<string, PortObservation>();
  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const o = item as { LocalPort?: number; OwningProcess?: number; LocalAddress?: string };
        if (typeof o.LocalPort !== "number") continue;
        const protocol: "tcp" | "tcp6" = o.LocalAddress && o.LocalAddress.includes(":") ? "tcp6" : "tcp";
        const key = `${o.LocalPort}:${protocol}:${o.OwningProcess ?? 0}`;
        if (seen.has(key)) continue;
        const obs: PortObservation = { port: o.LocalPort, pid: o.OwningProcess, protocol, source: "native" };
        seen.set(key, obs);
      }
    } catch {
      // fall through
    }
  }
  if (seen.size === 0) {
    try {
      const res = await runCommand("netstat.exe", ["-ano", "-p", "TCP"], { timeoutMs: 6000 });
      for (const line of res.stdout.split(/\r?\n/)) {
        const s = line.trim();
        if (!s.toUpperCase().includes("LISTENING")) continue;
        const parts = s.split(/\s+/);
        if (parts.length < 5) continue;
        const local = parts[1] ?? "";
        const pidStr = parts[parts.length - 1] ?? "";
        const pid = Number(pidStr);
        const portStr = local.split(":").pop();
        const port = portStr ? Number(portStr) : NaN;
        if (!Number.isInteger(port) || port <= 0) continue;
        const protocol: "tcp" | "tcp6" = local.startsWith("[") ? "tcp6" : "tcp";
        const key = `${port}:${protocol}:${Number.isInteger(pid) ? pid : 0}`;
        if (seen.has(key)) continue;
        const obs: PortObservation = { port, pid: Number.isInteger(pid) ? pid : undefined, protocol, source: "native" };
        seen.set(key, obs);
      }
    } catch {
      // give up — return whatever we have
    }
  }
  const observations = Array.from(seen.values());
  const lookup = await lookupWindowsProcesses(observations.map((o) => o.pid).filter((p): p is number => typeof p === "number"));
  for (const obs of observations) {
    if (typeof obs.pid !== "number") continue;
    const meta = lookup.byPid.get(obs.pid);
    if (meta) {
      obs.command = meta.command;
      obs.commandLine = meta.commandLine;
    }
  }
  return observations;
}

async function scanUnixNative(_opts: ScanOptions): Promise<PortObservation[]> {
  // lsof gives us listener PID/name; ps supplies the complete argv needed to
  // prove a Chromium --user-data-dir or Firefox -profile belongs to a lane.
  try {
    const res = await runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeoutMs: 6000 });
    if (res.stdout.trim()) {
      const observations = parseLsofOutput(res.stdout);
      const lookup = await lookupUnixProcesses(observations.map((observation) => observation.pid).filter((pid): pid is number => typeof pid === "number"));
      for (const observation of observations) {
        if (typeof observation.pid !== "number") continue;
        const meta = lookup.byPid.get(observation.pid);
        if (!meta) continue;
        observation.command ??= meta.command;
        observation.commandLine = meta.commandLine;
      }
      return observations;
    }
  } catch {
    // fall through to ss
  }
  try {
    const res = await runCommand("ss", ["-tlnp"], { timeoutMs: 6000 });
    return parseSsOutput(res.stdout);
  } catch {
    return [];
  }
}

function parseLsofOutput(stdout: string): PortObservation[] {
  const out: PortObservation[] = [];
  let pid: number | undefined;
  let command: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      command = undefined;
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n") {
      const m = /:(\d+)(?:\s|$)/.exec(value);
      if (!m) continue;
      const port = Number(m[1]);
      if (!Number.isInteger(port) || port <= 0) continue;
      const protocol: "tcp" | "tcp6" = value.startsWith("[") ? "tcp6" : "tcp";
      out.push({ port, pid, command, protocol, source: "native" });
    }
  }
  return out;
}

function parseSsOutput(stdout: string): PortObservation[] {
  const out: PortObservation[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("State") || s.startsWith("Netid")) continue;
    const cols = s.split(/\s+/);
    if (cols.length < 5) continue;
    const local = cols[3] ?? "";
    const portStr = local.split(":").pop();
    const port = portStr ? Number(portStr) : NaN;
    if (!Number.isInteger(port) || port <= 0) continue;
    const protocol: "tcp" | "tcp6" = local.startsWith("[") || local.includes("::") ? "tcp6" : "tcp";
    let pid: number | undefined;
    let command: string | undefined;
    const procCol = cols.slice(5).join(" ");
    const procMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(procCol);
    if (procMatch) {
      command = procMatch[1] ?? undefined;
      const parsedPid = Number(procMatch[2]);
      pid = Number.isInteger(parsedPid) ? parsedPid : undefined;
    }
    out.push({ port, pid, command, protocol, source: "native" });
  }
  return out;
}

export async function scanNative(opts: ScanOptions = {}): Promise<PortObservation[]> {
  if (isWindows()) return scanWindowsNative(opts);
  return scanUnixNative(opts);
}

/**
 * Run a port scan, preferring sonar when available and falling back to
 * platform-native tooling otherwise. Errors from one backend do not abort the
 * other — we always return the best observation set we could gather.
 */
export async function scanPorts(opts: ScanOptions = {}): Promise<ScanResult> {
  const errors: string[] = [];
  const tryOrder: ("sonar" | "native")[] = opts.preferSonar === false ? ["native"] : ["sonar", "native"];
  for (const backend of tryOrder) {
    try {
      if (backend === "sonar") {
        if (!(await hasSonar())) continue;
        const observations = await scanWithSonar(opts);
        return { observations, source: "sonar", errors };
      }
      const observations = await scanNative(opts);
      return { observations, source: "native", errors };
    } catch (err) {
      errors.push(`${backend}: ${(err as Error).message}`);
    }
  }
  return { observations: [], source: "empty", errors };
}

/**
 * True if any observation occupies the requested port.
 */
export function isPortInUse(observations: PortObservation[], port: number): boolean {
  return observations.some((o) => o.port === port);
}

export function observationsForPort(observations: PortObservation[], port: number): PortObservation[] {
  return observations.filter((o) => o.port === port);
}
