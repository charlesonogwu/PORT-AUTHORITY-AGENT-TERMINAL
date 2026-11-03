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
export declare function probePort(port: number, timeoutMs?: number): Promise<PortProbeResult>;
