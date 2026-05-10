import { spawn } from "node:child_process";
import { isWindows } from "./paths.js";
function runCommand(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: opts.signal });
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => {
            child.kill();
        }, opts.timeoutMs ?? 8000);
        child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
        child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
        child.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        child.on("close", (code) => {
            clearTimeout(timeout);
            resolve({ stdout, stderr, code });
        });
    });
}
/**
 * Detect whether the user has Sonar installed and on PATH.
 * We probe `sonar --help` rather than `--version` because some builds report a
 * non-zero exit code for `--version`.
 */
export async function hasSonar() {
    try {
        const res = await runCommand("sonar", ["--help"], { timeoutMs: 3000 });
        return res.code === 0 || res.stdout.length > 0;
    }
    catch {
        return false;
    }
}
function parseSonarOutput(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return [];
    // Sonar may output an array, an object with `entries`, or NDJSON.
    let entries = [];
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed))
            entries = parsed;
        else if (parsed && typeof parsed === "object") {
            const obj = parsed;
            if (Array.isArray(obj.entries))
                entries = obj.entries;
            else if (Array.isArray(obj.connections))
                entries = obj.connections;
            else if (Array.isArray(obj.listeners))
                entries = obj.listeners;
        }
    }
    catch {
        // NDJSON
        for (const line of trimmed.split(/\r?\n/)) {
            const s = line.trim();
            if (!s)
                continue;
            try {
                const e = JSON.parse(s);
                entries.push(e);
            }
            catch {
                // ignore unparseable lines
            }
        }
    }
    const out = [];
    for (const e of entries) {
        const port = typeof e.port === "number" ? e.port : Number(e.port);
        if (!Number.isInteger(port) || port <= 0)
            continue;
        const protocolRaw = (e.protocol ?? e.proto ?? "tcp").toString().toLowerCase();
        const protocol = protocolRaw.includes("6") ? "tcp6" : "tcp";
        const obs = {
            port,
            pid: typeof e.pid === "number" ? e.pid : undefined,
            command: e.command ?? e.process ?? e.cmd,
            commandLine: e.cmdline ?? e.cmd,
            protocol,
            source: "sonar",
            raw: e,
        };
        out.push(obs);
    }
    return out;
}
export async function scanWithSonar(opts = {}) {
    const res = await runCommand("sonar", ["list", "-a", "--json"], { signal: opts.signal, timeoutMs: 8000 });
    if (res.code !== 0 && !res.stdout.trim()) {
        throw new Error(`sonar list failed (code ${res.code}): ${res.stderr.trim()}`);
    }
    return parseSonarOutput(res.stdout);
}
async function lookupWindowsProcesses(pids) {
    const byPid = new Map();
    const wanted = Array.from(new Set(Array.from(pids).filter((p) => Number.isInteger(p) && p > 0)));
    if (wanted.length === 0)
        return { byPid };
    const filter = wanted.map((p) => `ProcessId=${p}`).join(" OR ");
    const ps = `Get-CimInstance Win32_Process -Filter "${filter.replace(/"/g, '\\"')}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3`;
    try {
        const res = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeoutMs: 8000 });
        if (!res.stdout.trim())
            return { byPid };
        let parsed;
        try {
            parsed = JSON.parse(res.stdout);
        }
        catch {
            return { byPid };
        }
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of arr) {
            if (!item || typeof item !== "object")
                continue;
            const o = item;
            if (typeof o.ProcessId === "number") {
                byPid.set(o.ProcessId, { command: o.Name, commandLine: o.CommandLine ?? undefined });
            }
        }
    }
    catch {
        // Best effort — we can still return port/PID without command names.
    }
    return { byPid };
}
async function scanWindowsNative(_opts) {
    // Get-NetTCPConnection is the modern API; fall back to netstat if missing.
    const ps = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess,LocalAddress | ConvertTo-Json -Compress -Depth 3`;
    let stdout = "";
    try {
        const res = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeoutMs: 8000 });
        stdout = res.stdout;
    }
    catch {
        // fall through to netstat
    }
    const seen = new Map();
    if (stdout.trim()) {
        try {
            const parsed = JSON.parse(stdout);
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of arr) {
                if (!item || typeof item !== "object")
                    continue;
                const o = item;
                if (typeof o.LocalPort !== "number")
                    continue;
                const protocol = o.LocalAddress && o.LocalAddress.includes(":") ? "tcp6" : "tcp";
                const key = `${o.LocalPort}:${protocol}:${o.OwningProcess ?? 0}`;
                if (seen.has(key))
                    continue;
                const obs = { port: o.LocalPort, pid: o.OwningProcess, protocol, source: "native" };
                seen.set(key, obs);
            }
        }
        catch {
            // fall through
        }
    }
    if (seen.size === 0) {
        try {
            const res = await runCommand("netstat.exe", ["-ano", "-p", "TCP"], { timeoutMs: 6000 });
            for (const line of res.stdout.split(/\r?\n/)) {
                const s = line.trim();
                if (!s.toUpperCase().includes("LISTENING"))
                    continue;
                const parts = s.split(/\s+/);
                if (parts.length < 5)
                    continue;
                const local = parts[1] ?? "";
                const pidStr = parts[parts.length - 1] ?? "";
                const pid = Number(pidStr);
                const portStr = local.split(":").pop();
                const port = portStr ? Number(portStr) : NaN;
                if (!Number.isInteger(port) || port <= 0)
                    continue;
                const protocol = local.startsWith("[") ? "tcp6" : "tcp";
                const key = `${port}:${protocol}:${Number.isInteger(pid) ? pid : 0}`;
                if (seen.has(key))
                    continue;
                const obs = { port, pid: Number.isInteger(pid) ? pid : undefined, protocol, source: "native" };
                seen.set(key, obs);
            }
        }
        catch {
            // give up — return whatever we have
        }
    }
    const observations = Array.from(seen.values());
    const lookup = await lookupWindowsProcesses(observations.map((o) => o.pid).filter((p) => typeof p === "number"));
    for (const obs of observations) {
        if (typeof obs.pid !== "number")
            continue;
        const meta = lookup.byPid.get(obs.pid);
        if (meta) {
            obs.command = meta.command;
            obs.commandLine = meta.commandLine;
        }
    }
    return observations;
}
async function scanUnixNative(_opts) {
    // lsof gives us process info in one call.
    try {
        const res = await runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeoutMs: 6000 });
        if (res.stdout.trim()) {
            return parseLsofOutput(res.stdout);
        }
    }
    catch {
        // fall through to ss
    }
    try {
        const res = await runCommand("ss", ["-tlnp"], { timeoutMs: 6000 });
        return parseSsOutput(res.stdout);
    }
    catch {
        return [];
    }
}
function parseLsofOutput(stdout) {
    const out = [];
    let pid;
    let command;
    for (const line of stdout.split(/\r?\n/)) {
        if (!line)
            continue;
        const tag = line[0];
        const value = line.slice(1);
        if (tag === "p") {
            pid = Number(value);
            command = undefined;
        }
        else if (tag === "c") {
            command = value;
        }
        else if (tag === "n") {
            const m = /:(\d+)(?:\s|$)/.exec(value);
            if (!m)
                continue;
            const port = Number(m[1]);
            if (!Number.isInteger(port) || port <= 0)
                continue;
            const protocol = value.startsWith("[") ? "tcp6" : "tcp";
            out.push({ port, pid, command, protocol, source: "native" });
        }
    }
    return out;
}
function parseSsOutput(stdout) {
    const out = [];
    for (const line of stdout.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith("State") || s.startsWith("Netid"))
            continue;
        const cols = s.split(/\s+/);
        if (cols.length < 5)
            continue;
        const local = cols[3] ?? "";
        const portStr = local.split(":").pop();
        const port = portStr ? Number(portStr) : NaN;
        if (!Number.isInteger(port) || port <= 0)
            continue;
        const protocol = local.startsWith("[") || local.includes("::") ? "tcp6" : "tcp";
        let pid;
        let command;
        const procCol = cols.slice(5).join(" ");
        const procMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(procCol);
        if (procMatch) {
            command = procMatch[1] ?? undefined;
            const parsedPid = Number(procMatch[2]);
            pid = Number.isInteger(parsedPid) ? parsedPid : undefined;
        }
        out.push({ port, pid, command, protocol, source: "native" });
    }
    return out;
}
export async function scanNative(opts = {}) {
    if (isWindows())
        return scanWindowsNative(opts);
    return scanUnixNative(opts);
}
/**
 * Run a port scan, preferring sonar when available and falling back to
 * platform-native tooling otherwise. Errors from one backend do not abort the
 * other — we always return the best observation set we could gather.
 */
export async function scanPorts(opts = {}) {
    const errors = [];
    const tryOrder = opts.preferSonar === false ? ["native"] : ["sonar", "native"];
    for (const backend of tryOrder) {
        try {
            if (backend === "sonar") {
                if (!(await hasSonar()))
                    continue;
                const observations = await scanWithSonar(opts);
                return { observations, source: "sonar", errors };
            }
            const observations = await scanNative(opts);
            return { observations, source: "native", errors };
        }
        catch (err) {
            errors.push(`${backend}: ${err.message}`);
        }
    }
    return { observations: [], source: "empty", errors };
}
/**
 * True if any observation occupies the requested port.
 */
export function isPortInUse(observations, port) {
    return observations.some((o) => o.port === port);
}
export function observationsForPort(observations, port) {
    return observations.filter((o) => o.port === port);
}
