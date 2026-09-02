import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { portpilotHome } from "../core/paths.js";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorCloseRequest,
  type SupervisorCloseResult,
  type SupervisorLaunchRequest,
  type SupervisorLaunchResult,
  type SupervisorMethod,
  type SupervisorPingResult,
  type SupervisorWireRequest,
  type SupervisorWireResponse,
} from "./protocol.js";

export function supervisorTokenPath(home = portpilotHome()): string {
  return join(resolve(home), "supervisor.token");
}

export function supervisorEndpoint(home = portpilotHome()): string {
  const resolved = resolve(home);
  if (process.platform === "win32") {
    const suffix = createHash("sha256").update(resolved.toLowerCase()).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\portpilot-supervisor-${suffix}`;
  }
  return join(resolved, "supervisor.sock");
}

export interface SupervisorClientOptions {
  home?: string;
  token?: string;
  timeoutMs?: number;
}

export interface SupervisorClient {
  ping(): Promise<SupervisorPingResult>;
  launch(request: SupervisorLaunchRequest): Promise<SupervisorLaunchResult>;
  close(request: SupervisorCloseRequest): Promise<SupervisorCloseResult>;
}

export function supervisorRequestTimeout(method: SupervisorMethod, override?: number): number {
  return override ?? (method === "launch" ? 40_000 : method === "close" ? 10_000 : 3_000);
}

export function createSupervisorClient(options: SupervisorClientOptions = {}): SupervisorClient {
  const home = options.home ?? portpilotHome();
  const endpoint = supervisorEndpoint(home);
  async function request<T>(method: SupervisorMethod, params: unknown): Promise<T> {
    const timeoutMs = supervisorRequestTimeout(method, options.timeoutMs);
    const token = options.token ?? (await readFile(supervisorTokenPath(home), "utf8")).trim();
    const id = randomUUID();
    const message: SupervisorWireRequest = {
      id,
      token,
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      method,
      params,
    };

    return new Promise<T>((resolvePromise, reject) => {
      const socket = connect(endpoint);
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolvePromise(result as T);
      };
      const timer = setTimeout(() => finish(new Error(`PortPilot supervisor request timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (buffer.length > 256 * 1024) finish(new Error("PortPilot supervisor response exceeded 256 KiB"));
          return;
        }
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as SupervisorWireResponse;
          if (response.id !== id) return finish(new Error("PortPilot supervisor response id mismatch"));
          if (!response.ok) return finish(new Error(response.error));
          finish(undefined, response.result as T);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => {
        if (!settled) finish(new Error("PortPilot supervisor disconnected before replying"));
      });
    });
  }

  return {
    ping: () => request<SupervisorPingResult>("ping", {}),
    launch: (launchRequest) => request<SupervisorLaunchResult>("launch", launchRequest),
    close: (closeRequest) => request<SupervisorCloseResult>("close", closeRequest),
  };
}
