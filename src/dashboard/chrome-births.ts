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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "../core/lockfile.js";
import { portpilotHome } from "../core/paths.js";
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

interface BirthFile {
  version: 1;
  records: BirthRecord[];
}

const TTL_MS = 24 * 60 * 60 * 1000;

export function birthsPath(): string {
  return join(portpilotHome(), "chrome-births.json");
}

function key(chromePid: number, profileDir: string): string {
  return `${chromePid}:${(profileDir || "").toLowerCase()}`;
}

export class BirthRegistry {
  private records = new Map<string, BirthRecord>();
  private dirty = false;

  static empty(): BirthRegistry {
    return new BirthRegistry();
  }

  /** Read the on-disk registry, dropping expired entries. */
  static async load(): Promise<BirthRegistry> {
    const r = new BirthRegistry();
    try {
      const raw = await readFile(birthsPath(), "utf8");
      const data = JSON.parse(raw) as BirthFile;
      const now = Date.now();
      for (const rec of data.records ?? []) {
        if (!Number.isInteger(rec.chromePid) || !rec.profileDir) continue;
        if (!Array.isArray(rec.chain) || rec.chain.length < 1) continue;
        const ageMs = now - new Date(rec.firstSeenAt).getTime();
        if (!Number.isFinite(ageMs) || ageMs > TTL_MS) continue;
        r.records.set(key(rec.chromePid, rec.profileDir), rec);
      }
    } catch {
      // No file yet, or parse error — start clean.
    }
    return r;
  }

  has(chromePid: number, profileDir: string): boolean {
    return this.records.has(key(chromePid, profileDir));
  }

  lookup(chromePid: number, profileDir: string): BirthRecord | undefined {
    return this.records.get(key(chromePid, profileDir));
  }

  /**
   * Record a chrome's birth. First-write wins — once we've captured the
   * parent chain we trust it and don't overwrite it on later snapshots
   * (otherwise a later snapshot where the parent has already died would
   * trash the good data).
   *
   * Returns true when the record was newly added.
   */
  record(chromePid: number, profileDir: string, chain: ProcessRecord[]): boolean {
    if (!chromePid || !profileDir) return false;
    if (chain.length < 2) return false; // need ancestry beyond chrome itself
    const k = key(chromePid, profileDir);
    if (this.records.has(k)) return false;
    this.records.set(k, {
      chromePid,
      profileDir,
      firstSeenAt: new Date().toISOString(),
      chain: chain.map((p) => ({
        pid: p.pid,
        ppid: p.ppid,
        name: p.name,
        commandLine: p.commandLine,
      })),
    });
    this.dirty = true;
    return true;
  }

  /** Force the in-memory registry to disk if there are pending writes. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const data: BirthFile = {
      version: 1,
      records: [...this.records.values()],
    };
    await atomicWriteJson(birthsPath(), data);
    this.dirty = false;
  }

  /** Visible for tests / inspection. */
  size(): number {
    return this.records.size;
  }
}
