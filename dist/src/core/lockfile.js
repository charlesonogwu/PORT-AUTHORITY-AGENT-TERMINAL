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
        await sleep(retryMs);
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
 * Atomically write JSON to `target` by writing a sibling temp file and renaming.
 * On most platforms (POSIX, NTFS) rename is atomic for files on the same volume.
 */
export async function atomicWriteJson(target, data) {
    await ensureDir(target);
    const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
    const payload = JSON.stringify(data, null, 2);
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, target);
}
function basename(p) {
    return p.split(/[\\/]/).pop() ?? p;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
