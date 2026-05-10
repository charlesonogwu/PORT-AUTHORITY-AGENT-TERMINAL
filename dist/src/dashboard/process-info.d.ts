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
export interface ProcessRecord {
    pid: number;
    ppid: number;
    name: string;
    commandLine: string;
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
export declare const EMPTY_PROCESS_SNAPSHOT: ProcessSnapshot;
interface RawSnapshot {
    processes: Array<Partial<ProcessRecord>>;
    connections: Array<Partial<TcpConnection>>;
}
/**
 * Run the PowerShell collector and parse the result. Always resolves —
 * never rejects — because partial data is more useful than no data when
 * computing the dashboard snapshot.
 */
export declare function collectProcessSnapshot(opts?: {
    timeoutMs?: number;
}): Promise<ProcessSnapshot>;
/** Pure normaliser — exported for the unit tests. */
export declare function parseSnapshot(raw: RawSnapshot): ProcessSnapshot;
export {};
