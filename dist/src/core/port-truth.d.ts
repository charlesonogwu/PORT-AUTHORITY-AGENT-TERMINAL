import { type PortProbe } from "./port-probe.js";
import { type PortObservation, type ProcessRecord } from "./scanner.js";
export type { ProcessRecord } from "./scanner.js";
/** Injection points for the kernel probe and the process list (tests). */
export interface PortTruthDependencies {
    probe?: PortProbe;
    listDebugPortProcesses?: () => Promise<ProcessRecord[]>;
}
/**
 * Pick the one main browser process whose command line serves `port`.
 * A launcher that started the browser (cmd.exe, a shell) repeats the flag on
 * its own command line, so when several processes match, the single browser
 * among them wins. Returns undefined when none matches, or when two browsers
 * claim the port: guessing could attach an agent to the wrong profile.
 */
export declare function selectDebugPortOwner(processes: readonly ProcessRecord[], port: number): ProcessRecord | undefined;
/** The program name at the start of a command line ("chrome.exe", "Google Chrome", "firefox"). */
export declare function executableName(commandLine: string): string | undefined;
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
export declare function confirmObservations(ports: Iterable<number | undefined>, observations: readonly PortObservation[], deps?: PortTruthDependencies): Promise<PortObservation[]>;
