import { connect, createServer } from "node:net";

/**
 * What the kernel says, right now, about one local TCP port.
 *
 *   - `busy`    — something accepts connections there, or the OS will not let
 *                 us bind it (held exclusively, or inside a reserved range).
 *   - `free`    — nothing answered and we could bind it ourselves.
 *   - `unknown` — the probe could not decide (bad port number, or every bind
 *                 failed for an unrelated reason such as running out of
 *                 sockets). Callers fall back to the listener table.
 */
export type PortProbeResult = "busy" | "free" | "unknown";

export type PortProbe = (port: number) => Promise<PortProbeResult>;

const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;

/** Bind failures that mean another socket holds the port, or the OS reserves it. */
const BIND_BUSY_CODES = new Set(["EADDRINUSE", "EACCES"]);

/** Bind failures that only mean this address family is unavailable here. */
const BIND_NOT_APPLICABLE_CODES = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"]);

const DEFAULT_CONNECT_TIMEOUT_MS = 500;

function connectsWithin(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (connected: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

type BindOutcome = "bound" | "busy" | "not-applicable" | "error";

/** On macOS/Linux an unprivileged bind below 1024 fails with EACCES even when the port is free. */
function isPrivilegedPortRefusal(code: string, port: number): boolean {
  return code === "EACCES" && process.platform !== "win32" && port < 1024;
}

function tryBind(host: string, port: number): Promise<BindOutcome> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? "";
      if (isPrivilegedPortRefusal(code, port)) resolve("error");
      else if (BIND_BUSY_CODES.has(code)) resolve("busy");
      else if (BIND_NOT_APPLICABLE_CODES.has(code)) resolve("not-applicable");
      else resolve("error");
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve("bound"));
    });
  });
}

/**
 * Ask the kernel directly whether a local TCP port is taken.
 *
 * PortPilot's listener table (Get-NetTCPConnection / netstat / lsof / ss) is
 * a report, not the truth. On some Windows builds it silently leaves live
 * listeners out, a different subset on every call, and lsof only reports the
 * caller's own processes. Reading "missing from the table" as "free" handed
 * agents ports that another browser was already serving. This probe says
 * WHETHER a port is held; the table and the process list say WHO holds it.
 *
 * It only touches loopback: it connects to 127.0.0.1 and ::1, then briefly
 * binds them. Loopback binds never trigger a Windows Firewall prompt, which
 * wildcard binds can.
 */
export async function probePort(port: number, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<PortProbeResult> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return "unknown";
  for (const host of LOOPBACK_HOSTS) {
    if (await connectsWithin(host, port, timeoutMs)) return "busy";
  }
  let bound = false;
  for (const host of LOOPBACK_HOSTS) {
    const outcome = await tryBind(host, port);
    if (outcome === "busy") return "busy";
    if (outcome === "bound") bound = true;
  }
  return bound ? "free" : "unknown";
}
