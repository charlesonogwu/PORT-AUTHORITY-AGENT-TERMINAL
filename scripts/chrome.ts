#!/usr/bin/env -S node --import=tsx
/**
 * scripts/chrome.ts — reusable Chrome controller that respects portpilot lanes.
 *
 * The flow any agent should follow:
 *   1. portpilot reserve --owner <agent> --cwd <project>
 *   2. tsx scripts/chrome.ts <command> --owner <agent> --cwd <project> [args]
 *
 * The script always calls `checkLane` first, so it will refuse to launch /
 * attach when another process is on the lane's debug port with a different
 * profile (the central safety promise of portpilot).
 *
 * Commands:
 *   launch            launch Chrome bound to the lane's port + profile
 *   attach            verify the lane is attachable (CDP /json/version OK)
 *   nav --url <u>     open the URL in a new tab on the lane's Chrome
 *   tabs              list open tabs as JSON
 *   close-tab --id <i> close a single tab by its CDP target id
 *   status            print everything we know about this lane right now
 *
 * Common flags:
 *   --owner <name>    agent identifier (codex, claude, ...)
 *   --cwd <path>      project working directory (resolves the lane)
 *   --session <id>    parallel session id — different sessions for the same
 *                     (owner, cwd) get different ports + profiles, so one
 *                     agent can run many concurrent Chromes side by side
 *   --headless        pass --headless=new to Chrome on launch
 *   --bin <path>      override Chrome binary
 *   --json            machine-readable output
 *   --timeout-ms <n>  CDP wait timeout (default 8000)
 */

import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { allocateLane, checkLane } from "../src/core/allocator.js";
import { findLane, touchLane, setLaneStatus, updateRegistry } from "../src/core/registry.js";
import { evaluateChromeAttach, launchChromeForLane } from "../src/core/chrome.js";
import { scanPorts } from "../src/core/scanner.js";
import { Lane, nowIso } from "../src/core/lane.js";

interface Args {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [first, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { command: first ?? "status", flags };
}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagBool(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

function fail(json: boolean, message: string, code = 1): never {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  else process.stderr.write(`chrome.ts: ${message}\n`);
  process.exit(code);
}

async function resolveLane(owner: string, cwd: string, sessionId?: string): Promise<Lane> {
  const filter: { owner: string; cwd: string; sessionId?: string } = { owner, cwd };
  if (sessionId) filter.sessionId = sessionId;
  const lane = await findLane(filter);
  if (!lane) {
    const sessionPart = sessionId ? ` --session ${sessionId}` : "";
    throw new Error(`no portpilot lane for owner=${owner} cwd=${cwd}${sessionId ? ` sessionId=${sessionId}` : ""}. Run: portpilot reserve --owner ${owner} --cwd "${cwd}"${sessionPart}`);
  }
  return lane;
}

interface VersionInfo { Browser: string; webSocketDebuggerUrl: string; "User-Agent": string }

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

async function waitForCdp(port: number, totalTimeoutMs: number): Promise<VersionInfo> {
  const deadline = Date.now() + totalTimeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      return await fetchJson<VersionInfo>(`http://127.0.0.1:${port}/json/version`, 1500);
    } catch (err) {
      lastErr = err as Error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`CDP did not come up on port ${port} within ${totalTimeoutMs}ms (last: ${lastErr?.message})`);
}

interface CdpTab { id: string; type: string; title?: string; url?: string; webSocketDebuggerUrl?: string }

async function listTabs(port: number, timeoutMs: number): Promise<CdpTab[]> {
  return fetchJson<CdpTab[]>(`http://127.0.0.1:${port}/json/list`, timeoutMs);
}

async function openTab(port: number, url: string, timeoutMs: number): Promise<CdpTab> {
  // Chrome's HTTP CDP endpoint accepts PUT /json/new?<url>
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} opening tab`);
    return (await res.json()) as CdpTab;
  } finally {
    clearTimeout(t);
  }
}

async function closeTab(port: number, id: string, timeoutMs: number): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/close/${id}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} closing tab`);
  } finally {
    clearTimeout(t);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const json = flagBool(args, "json");
  const owner = flag(args, "owner");
  const cwd = flag(args, "cwd");
  const sessionId = flag(args, "session");
  const timeoutMs = Number(flag(args, "timeout-ms") ?? 8000);

  if (!["status", "version"].includes(args.command) && (!owner || !cwd)) {
    fail(json, "missing --owner and/or --cwd");
  }

  const emit = (payload: unknown): void => {
    if (json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  };

  switch (args.command) {
    case "launch": {
      const lane = await resolveLane(owner!, cwd!, sessionId);
      // Always re-check before any Chrome action — this is the safety gate.
      const result = await checkLane(lane);
      if (result.verdict.kind === "unsafe-foreign-chrome" || result.verdict.kind === "unsafe-unknown") {
        fail(json, `refusing to launch: verdict=${result.verdict.kind}. Run portpilot doctor.`, 3);
      }
      if (result.verdict.kind === "safe-attach") {
        const v = await waitForCdp(lane.chromeDebugPort!, timeoutMs);
        await touchLane(lane.id);
        if (!json) process.stdout.write(`already attached: ${v.Browser} on :${lane.chromeDebugPort}\n`);
        emit({ ok: true, action: "attached", lane, version: v });
        return;
      }
      // safe-free → launch
      await mkdir(lane.chromeProfileDir, { recursive: true });
      const extraArgs: string[] = flagBool(args, "headless") ? ["--headless=new"] : [];
      const launch = await launchChromeForLane(lane, { binaryPath: flag(args, "bin"), extraArgs, dryRun: false });
      const version = await waitForCdp(lane.chromeDebugPort!, timeoutMs);
      await updateRegistry((lanes) => lanes.map((l) => (l.id === lane.id ? { ...l, status: "active", lastSeen: nowIso(), pid: launch.pid ?? l.pid } : l)));
      if (!json) process.stdout.write(`launched: ${version.Browser} (pid=${launch.pid ?? "?"}) on :${lane.chromeDebugPort}\nProfile: ${lane.chromeProfileDir}\n`);
      emit({ ok: true, action: "launched", lane, pid: launch.pid, version });
      return;
    }

    case "attach": {
      const lane = await resolveLane(owner!, cwd!, sessionId);
      const result = await checkLane(lane);
      if (result.verdict.kind !== "safe-attach") {
        fail(json, `cannot attach: verdict=${result.verdict.kind}. Use 'launch' if safe-free, or 'doctor' if unsafe.`, 3);
      }
      const version = await waitForCdp(lane.chromeDebugPort!, timeoutMs);
      await touchLane(lane.id);
      if (!json) process.stdout.write(`attached: ${version.Browser} on :${lane.chromeDebugPort}\n`);
      emit({ ok: true, action: "attached", lane, version });
      return;
    }

    case "nav": {
      const url = flag(args, "url");
      if (!url) fail(json, "missing --url");
      const lane = await resolveLane(owner!, cwd!, sessionId);
      const result = await checkLane(lane);
      if (result.verdict.kind === "unsafe-foreign-chrome" || result.verdict.kind === "unsafe-unknown") {
        fail(json, `refusing to nav: verdict=${result.verdict.kind}`, 3);
      }
      if (result.verdict.kind !== "safe-attach") fail(json, "Chrome not running for this lane; run launch first", 4);
      const tab = await openTab(lane.chromeDebugPort!, url!, timeoutMs);
      await touchLane(lane.id);
      if (!json) process.stdout.write(`opened tab ${tab.id}: ${tab.url ?? url}\n`);
      emit({ ok: true, action: "nav", lane, tab });
      return;
    }

    case "tabs": {
      const lane = await resolveLane(owner!, cwd!, sessionId);
      const tabs = await listTabs(lane.chromeDebugPort!, timeoutMs);
      emit({ ok: true, action: "tabs", lane, tabs });
      if (!json) {
        process.stdout.write(`Tabs on :${lane.chromeDebugPort}\n`);
        for (const t of tabs) process.stdout.write(`  [${t.type}] ${t.id}  ${t.url ?? ""}\n`);
      }
      return;
    }

    case "close-tab": {
      const id = flag(args, "id");
      if (!id) fail(json, "missing --id");
      const lane = await resolveLane(owner!, cwd!, sessionId);
      await closeTab(lane.chromeDebugPort!, id!, timeoutMs);
      if (!json) process.stdout.write(`closed tab ${id}\n`);
      emit({ ok: true, action: "close-tab", lane, tabId: id });
      return;
    }

    case "status": {
      // Verbose status: registry view + scanner view + verdict.
      if (!owner || !cwd) {
        // Self-test: print the live scanner output and known lanes.
        const scan = await scanPorts();
        emit({ ok: true, action: "status", scanSource: scan.source, observations: scan.observations });
        if (!json) {
          process.stdout.write(`scan source: ${scan.source}\nobservations:\n`);
          for (const o of scan.observations) process.stdout.write(`  :${o.port}\t${o.command ?? "?"}\tpid=${o.pid ?? "?"}\n`);
        }
        return;
      }
      const lane = await resolveLane(owner, cwd, sessionId);
      const scan = await scanPorts();
      const verdict = evaluateChromeAttach(lane, scan.observations);
      let cdp: VersionInfo | undefined;
      if (verdict.kind === "safe-attach") {
        try { cdp = await waitForCdp(lane.chromeDebugPort!, 1500); } catch { /* ignore */ }
      }
      emit({ ok: true, action: "status", lane, verdict, cdp, scanSource: scan.source });
      if (!json) {
        process.stdout.write(`lane         ${lane.id}\nowner        ${lane.owner}\nport         ${lane.chromeDebugPort}\nprofile      ${lane.chromeProfileDir}\nverdict      ${verdict.kind}\n`);
        if (cdp) process.stdout.write(`browser      ${cdp.Browser}\n`);
      }
      return;
    }

    case "close": {
      // Soft close: list tabs, close them all. Does not kill the Chrome process.
      const lane = await resolveLane(owner!, cwd!, sessionId);
      const tabs = await listTabs(lane.chromeDebugPort!, timeoutMs).catch(() => [] as CdpTab[]);
      let closed = 0;
      for (const t of tabs) {
        if (t.type !== "page") continue;
        try { await closeTab(lane.chromeDebugPort!, t.id, timeoutMs); closed++; } catch { /* ignore */ }
      }
      await setLaneStatus(lane.id, "released");
      if (!json) process.stdout.write(`closed ${closed} tab(s); lane released. (Chrome process not killed.)\n`);
      emit({ ok: true, action: "close", lane, closed });
      return;
    }

    default:
      fail(json, `unknown command: ${args.command}. Try: launch | attach | nav | tabs | close-tab | status | close`);
  }
}

void spawnSync; // satisfy unused import for tools that strip
main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`chrome.ts: ${msg}\n`);
  process.exit(1);
});
