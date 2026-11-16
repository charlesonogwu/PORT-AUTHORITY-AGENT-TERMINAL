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
import process from "node:process";
import { runPowerShellQuery } from "../core/powershell-host.js";
export const EMPTY_PROCESS_SNAPSHOT = {
    processes: new Map(),
    connections: [],
};
/**
 * Run the PowerShell collector and parse the result. Always resolves —
 * never rejects — because partial data is more useful than no data when
 * computing the dashboard snapshot.
 */
export async function collectProcessSnapshot(opts = {}) {
    if (process.platform !== "win32")
        return EMPTY_PROCESS_SNAPSHOT;
    const timeoutMs = opts.timeoutMs ?? 4000;
    // The dashboard's helper passes its long-lived PowerShell session, so a
    // refresh costs one query instead of a whole powershell.exe start.
    if (opts.powershell) {
        try {
            const result = await opts.powershell.run("processes", { timeoutMs });
            return parseCollectorOutput(result.stdout);
        }
        catch {
            return EMPTY_PROCESS_SNAPSHOT;
        }
    }
    try {
        const result = await runPowerShellQuery("processes", timeoutMs);
        return parseCollectorOutput(result.stdout);
    }
    catch {
        return EMPTY_PROCESS_SNAPSHOT;
    }
}
/** Parse the collector's JSON. Partial data beats no data, so bad output yields an empty snapshot. */
function parseCollectorOutput(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return EMPTY_PROCESS_SNAPSHOT;
    try {
        return parseSnapshot(JSON.parse(trimmed));
    }
    catch {
        return EMPTY_PROCESS_SNAPSHOT;
    }
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
export function sumTreeMemoryMB(rootPid, processes) {
    const root = processes.get(rootPid);
    if (!root)
        return undefined;
    // Build child index once — the map is small (one snapshot).
    const children = new Map();
    for (const p of processes.values()) {
        const list = children.get(p.ppid);
        if (list)
            list.push(p);
        else
            children.set(p.ppid, [p]);
    }
    const visited = new Set();
    let bytes = 0;
    let sawMemory = false;
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (visited.has(cur.pid))
            continue;
        visited.add(cur.pid);
        const mem = cur.memoryBytes ?? 0;
        if (mem > 0)
            sawMemory = true;
        bytes += mem;
        for (const child of children.get(cur.pid) ?? [])
            stack.push(child);
    }
    if (!sawMemory)
        return undefined;
    return Math.round(bytes / (1024 * 1024));
}
/** Pure normaliser — exported for the unit tests. */
export function parseSnapshot(raw) {
    const processes = new Map();
    for (const p of raw.processes ?? []) {
        if (typeof p.pid !== "number" || p.pid <= 0)
            continue;
        processes.set(p.pid, {
            pid: p.pid,
            ppid: typeof p.ppid === "number" ? p.ppid : 0,
            name: typeof p.name === "string" ? p.name : "",
            commandLine: typeof p.commandLine === "string" ? p.commandLine : "",
            memoryBytes: typeof p.memoryBytes === "number" && p.memoryBytes > 0 ? p.memoryBytes : 0,
        });
    }
    const connections = [];
    for (const c of raw.connections ?? []) {
        if (typeof c.localPort !== "number" || typeof c.remotePort !== "number" || typeof c.owningPid !== "number")
            continue;
        connections.push({
            localPort: c.localPort,
            remoteAddress: typeof c.remoteAddress === "string" ? c.remoteAddress : "",
            remotePort: c.remotePort,
            owningPid: c.owningPid,
        });
    }
    return { processes, connections };
}
