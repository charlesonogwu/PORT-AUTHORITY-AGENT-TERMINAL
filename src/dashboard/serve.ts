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

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createPersistentPowerShell, type PowerShellRunner } from "../core/powershell-host.js";
import { getSupervisorStatus } from "../supervisor/client.js";
import { buildSnapshot } from "./snapshot.js";

const MAX_ID_LENGTH = 128;

export type DashboardServeHandler = () => Promise<unknown>;
export type DashboardServeHandlers = Readonly<Record<string, DashboardServeHandler>>;

interface DashboardServeReply {
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function answer(line: string, handlers: DashboardServeHandlers): Promise<DashboardServeReply> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { id: null, ok: false, error: "request is not valid JSON" };
  }
  const { id, method } = (request ?? {}) as { id?: unknown; method?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
    return { id: null, ok: false, error: `request id must be a string of 1-${MAX_ID_LENGTH} characters` };
  }
  // Own properties only: "toString" or "__proto__" must never reach Object.prototype.
  const handler = typeof method === "string" && Object.hasOwn(handlers, method) ? handlers[method] : undefined;
  if (!handler) {
    // Never String() an arbitrary value: {"toString":1} would throw here.
    const name = typeof method === "string" ? method.slice(0, 64) : `(${typeof method})`;
    return { id, ok: false, error: `unknown method: ${name}` };
  }
  try {
    return { id, ok: true, result: await handler() };
  } catch (error) {
    return { id, ok: false, error: errorMessage(error) };
  }
}

function encode(reply: DashboardServeReply): string {
  try {
    return JSON.stringify(reply);
  } catch (error) {
    return JSON.stringify({ id: reply.id, ok: false, error: `reply could not be encoded: ${errorMessage(error)}` });
  }
}

/** Answer one request per input line, one at a time, until the input closes. */
export async function serveDashboardRequests(input: Readable, output: Writable, handlers: DashboardServeHandlers): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let outputBroken = false;
  // The dashboard is gone (EPIPE): stop reading, since nobody is listening.
  // This listener is never removed, because a broken pipe is reported
  // asynchronously and can arrive after the loop below has finished.
  output.on("error", () => {
    outputBroken = true;
    lines.close();
  });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const reply = await answer(line, handlers);
      if (outputBroken) break;
      output.write(encode(reply) + "\n");
    }
  } finally {
    lines.close();
  }
}

export interface DashboardHandlerDeps {
  powershell: PowerShellRunner | undefined;
  buildSnapshot: (options: { powershell?: PowerShellRunner }) => Promise<unknown>;
  supervisorStatus: () => Promise<unknown>;
}

export function createDashboardHandlers(deps: DashboardHandlerDeps): DashboardServeHandlers {
  return {
    ping: async () => ({ pid: process.pid }),
    // One round trip per refresh: the snapshot and the supervisor check together.
    snapshot: async () => {
      const [snapshot, supervisor] = await Promise.all([
        deps.buildSnapshot({ powershell: deps.powershell }),
        deps.supervisorStatus(),
      ]);
      return { snapshot, supervisor };
    },
  };
}

/** Production wiring for `paat dashboard-serve`. */
export async function runDashboardServer(input: Readable, output: Writable): Promise<void> {
  // Only Windows queries PowerShell; the session starts lazily on first use.
  const powershell = process.platform === "win32" ? createPersistentPowerShell() : undefined;
  try {
    await serveDashboardRequests(input, output, createDashboardHandlers({
      powershell,
      buildSnapshot: (options) => buildSnapshot(options),
      supervisorStatus: () => getSupervisorStatus({ timeoutMs: 1_000 }),
    }));
  } finally {
    powershell?.close();
  }
}
