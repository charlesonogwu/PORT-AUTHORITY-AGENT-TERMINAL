export interface PowerShellRunResult {
    stdout: string;
    stderr: string;
    /** 0 when the script completed, 1 when it threw. */
    code: number;
}
export interface PowerShellRunOptions {
    timeoutMs?: number;
}
export type PowerShellQuery = "ports" | "owners" | "processes" | "debug-processes";
export declare const QUERY_FILE: string;
export interface PowerShellRunner {
    run(script: PowerShellQuery, options?: PowerShellRunOptions): Promise<PowerShellRunResult>;
}
export interface PersistentPowerShell extends PowerShellRunner {
    /** PID of the current long-lived powershell.exe, or undefined while none is running. */
    readonly pid: number | undefined;
    close(): void;
}
export interface PersistentPowerShellOptions {
    /** Stop powershell.exe after this long without work. It restarts on demand. */
    idleMs?: number;
    /** Start a fresh powershell.exe after this many scripts, so a slow leak can't grow forever. */
    maxRuns?: number;
    /** Replaces the session file for tests of startup failure; fallback always uses QUERY_FILE. */
    sessionFile?: string;
}
/** Run one script in its own powershell.exe: the behaviour without a session. */
export declare function runPowerShellQuery(script: PowerShellQuery, timeoutMs: number, signal?: AbortSignal): Promise<PowerShellRunResult>;
export declare function createPersistentPowerShell(options?: PersistentPowerShellOptions): PersistentPowerShell;
