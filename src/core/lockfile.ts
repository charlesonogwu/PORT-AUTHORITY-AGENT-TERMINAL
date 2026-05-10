import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A simple cross-platform lockfile. We use exclusive create (`wx`) on a
 * sentinel file so that only one process at a time may pass through.
 *
 * On crash, locks are reclaimed automatically once they are older than the
 * configured TTL. We also write the locking process's PID to make stale-lock
 * detection observable to humans.
 */

export interface LockOptions {
  staleMs?: number;
  retryMs?: number;
  timeoutMs?: number;
}

const DEFAULTS: Required<LockOptions> = {
  staleMs: 30_000,
  retryMs: 50,
  timeoutMs: 10_000,
};

export class LockError extends Error {
  constructor(message: string, public readonly path: string) {
    super(message);
    this.name = "LockError";
  }
}

async function ensureDir(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
}

async function tryAcquireOnce(lockPath: string): Promise<boolean> {
  try {
    const fh = await open(lockPath, "wx");
    const payload = JSON.stringify({ pid: process.pid, host: process.platform, at: Date.now() });
    await fh.writeFile(payload, "utf8");
    await fh.close();
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function reclaimIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, "utf8");
    let parsed: { at?: number } = {};
    try {
      parsed = JSON.parse(raw) as { at?: number };
    } catch {
      // Unparseable lock — treat as stale.
    }
    const at = typeof parsed.at === "number" ? parsed.at : 0;
    if (Date.now() - at > staleMs) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  return false;
}

export async function acquireLock(lockPath: string, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const { staleMs, retryMs, timeoutMs } = { ...DEFAULTS, ...opts };
  await ensureDir(lockPath);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (true) {
    if (await tryAcquireOnce(lockPath)) {
      return async () => {
        await rm(lockPath, { force: true });
      };
    }
    attempts++;
    if (attempts % 4 === 0) {
      await reclaimIfStale(lockPath, staleMs);
    }
    if (Date.now() > deadline) {
      throw new LockError(`Could not acquire lock within ${timeoutMs}ms: ${lockPath}`, lockPath);
    }
    await sleep(retryMs);
  }
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const release = await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Atomically write JSON to `target` by writing a sibling temp file and renaming.
 * On most platforms (POSIX, NTFS) rename is atomic for files on the same volume.
 */
export async function atomicWriteJson(target: string, data: unknown): Promise<void> {
  await ensureDir(target);
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(data, null, 2);
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, target);
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
