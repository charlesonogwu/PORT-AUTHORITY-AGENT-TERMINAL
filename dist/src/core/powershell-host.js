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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_MAX_RUNS = 1_000;
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];
/** The session loop, passed in plain text like the one-off scripts. */
const HOST_SCRIPT = [
    "$ErrorActionPreference = 'Continue'",
    "$__paatUtf8 = New-Object System.Text.UTF8Encoding($false)",
    "$__paatIn = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $__paatUtf8)",
    "$__paatOut = [Console]::OpenStandardOutput()",
    "while ($true) {",
    "  $__paatMarker = $__paatIn.ReadLine()",
    "  if ($null -eq $__paatMarker) { break }",
    "  if ($__paatMarker -eq '') { continue }",
    "  $__paatLines = New-Object System.Collections.Generic.List[string]",
    "  while ($true) {",
    "    $__paatLine = $__paatIn.ReadLine()",
    "    if ($null -eq $__paatLine -or $__paatLine -eq $__paatMarker) { break }",
    "    $__paatLines.Add($__paatLine)",
    "  }",
    "  if ($null -eq $__paatLine) { break }",
    "  $__paatCode = 0",
    "  $__paatText = ''",
    "  try {",
    "    $__paatText = & ([ScriptBlock]::Create($__paatLines -join \"`n\")) | Out-String -Width 8192",
    "  } catch {",
    "    $__paatCode = 1",
    "    [Console]::Error.WriteLine($_.Exception.Message)",
    "  }",
    "  $__paatBytes = $__paatUtf8.GetBytes([string]$__paatText + \"`n\" + $__paatMarker + ' ' + $__paatCode + \"`n\")",
    "  $__paatOut.Write($__paatBytes, 0, $__paatBytes.Length)",
    "  $__paatOut.Flush()",
    "}",
].join("\n");
/** A byte-order mark is never meaningful output; drop one if PowerShell adds it. */
const BOM = String.fromCharCode(0xfeff);
function stripBom(text) {
    return text.startsWith(BOM) ? text.slice(1) : text;
}
/** Find the end-of-reply line for `run` and return the finished result, if it has arrived. */
function completedResult(run) {
    const endTag = `\n${run.marker} `;
    const at = run.stdout.indexOf(endTag);
    if (at < 0)
        return undefined;
    const lineEnd = run.stdout.indexOf("\n", at + endTag.length);
    if (lineEnd < 0)
        return undefined;
    const code = Number(run.stdout.slice(at + endTag.length, lineEnd).trim());
    return {
        stdout: stripBom(run.stdout.slice(0, at)),
        stderr: run.stderr,
        code: Number.isInteger(code) ? code : 1,
    };
}
/** Run one script in its own powershell.exe: the behaviour without a session. */
function runOneOff(script, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", [...POWERSHELL_ARGS, script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut)
                reject(new Error(`PowerShell script timed out after ${timeoutMs}ms`));
            else
                resolve({ stdout, stderr, code: code ?? 1 });
        });
    });
}
export function createPersistentPowerShell(options = {}) {
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    const hostScript = options.hostScript ?? HOST_SCRIPT;
    let child;
    let runsOnChild = 0;
    let pending;
    let idleTimer;
    let tail = Promise.resolve();
    let closed = false;
    /** Set once a session dies on its own before ever answering: it can't work here. */
    let sessionUnusable = false;
    /** Sessions that answered at least once, and sessions we stopped ourselves. */
    const answered = new WeakSet();
    const stoppedByUs = new WeakSet();
    const clearIdle = () => {
        if (idleTimer)
            clearTimeout(idleTimer);
        idleTimer = undefined;
    };
    const stop = () => {
        const proc = child;
        child = undefined;
        runsOnChild = 0;
        if (!proc)
            return;
        stoppedByUs.add(proc);
        proc.stdin.end();
        proc.kill();
    };
    const armIdle = () => {
        clearIdle();
        if (closed || !child || pending)
            return;
        idleTimer = setTimeout(stop, idleMs);
        idleTimer.unref();
    };
    const start = () => {
        const proc = spawn("powershell.exe", [...POWERSHELL_ARGS, hostScript], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        proc.stdout.setEncoding("utf8");
        proc.stderr.setEncoding("utf8");
        proc.stdout.on("data", (chunk) => {
            if (pending?.proc !== proc)
                return;
            pending.stdout += chunk;
            const result = completedResult(pending);
            if (!result)
                return;
            answered.add(proc);
            pending.settle(undefined, result);
        });
        proc.stderr.on("data", (chunk) => {
            if (pending?.proc === proc)
                pending.stderr += chunk;
        });
        // A dead pipe is reported through "exit"/"error" below; never crash the helper over it.
        proc.stdin.on("error", () => { });
        const died = (error) => {
            if (!answered.has(proc) && !stoppedByUs.has(proc))
                sessionUnusable = true;
            if (child === proc) {
                child = undefined;
                runsOnChild = 0;
            }
            if (pending?.proc === proc)
                pending.settle(error);
        };
        proc.on("error", died);
        proc.on("exit", (code) => died(new Error(`PowerShell session exited (code ${code})`)));
        return proc;
    };
    const runInSession = (script, timeoutMs) => {
        clearIdle();
        if (child && runsOnChild >= maxRuns)
            stop();
        const proc = child ?? (child = start());
        runsOnChild += 1;
        const finished = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                run.settle(new Error(`PowerShell script timed out after ${timeoutMs}ms`));
                // The session may be wedged mid-script; replace it rather than wait.
                if (child === proc)
                    stop();
            }, timeoutMs);
            const run = {
                proc,
                marker: `__PAAT_PS_${randomUUID().replace(/-/g, "")}__`,
                stdout: "",
                stderr: "",
                settle: (error, result) => {
                    if (pending !== run)
                        return;
                    pending = undefined;
                    clearTimeout(timer);
                    if (error)
                        reject(error);
                    else
                        resolve(result);
                },
            };
            pending = run;
            const body = script.replace(/\r\n?/g, "\n");
            proc.stdin.write(`${run.marker}\n${body}\n${run.marker}\n`);
        });
        return finished.finally(armIdle);
    };
    const runNow = async (script, timeoutMs) => {
        if (closed)
            throw new Error("PowerShell session is closed");
        if (sessionUnusable)
            return runOneOff(script, timeoutMs);
        try {
            return await runInSession(script, timeoutMs);
        }
        catch (error) {
            // The session refused to start; answer this run the one-off way too.
            if (sessionUnusable && !closed)
                return runOneOff(script, timeoutMs);
            throw error;
        }
    };
    return {
        get pid() {
            return child?.pid;
        },
        run(script, runOptions = {}) {
            if (closed)
                return Promise.reject(new Error("PowerShell session is closed"));
            const timeoutMs = runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const result = tail.then(() => runNow(script, timeoutMs));
            tail = result.catch(() => undefined);
            return result;
        },
        close() {
            closed = true;
            clearIdle();
            pending?.settle(new Error("PowerShell session is closed"));
            stop();
        },
    };
}
