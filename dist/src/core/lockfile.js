import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const DEFAULTS = {
    staleMs: 30_000,
    retryMs: 50,
    timeoutMs: 10_000,
};
export class LockError extends Error {
    path;
    constructor(message, path) {
        super(message);
        this.path = path;
        this.name = "LockError";
    }
}
async function ensureDir(file) {
    await mkdir(dirname(file), { recursive: true });
}
async function tryAcquireOnce(lockPath) {
    try {
        const fh = await open(lockPath, "wx");
        const payload = JSON.stringify({ pid: process.pid, host: process.platform, at: Date.now() });
        await fh.writeFile(payload, "utf8");
        await fh.close();
        return true;
    }
    catch (err) {
        if (err.code === "EEXIST")
            return false;
        throw err;
    }
}
async function reclaimIfStale(lockPath, staleMs) {
    try {
        const raw = await readFile(lockPath, "utf8");
        let parsed = {};
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            // Unparseable lock — treat as stale.
        }
        const at = typeof parsed.at === "number" ? parsed.at : 0;
        if (Date.now() - at > staleMs) {
            await rm(lockPath, { force: true });
            return true;
        }
    }
    catch (err) {
        if (err.code === "ENOENT")
            return false;
        throw err;
    }
    return false;
}
export async function acquireLock(lockPath, opts = {}) {
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
        // Jitter prevents a large burst of independent CLI/MCP processes from
        // waking on the same fixed cadence and repeatedly colliding.
        await sleep(retryMs + Math.floor(Math.random() * Math.max(1, retryMs)));
    }
}
export async function withLock(lockPath, fn, opts = {}) {
    const release = await acquireLock(lockPath, opts);
    try {
        return await fn();
    }
    finally {
        await release();
    }
}
/**
 * Windows can fail an otherwise-atomic rename with a transient error when the
 * destination file is momentarily locked by another handle — antivirus, the
 * Search indexer, the dashboard reading the registry, or a second PortPilot
 * process. POSIX does not hit this. These are the codes worth a brief retry;
 * anything else is a real error and fails fast.
 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/**
 * Rename `tmp` onto `target`, retrying on transient Windows lock errors with a
 * short linear backoff (20ms, 40ms, … by default — ~1.1s total over 10 tries,
 * long enough to ride out an antivirus/indexer scan). Non-transient errors
 * throw immediately. Exported for testing.
 */
export async function renameWithRetry(tmp, target, opts = {}) {
    const doRename = opts.rename ?? rename;
    const attempts = opts.attempts ?? 10;
    const baseDelayMs = opts.baseDelayMs ?? 20;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            await doRename(tmp, target);
            return;
        }
        catch (err) {
            lastErr = err;
            const code = err.code ?? "";
            if (!RENAME_RETRY_CODES.has(code))
                throw err; // real error → fail fast
            await sleep(baseDelayMs * (i + 1));
        }
    }
    throw lastErr;
}
/**
 * Atomically write JSON to `target` by writing a sibling temp file and renaming.
 * On POSIX/NTFS the rename is atomic for files on the same volume. On Windows
 * the rename is retried through transient locks (see renameWithRetry), and the
 * temp file is ALWAYS cleaned up if the write or rename ultimately fails — so a
 * momentarily-locked registry can never leave an orphaned `.lanes.json.*.tmp`
 * behind (and the write either lands or surfaces a real error, never silently
 * loses the update).
 */
export async function atomicWriteJson(target, data, opts = {}) {
    await ensureDir(target);
    const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
        await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
        await renameWithRetry(tmp, target, opts);
    }
    catch (err) {
        await rm(tmp, { force: true }).catch(() => { });
        throw err;
    }
}
function basename(p) {
    return p.split(/[\\/]/).pop() ?? p;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
