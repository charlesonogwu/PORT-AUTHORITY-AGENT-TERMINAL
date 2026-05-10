/**
 * Chrome birth registry — the hard-to-vary identity record.
 *
 * The other inference signals (process ancestry, CDP peer, profile-path
 * keyword) all degrade in predictable ways:
 *
 *   - Ancestry walking dies when the parent process exits between when
 *     Chrome was launched and when we snapshot.
 *   - CDP peer dies when the agent disconnects (Playwright closes the
 *     pipe but leaves Chrome up).
 *   - Profile-path keyword needs the agent to have helpfully named its
 *     profile dir, which most don't.
 *
 * Birth registry fixes the first two by recording WHO LAUNCHED EACH
 * CHROME the first time we see it, and persisting that to disk. Even
 * if the launcher exits ten seconds later, we still know who it was.
 *
 * Hard-to-vary because:
 *   - Doesn't depend on any agent-side cooperation
 *   - Doesn't depend on the agent's profile naming convention
 *   - Doesn't depend on whether Chrome is in port mode or pipe mode
 *   - Survives the launcher exiting
 *   - Records are keyed by (chromePid, profileDir) which is the unique
 *     identity of a Chrome instance
 *
 * The one thing it cannot do: identify Chromes that started BEFORE the
 * dashboard server was running. Mitigation is the autostart hook —
 * portpilot dashboard launches at Windows login, so once installed it
 * captures every chrome.exe launched in the user's session.
 *
 * Persistence: ~/.portpilot/chrome-births.json, atomic-written on flush.
 * TTL: 24h. PIDs get recycled, so a 24h cap keeps the registry small
 * AND prevents stale collisions.
 */
import type { ProcessRecord } from "./process-info.js";
export interface BirthRecord {
    chromePid: number;
    profileDir: string;
    /** ISO timestamp of when the dashboard first observed this chrome. */
    firstSeenAt: string;
    /**
     * Snapshot of chrome's parent chain at first observation. chain[0] is
     * chrome itself; chain[1..] is the ancestry. Each entry retains the
     * full command line so signature matching works against the recorded
     * data exactly the same way it would against live data.
     */
    chain: Array<{
        pid: number;
        ppid: number;
        name: string;
        commandLine: string;
    }>;
}
export declare function birthsPath(): string;
export declare class BirthRegistry {
    private records;
    private dirty;
    static empty(): BirthRegistry;
    /** Read the on-disk registry, dropping expired entries. */
    static load(): Promise<BirthRegistry>;
    has(chromePid: number, profileDir: string): boolean;
    lookup(chromePid: number, profileDir: string): BirthRecord | undefined;
    /**
     * Record a chrome's birth. First-write wins — once we've captured the
     * parent chain we trust it and don't overwrite it on later snapshots
     * (otherwise a later snapshot where the parent has already died would
     * trash the good data).
     *
     * Returns true when the record was newly added.
     */
    record(chromePid: number, profileDir: string, chain: ProcessRecord[]): boolean;
    /** Force the in-memory registry to disk if there are pending writes. */
    flush(): Promise<void>;
    /** Visible for tests / inspection. */
    size(): number;
}
