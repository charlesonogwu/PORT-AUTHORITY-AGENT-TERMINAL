import { BrowserKind, KNOWN_LLM_OWNERS, Lane, LaneStatus, isStale, laneBrowser, laneSessionId, normalizeCwd, ownerSlug, projectSlug } from "../core/lane.js";
import { listLanes } from "../core/registry.js";
import { PortObservation } from "../core/scanner.js";
import { extractUserDataDir, isChromeProcess } from "../core/chrome.js";
import { extractFirefoxProfileDir } from "../core/firefox.js";

/**
 * Where the dashboard sourced this entry. portpilot is the canonical
 * registry; "external" covers any live Chrome process with
 * --remote-debugging-port that didn't go through portpilot's reservation
 * flow (e.g., manually launched, or launched by some other tool we don't
 * know about). Owner for external entries is inferred from the profile
 * path when possible.
 */
export type EntrySource = "portpilot" | "external";

/**
 * Minimal schema we read out of the portpilot registry. Older lanes from
 * before sessionId existed are treated as "default".
 */
export interface UnifiedLane {
  source: "portpilot";
  id: string;
  owner: string;
  project: string;
  cwd: string;
  sessionId: string;
  task?: string;
  appPort?: number;
  chromeDebugPort?: number;
  chromeProfileDir: string;
  browser: BrowserKind;
  browserScript?: string;
  status: LaneStatus;
  createdAt: string;
  lastSeen: string;
  pid?: number;
  notes?: string;
}

export async function readPortpilotLanes(): Promise<UnifiedLane[]> {
  const lanes = await listLanes();
  return lanes.map((l) => toUnified(l));
}

function toUnified(l: Lane): UnifiedLane {
  const out: UnifiedLane = {
    source: "portpilot",
    id: l.id,
    owner: l.owner,
    project: l.project,
    cwd: l.cwd,
    sessionId: laneSessionId(l),
    chromeProfileDir: l.chromeProfileDir,
    browser: laneBrowser(l),
    status: l.status,
    createdAt: l.createdAt,
    lastSeen: l.lastSeen,
  };
  if (l.task !== undefined) out.task = l.task;
  if (l.appPort !== undefined) out.appPort = l.appPort;
  if (l.chromeDebugPort !== undefined) out.chromeDebugPort = l.chromeDebugPort;
  if (l.browserScript !== undefined) out.browserScript = l.browserScript;
  if (l.pid !== undefined) out.pid = l.pid;
  if (l.notes !== undefined) out.notes = l.notes;
  return out;
}

export type ChromeDebugMode = "port" | "pipe";

export interface LiveChrome {
  /** The --remote-debugging-port number, or 0 when debugMode === "pipe". */
  port: number;
  pid?: number;
  command?: string;
  commandLine?: string;
  profileDir?: string;
  /** Which browser this live process is. Absent = "chrome". Edge processes
   *  (msedge) are tagged "edge" — still Chromium/CDP, but tagged so they match
   *  Edge lanes. Firefox live processes are found by findAllAgentFirefoxes and
   *  tagged "firefox"; their port is a WebDriver BiDi endpoint, not CDP. */
  browser?: BrowserKind;
  /**
   * How the agent is talking to Chrome's DevTools Protocol:
   *   "port" — TCP listener on `port`, reachable from the dashboard for
   *            tab enumeration (legacy default).
   *   "pipe" — stdio pipe inherited from the launching process. Used by
   *            modern Playwright / Puppeteer by default. We can SEE the
   *            Chrome instance and infer the agent, but we can't read
   *            its tab list — only the launcher can talk to it.
   */
  debugMode: ChromeDebugMode;
}

/**
 * Pick out every Chromium-family parent process listening with
 * --remote-debugging-port from the scanner's observations. Each one is a
 * candidate for a dashboard entry, regardless of whether portpilot claims it.
 *
 * This is the LEGACY path — only finds Chromes with a TCP debug port.
 * For the broader enumeration that also catches `--remote-debugging-pipe`
 * Chromes (Playwright / Puppeteer default), use `findAllAgentChromes`.
 */
export function findLiveChromes(observations: PortObservation[]): LiveChrome[] {
  const seen = new Set<string>();
  const out: LiveChrome[] = [];
  for (const o of observations) {
    if (!isChromeProcess(o)) continue;
    const cl = o.commandLine ?? "";
    if (!/--remote-debugging-port=/.test(cl)) continue;
    if (/--type=/.test(cl)) continue; // skip helper subprocesses
    const profileDir = extractUserDataDir(cl);
    const key = `${o.port}:${o.pid ?? 0}:${profileDir ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const live: LiveChrome = { port: o.port, debugMode: "port" };
    if (o.pid !== undefined) live.pid = o.pid;
    if (o.command !== undefined) live.command = o.command;
    if (o.commandLine !== undefined) live.commandLine = o.commandLine;
    if (profileDir !== undefined) live.profileDir = profileDir;
    if (isEdgeName(o.command)) live.browser = "edge";
    out.push(live);
  }
  return out;
}

const CHROMIUM_NAMES = new Set([
  "chrome.exe",
  "chromium.exe",
  "msedge.exe",
  "brave.exe",
  "thorium.exe",
  "chrome",
  "chromium",
  "google-chrome",
  "google-chrome-stable",
  "msedge",
  "brave",
]);

function isChromiumProcessName(name: string): boolean {
  return CHROMIUM_NAMES.has((name || "").toLowerCase());
}

/** Edge is Chromium, but lanes distinguish it — tag msedge processes "edge" so
 *  they match Edge lanes (findOwningLane requires browser equality). */
function isEdgeName(name: string | undefined): boolean {
  const n = (name || "").toLowerCase();
  return n === "msedge.exe" || n === "msedge" || n === "microsoft edge" || n.startsWith("microsoft-edge");
}

/**
 * Enumerate every Chromium-family PARENT process on the box and return one
 * LiveChrome for each that's clearly being driven via CDP — whether by TCP
 * port or stdio pipe.
 *
 * Why this exists: many agents (Playwright, Puppeteer, anything calling
 * `chromium.launch()`) start Chrome with `--remote-debugging-pipe` instead
 * of `--remote-debugging-port`. Pipe-mode Chrome opens NO listening port,
 * so the legacy port-scan path above can't see them at all. They're the
 * single biggest blind spot in dashboard coverage.
 *
 * We deliberately filter to "looks driven by an agent":
 *   - Has --remote-debugging-port=N, OR
 *   - Has --remote-debugging-pipe
 * That keeps the user's regular browsing Chrome out of the dashboard.
 *
 * On non-Windows or when the process snapshot is empty, returns []. The
 * caller is expected to fall back to `findLiveChromes` in that case.
 */
export function findAllAgentChromes(snap: { processes: Map<number, { pid: number; ppid: number; name: string; commandLine: string }> }): LiveChrome[] {
  const out: LiveChrome[] = [];
  const seen = new Set<number>();
  for (const proc of snap.processes.values()) {
    if (!isChromiumProcessName(proc.name)) continue;
    const cl = proc.commandLine ?? "";
    if (/--type=/.test(cl)) continue; // helper subprocess (renderer/utility/gpu/zygote)
    const portMatch = /--remote-debugging-port=(\d+)/.exec(cl);
    // Match the literal flag only — reject `--remote-debugging-pipe-token=…`
    // and similar variants that start with the same prefix.
    const hasPipe = /--remote-debugging-pipe(?=\s|$|=)/.test(cl);
    if (!portMatch && !hasPipe) continue; // not an agent-driven Chrome
    if (seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    const profileDir = extractUserDataDir(cl);
    // Prefer port mode when both are present — it's strictly more useful
    // (we can read tabs).
    const live: LiveChrome = portMatch
      ? { port: Number(portMatch[1]), debugMode: "port", pid: proc.pid, command: proc.name, commandLine: cl }
      : { port: 0, debugMode: "pipe", pid: proc.pid, command: proc.name, commandLine: cl };
    if (profileDir !== undefined) live.profileDir = profileDir;
    if (isEdgeName(proc.name)) live.browser = "edge";
    out.push(live);
  }
  return out;
}

const FIREFOX_NAMES = new Set([
  "firefox.exe",
  "firefox",
  "firefox-bin",
  "firefox-esr",
  "librewolf.exe",
  "librewolf",
  "waterfox.exe",
  "waterfox",
]);

function isFirefoxProcessName(name: string): boolean {
  return FIREFOX_NAMES.has((name || "").toLowerCase());
}

/**
 * Enumerate agent-launched Firefox parent processes (ones carrying a
 * `-profile` dir — i.e. a PortPilot lane, never the user's default Firefox).
 * Firefox's `-contentproc` child processes are skipped. The debug port (if
 * present) is a WebDriver BiDi endpoint, so we tag debugMode "port" but the
 * snapshot deliberately does NOT try Chrome CDP against it.
 */
export function findAllAgentFirefoxes(snap: { processes: Map<number, { pid: number; ppid: number; name: string; commandLine: string }> }): LiveChrome[] {
  const out: LiveChrome[] = [];
  const seen = new Set<number>();
  for (const proc of snap.processes.values()) {
    if (!isFirefoxProcessName(proc.name)) continue;
    const cl = proc.commandLine ?? "";
    if (/-contentproc/.test(cl)) continue; // Firefox child (renderer/gpu) process
    const profileDir = extractFirefoxProfileDir(cl);
    if (!profileDir) continue; // only PortPilot-launched Firefoxes carry -profile
    if (seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    const portMatch = /--remote-debugging-port[= ](\d+)/.exec(cl);
    const live: LiveChrome = {
      port: portMatch ? Number(portMatch[1]) : 0,
      debugMode: "port",
      pid: proc.pid,
      command: proc.name,
      commandLine: cl,
      profileDir,
      browser: "firefox",
    };
    out.push(live);
  }
  return out;
}

function profilesEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return normalizeCwd(a).toLowerCase() === normalizeCwd(b).toLowerCase();
}

/**
 * Heuristically guess the agent owner from a Chrome profile directory.
 * Pure best-effort — used when an external Chrome (one not registered in
 * portpilot) shows up. Returns the literal "external" if no known agent
 * name is recognizable. Uses the same canonical list as the allocator so
 * both surfaces stay in sync.
 */
export function inferOwnerFromProfile(profileDir: string | undefined): string {
  if (!profileDir) return "external";
  const lower = profileDir.toLowerCase();
  for (const c of KNOWN_LLM_OWNERS) {
    if (lower.includes(c)) return c;
  }
  return "external";
}

/**
 * Heuristically pick a project slug from a Chrome profile directory.
 */
export function inferProjectFromProfile(profileDir: string | undefined): string {
  if (!profileDir) return "unknown";
  const segments = profileDir.split(/[\\/]/).filter(Boolean);
  const leaf = segments[segments.length - 1] ?? "";
  const dashIdx = leaf.indexOf("-");
  if (dashIdx !== -1) return leaf.slice(dashIdx + 1);
  return leaf || "unknown";
}

/**
 * Tries to infer the project working directory from a Chrome profile path.
 * Heuristics:
 *   1. Profile is INSIDE the project (e.g. "<cwd>/.automation/chrome-profile-codex")
 *      → return the cwd by walking up until we leave the .automation segment.
 *   2. Otherwise we have no way to know — return undefined.
 */
export function inferCwdFromProfile(profileDir: string | undefined): string | undefined {
  if (!profileDir) return undefined;
  const norm = normalizeCwd(profileDir);
  const lower = norm.toLowerCase();
  const automationIdx = lower.indexOf("\\.automation\\");
  if (automationIdx !== -1) return norm.slice(0, automationIdx);
  const altIdx = lower.indexOf("/.automation/");
  if (altIdx !== -1) return norm.slice(0, altIdx);
  return undefined;
}

export interface MergedEntryInput {
  lane?: UnifiedLane;
  live?: LiveChrome;
  source: EntrySource;
}

/**
 * Build the merged list of entries the dashboard will render. Each entry is
 * either:
 *   • a portpilot-registered lane with optional live Chrome
 *   • an external live Chrome with no portpilot registration (owner inferred)
 *
 * Live Chromes are matched to lanes by debug port + profile path.
 */
export function mergeSources(
  portpilotLanes: UnifiedLane[],
  liveChromes: LiveChrome[],
): MergedEntryInput[] {
  const out: MergedEntryInput[] = [];
  const matchedLaneIds = new Set<string>();

  for (const live of liveChromes) {
    const lane = portpilotLanes.find(
      (l) => l.chromeDebugPort === live.port && profilesEqual(l.chromeProfileDir, live.profileDir),
    );
    if (lane) {
      matchedLaneIds.add(lane.id);
      out.push({ lane, live, source: "portpilot" });
    } else {
      out.push({ live, source: "external" });
    }
  }

  for (const l of portpilotLanes) {
    if (matchedLaneIds.has(l.id)) continue;
    out.push({ lane: l, source: "portpilot" });
  }

  return out;
}

void ownerSlug; // keep export consistent with callers that may use it
void isStale;
void projectSlug;
