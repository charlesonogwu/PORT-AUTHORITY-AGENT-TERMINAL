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
export interface AtomicWriteOptions {
    /** Injectable rename, for tests. Defaults to fs.promises.rename. */
    rename?: (from: string, to: string) => Promise<void>;
    /** Max rename attempts before giving up. Default 10. */
    attempts?: number;
    /** Base backoff between attempts in ms (grows linearly). Default 20. */
    baseDelayMs?: number;
}
/**
 * Rename `tmp` onto `target`, retrying on transient Windows lock errors with a
 * short linear backoff (20ms, 40ms, … by default — ~1.1s total over 10 tries,
 * long enough to ride out an antivirus/indexer scan). Non-transient errors
 * throw immediately. Exported for testing.
 */
export declare function renameWithRetry(tmp: string, target: string, opts?: AtomicWriteOptions): Promise<void>;
/**
 * Atomically write JSON to `target` by writing a sibling temp file and renaming.
 * On POSIX/NTFS the rename is atomic for files on the same volume. On Windows
 * the rename is retried through transient locks (see renameWithRetry), and the
 * temp file is ALWAYS cleaned up if the write or rename ultimately fails — so a
 * momentarily-locked registry can never leave an orphaned `.lanes.json.*.tmp`
 * behind (and the write either lands or surfaces a real error, never silently
 * loses the update).
 */
export declare function atomicWriteJson(target: string, data: unknown, opts?: AtomicWriteOptions): Promise<void>;
