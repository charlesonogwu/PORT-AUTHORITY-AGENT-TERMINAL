/**
 * `paat dashboard-serve`: the desktop dashboard's long-lived helper.
 *
 * The dashboard refreshes every few seconds. It used to start two new `paat`
 * processes per refresh (each a cmd.exe + node.exe pair: one for the
 * snapshot, one for the supervisor check), and the snapshot one then started
 * powershell.exe three times. Now the dashboard starts this server once and
 * sends it one request per refresh, and the server reuses one PowerShell
 * session for every query.
 *
 *   request  (stdin):  {"id":"7","method":"snapshot"}
 *   reply    (stdout): {"id":"7","ok":true,"result":{...}}
 *                   or {"id":"7","ok":false,"error":"..."}
 *
 * One JSON object per line, handled strictly one at a time. The server stops
 * when the dashboard closes stdin, which the OS also does if it crashes.
 */
import type { Readable, Writable } from "node:stream";
import { type PowerShellRunner } from "../core/powershell-host.js";
export type DashboardServeHandler = () => Promise<unknown>;
export type DashboardServeHandlers = Readonly<Record<string, DashboardServeHandler>>;
/** Answer one request per input line, one at a time, until the input closes. */
export declare function serveDashboardRequests(input: Readable, output: Writable, handlers: DashboardServeHandlers): Promise<void>;
export interface DashboardHandlerDeps {
    powershell: PowerShellRunner | undefined;
    buildSnapshot: (options: {
        powershell?: PowerShellRunner;
    }) => Promise<unknown>;
    supervisorStatus: () => Promise<unknown>;
}
export declare function createDashboardHandlers(deps: DashboardHandlerDeps): DashboardServeHandlers;
/** Production wiring for `paat dashboard-serve`. */
export declare function runDashboardServer(input: Readable, output: Writable): Promise<void>;
