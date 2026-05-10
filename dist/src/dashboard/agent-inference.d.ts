/**
 * Identify which LLM agent is driving an "external" Chrome instance —
 * one that didn't go through `paat reserve` / `paat open` first.
 *
 * Three signal sources, in order of strength:
 *
 *   1. Process ancestry. Walk up from chrome.exe via Win32 ParentProcessId.
 *      If any ancestor's name or command line matches a known agent
 *      signature (e.g. node running `codex/main.js`, or `Cursor.exe`),
 *      that's a high-confidence call.
 *
 *   2. CDP WebSocket peer. Whoever is actually driving Chrome is connected
 *      to its --remote-debugging-port via WebSocket. Get-NetTCPConnection
 *      tells us which local PID owns the client side. We then walk THAT
 *      process's ancestry too — the agent often spawns Playwright/
 *      Puppeteer as a child, so the immediate peer is a node process and
 *      its parent is the agent.
 *
 *   3. Profile-path keyword. Last-resort heuristic, kept for compatibility
 *      with the legacy inferOwnerFromProfile path.
 *
 * Returns "external" with confidence "none" when nothing matches. The
 * `evidence` array is human-readable text the dashboard can show on hover
 * so the user understands WHY portpilot thinks it's a particular agent.
 */
import type { ProcessRecord, ProcessSnapshot } from "./process-info.js";
import type { BirthRegistry } from "./chrome-births.js";
export type AgentConfidence = "high" | "medium" | "low" | "none";
export interface AgentInference {
    /** Canonical LLM provider name, or "external" if nothing matched. */
    agent: string;
    confidence: AgentConfidence;
    /** Human-readable reasons for the verdict, ordered most-to-least decisive. */
    evidence: string[];
}
export interface InferArgs {
    /** PID of the chrome.exe parent process. */
    chromePid: number | undefined;
    /** Chrome's --remote-debugging-port. */
    port: number;
    /** Whatever --user-data-dir Chrome is using, if known. */
    profileDir?: string | undefined;
    /**
     * Optional persistent record of who launched this chrome. Captured
     * on first sight by the dashboard and used as a fallback when the
     * live parent chain has decayed (parent process exited).
     */
    births?: BirthRegistry | undefined;
}
/**
 * Pure inference — takes the already-collected process snapshot and
 * returns a verdict. No I/O, fast enough to run for every external
 * Chrome on the box.
 */
export declare function inferAgentFromLiveChrome(args: InferArgs, snap: ProcessSnapshot): AgentInference;
/** Walk pid → parent → grandparent → … up to maxDepth or until a cycle. */
export declare function walkParentChain(pid: number, processes: Map<number, ProcessRecord>, maxDepth: number): ProcessRecord[];
/**
 * Return PIDs that hold an established TCP connection whose REMOTE port is
 * the chrome debug port — i.e. the client side of the WebSocket. Excludes
 * chrome itself and any connection without an owning PID.
 */
export declare function findCdpPeers(port: number, chromePid: number | undefined, connections: import("./process-info.js").TcpConnection[]): number[];
