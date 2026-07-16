import { REGISTRY_VERSION } from "./lane.js";
export declare const RUNTIME_IDENTITY: "portpilot-runtime";
export declare const RUNTIME_PROTOCOL_VERSION: 1;
export interface RuntimeHandshake {
    ok: true;
    identity: typeof RUNTIME_IDENTITY;
    portpilotVersion: string;
    protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
    registrySchemaVersion: typeof REGISTRY_VERSION;
    platform: NodeJS.Platform;
    architecture: string;
}
export declare function runtimeHandshake(): Promise<RuntimeHandshake>;
