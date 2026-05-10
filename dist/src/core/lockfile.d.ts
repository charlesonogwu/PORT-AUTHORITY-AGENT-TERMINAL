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
export declare class LockError extends Error {
    readonly path: string;
    constructor(message: string, path: string);
}
export declare function acquireLock(lockPath: string, opts?: LockOptions): Promise<() => Promise<void>>;
export declare function withLock<T>(lockPath: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T>;
/**
 * Atomically write JSON to `target` by writing a sibling temp file and renaming.
 * On most platforms (POSIX, NTFS) rename is atomic for files on the same volume.
 */
export declare function atomicWriteJson(target: string, data: unknown): Promise<void>;
