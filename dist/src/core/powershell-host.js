/** Fixed dashboard queries over stdin; script text is never accepted. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const QUERIES = ["ports", "owners", "processes", "debug-processes"];
// tsx runs src/core; the published build runs dist/src/core.
export const QUERY_FILE = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../scripts/dashboard-queries.ps1" : "../../../scripts/dashboard-queries.ps1", import.meta.url));
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_MAX_RUNS = 1_000;
// Applies only to this child process; never changes the machine's policy.
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
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
export function runPowerShellQuery(script, timeoutMs, signal) {
    if (!QUERIES.includes(script))
        return Promise.reject(new Error("Unknown PowerShell query"));
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", [...POWERSHELL_ARGS, QUERY_FILE, "-Query", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal });
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
    const sessionFile = options.sessionFile ?? QUERY_FILE;
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
        const proc = spawn("powershell.exe", [...POWERSHELL_ARGS, sessionFile], {
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
            proc.stdin.write(`${run.marker} ${script}\n`);
        });
        return finished.finally(armIdle);
    };
    const runNow = async (script, timeoutMs) => {
        if (closed)
            throw new Error("PowerShell session is closed");
        if (sessionUnusable)
            return runPowerShellQuery(script, timeoutMs);
        try {
            return await runInSession(script, timeoutMs);
        }
        catch (error) {
            // The session refused to start; answer this run the one-off way too.
            if (sessionUnusable && !closed)
                return runPowerShellQuery(script, timeoutMs);
            throw error;
        }
    };
    return {
        get pid() {
            return child?.pid;
        },
        run(script, runOptions = {}) {
            if (!QUERIES.includes(script))
                return Promise.reject(new Error("Unknown PowerShell query"));
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
