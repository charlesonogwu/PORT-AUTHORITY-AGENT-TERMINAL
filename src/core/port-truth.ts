import { probePort, type PortProbe } from "./port-probe.js";
import { listDebugPortProcesses, type PortObservation, type ProcessRecord } from "./scanner.js";

export type { ProcessRecord } from "./scanner.js";

/** Injection points for the kernel probe and the process list (tests). */
export interface PortTruthDependencies {
  probe?: PortProbe;
  listDebugPortProcesses?: () => Promise<ProcessRecord[]>;
}

/** Browser helper processes inherit the debug-port flag but never own the socket. */
const CHILD_PROCESS_MARKERS: readonly RegExp[] = [/(?:^|\s)--type=/, /(?:^|\s)-contentproc(?=\s|$)/];

function debugPortFlag(port: number): RegExp {
  return new RegExp(`(?:^|\\s)--?remote-debugging-port(?:=|\\s+)"?${port}"?(?=\\s|$)`);
}

/** Browser executables that can own a debug socket (as opposed to a launcher such as cmd.exe). */
const BROWSER_NAME = /chrome|chromium|msedge|microsoft edge|brave|firefox|librewolf|waterfox/i;

/**
 * Pick the one main browser process whose command line serves `port`.
 * A launcher that started the browser (cmd.exe, a shell) repeats the flag on
 * its own command line, so when several processes match, the single browser
 * among them wins. Returns undefined when none matches, or when two browsers
 * claim the port: guessing could attach an agent to the wrong profile.
 */
export function selectDebugPortOwner(processes: readonly ProcessRecord[], port: number): ProcessRecord | undefined {
  const flag = debugPortFlag(port);
  const owners = processes.filter(
    (candidate) => flag.test(candidate.commandLine) && !CHILD_PROCESS_MARKERS.some((marker) => marker.test(candidate.commandLine)),
  );
  if (owners.length <= 1) return owners[0];
  const browsers = owners.filter((candidate) => BROWSER_NAME.test(candidate.name ?? executableName(candidate.commandLine) ?? ""));
  return browsers.length === 1 ? browsers[0] : undefined;
}

/** The program name at the start of a command line ("chrome.exe", "Google Chrome", "firefox"). */
export function executableName(commandLine: string): string | undefined {
  const trimmed = commandLine.trim();
  if (!trimmed) return undefined;
  let program: string;
  if (trimmed.startsWith("\"")) {
    const end = trimmed.indexOf("\"", 1);
    program = end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  } else {
    const firstFlag = /\s-/.exec(trimmed);
    program = firstFlag ? trimmed.slice(0, firstFlag.index) : trimmed;
  }
  const name = program.split(/[\\/]/).pop()?.trim();
  return name || undefined;
}

function observationFor(port: number, owner: ProcessRecord | undefined): PortObservation {
  if (!owner) return { port, protocol: "tcp", source: "native" };
  const command = owner.name ?? executableName(owner.commandLine);
  return {
    port,
    pid: owner.pid,
    ...(command ? { command } : {}),
    commandLine: owner.commandLine,
    ...(owner.startedAt ? { processStartedAt: owner.startedAt } : {}),
    protocol: "tcp",
    source: "native",
  };
}

/**
 * Correct a listener-table snapshot, for the ports a decision depends on,
 * with what the kernel says right now.
 *
 *   - busy but missing from the table → add the browser whose command line
 *     serves that port, or an unidentified holder if no browser claims it
 *   - free according to the kernel    → drop the table's rows for that port
 *   - unknown                         → keep the table's view
 *
 * The listener table can omit live sockets (seen on Windows: a different,
 * partial set of listeners on every call), so "not in the table" must never
 * be read as "free".
 */
export async function confirmObservations(
  ports: Iterable<number | undefined>,
  observations: readonly PortObservation[],
  deps: PortTruthDependencies = {},
): Promise<PortObservation[]> {
  const probe = deps.probe ?? probePort;
  const wanted = [...new Set(
    [...ports].filter((port): port is number => typeof port === "number" && Number.isInteger(port) && port > 0),
  )];
  if (wanted.length === 0) return [...observations];
  const states = await Promise.all(wanted.map(async (port) => ({ port, state: await probe(port) })));
  const free = new Set(states.filter((entry) => entry.state === "free").map((entry) => entry.port));
  const listed = new Set(observations.map((observation) => observation.port));
  const missing = states.filter((entry) => entry.state === "busy" && !listed.has(entry.port)).map((entry) => entry.port);
  const kept = observations.filter((observation) => !free.has(observation.port));
  if (missing.length === 0) return kept;
  let processes: readonly ProcessRecord[] = [];
  try {
    processes = await (deps.listDebugPortProcesses ?? (() => listDebugPortProcesses()))();
  } catch {
    // Without a process list the port is still known to be taken: record an
    // unidentified holder so no caller mistakes it for free.
  }
  return [...kept, ...missing.map((port) => observationFor(port, selectDebugPortOwner(processes, port)))];
}
