/**
 * A long-lived powershell.exe that runs one script after another.
 *
 * Every dashboard refresh needs three PowerShell queries (listening ports,
 * the processes that own them, and the full process table). Starting
 * powershell.exe costs far more than the queries themselves, so the
 * dashboard's helper process keeps one session open and feeds it scripts
 * over stdin instead of starting PowerShell three times per refresh.
 *
 * Wire format, one script at a time (UTF-8 both ways):
 *   request:  "<marker>\n<script lines>\n<marker>\n"
 *   reply:    "<script output>\n<marker> <0|1>\n"   (1 = the script threw)
 * The marker is random per run, so neither a script nor its output can fake
 * the end of a message. Scripts run in their own scope (no variables leak
 * between runs), must not read stdin (it carries the requests), and anything
 * they print with Write-Host becomes part of their output.
 *
 * If the session itself can't start (for example PowerShell's Constrained
 * Language Mode refuses the loop below), every run falls back to a one-off
 * `powershell.exe -Command <script>`, exactly as if no session were used.
 */
export interface PowerShellRunResult {
    stdout: string;
    stderr: string;
    /** 0 when the script completed, 1 when it threw. */
    code: number;
}
export interface PowerShellRunOptions {
    timeoutMs?: number;
}
export interface PowerShellRunner {
    run(script: string, options?: PowerShellRunOptions): Promise<PowerShellRunResult>;
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
    /** Replaces the session loop. Only for tests that need a session which fails to start. */
    hostScript?: string;
}
export declare function createPersistentPowerShell(options?: PersistentPowerShellOptions): PersistentPowerShell;
