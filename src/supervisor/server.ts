import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { createSupervisorClient, supervisorEndpoint, supervisorTokenPath } from "./client.js";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  assertLaneId,
  type SupervisorCloseRequest,
  type SupervisorHandlers,
  type SupervisorLaunchRequest,
  type SupervisorWireRequest,
  type SupervisorWireResponse,
} from "./protocol.js";

export interface StartSupervisorOptions {
  home: string;
  handlers: SupervisorHandlers;
  supervisorId?: string;
  waitUntilReady?: () => Promise<void>;
}

export interface SupervisorServerHandle {
  supervisorId: string;
  endpoint: string;
  close(): Promise<void>;
}

async function loadOrCreateToken(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const validate = (value: string): string => {
    const token = value.trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error(`invalid PortPilot supervisor token file: ${path}`);
    return token;
  };
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    const token = randomBytes(32).toString("hex");
    try {
      await handle.writeFile(token + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return validate(await readFile(path, "utf8"));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return validate(await readFile(path, "utf8"));
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function acquireUnixSupervisorLock(endpoint: string): Promise<() => Promise<void>> {
  const lockPath = `${endpoint}.lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  for (;;) {
    const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(owner + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, lockPath);
      await rm(temporary, { force: true });
      return async () => {
        try {
          if ((await readFile(lockPath, "utf8")).trim() === owner) await rm(lockPath, { force: true });
        } catch { /* already gone */ }
      };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerPid = 0;
      try { ownerPid = Number((await readFile(lockPath, "utf8")).split(":", 1)[0]); } catch { /* reclaim invalid lock */ }
      if (ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
          const busy = new Error("PortPilot supervisor is already running") as NodeJS.ErrnoException;
          busy.code = "EADDRINUSE";
          throw busy;
        } catch (processError) {
          if ((processError as NodeJS.ErrnoException).code === "EADDRINUSE") throw processError;
        }
      }
      const quarantine = `${lockPath}.stale.${randomUUID()}`;
      try { await rename(lockPath, quarantine); } catch { continue; }
      await rm(quarantine, { force: true }).catch(() => {});
    }
  }
}

function tokenMatches(actual: string, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(socket: Socket, response: SupervisorWireResponse): void {
  socket.end(JSON.stringify(response) + "\n");
}

export async function startSupervisorServer(options: StartSupervisorOptions): Promise<SupervisorServerHandle> {
  const endpoint = supervisorEndpoint(options.home);
  const token = await loadOrCreateToken(supervisorTokenPath(options.home));
  const supervisorId = options.supervisorId ?? randomUUID();
  let releaseLock: (() => Promise<void>) | undefined;
  if (process.platform !== "win32") {
    releaseLock = await acquireUnixSupervisorLock(endpoint);
    let live = false;
    try {
      await createSupervisorClient({ home: options.home, token, timeoutMs: 250 }).ping();
      live = true;
    } catch {
      // Stale/missing socket; safe to remove after winning the lock.
    }
    if (live) {
      await releaseLock();
      const error = new Error("PortPilot supervisor is already running") as NodeJS.ErrnoException;
      error.code = "EADDRINUSE";
      throw error;
    }
    await rm(endpoint, { force: true }).catch(() => {});
  }

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      if (buffer.length > 256 * 1024) {
        send(socket, { id: "unknown", ok: false, error: "request exceeded 256 KiB" });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      let request: SupervisorWireRequest;
      try {
        request = JSON.parse(line) as SupervisorWireRequest;
        if (!request || typeof request.id !== "string") throw new Error("invalid request id");
        if (!tokenMatches(token, request.token)) throw new Error("unauthorized supervisor request");
        if (request.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION) throw new Error("unsupported supervisor protocol version");

        if (request.method === "ping") {
          await options.waitUntilReady?.();
          send(socket, { id: request.id, ok: true, result: { supervisorId, protocolVersion: SUPERVISOR_PROTOCOL_VERSION } });
          return;
        }
        if (request.method === "launch") {
          const params = request.params as SupervisorLaunchRequest;
          assertLaneId(params?.laneId);
          send(socket, { id: request.id, ok: true, result: await options.handlers.launch(params) });
          return;
        }
        if (request.method === "close") {
          const params = request.params as SupervisorCloseRequest;
          assertLaneId(params?.laneId);
          send(socket, { id: request.id, ok: true, result: await options.handlers.close(params) });
          return;
        }
        throw new Error("unsupported supervisor method");
      } catch (error) {
        const id = typeof (request! as SupervisorWireRequest | undefined)?.id === "string" ? request!.id : "unknown";
        send(socket, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
  } catch (error) {
    await releaseLock?.();
    throw error;
  }

  return {
    supervisorId,
    endpoint,
    close: async () => {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
      if (process.platform !== "win32") await rm(endpoint, { force: true }).catch(() => {});
      await releaseLock?.();
    },
  };
}
