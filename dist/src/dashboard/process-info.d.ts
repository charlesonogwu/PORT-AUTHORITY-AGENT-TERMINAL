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
export declare function sumTreeMemoryMB(rootPid: number, processes: Map<number, ProcessRecord>): number | undefined;
/** Pure normaliser — exported for the unit tests. */
export declare function parseSnapshot(raw: RawSnapshot): ProcessSnapshot;
export {};
