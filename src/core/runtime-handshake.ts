import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { REGISTRY_VERSION } from "./lane.js";

export const RUNTIME_IDENTITY = "portpilot-runtime" as const;
export const RUNTIME_PROTOCOL_VERSION = 1 as const;

async function installedPackageVersion(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        parsed.name === "port-authority-agent-terminal-mcp" &&
        typeof parsed.version === "string"
      ) {
        return parsed.version;
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the installed PortPilot package metadata");
}

export interface RuntimeHandshake {
  ok: true;
  identity: typeof RUNTIME_IDENTITY;
  portpilotVersion: string;
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  registrySchemaVersion: typeof REGISTRY_VERSION;
  platform: NodeJS.Platform;
  architecture: string;
}

export async function runtimeHandshake(): Promise<RuntimeHandshake> {
  return {
    ok: true,
    identity: RUNTIME_IDENTITY,
    portpilotVersion: await installedPackageVersion(),
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    registrySchemaVersion: REGISTRY_VERSION,
    platform: process.platform,
    architecture: process.arch,
  };
}
