import type { Lane } from "../core/lane.js";
import { type SupervisorServerHandle } from "./server.js";
export declare function persistBrowserIdentity(updated: Lane): Promise<void>;
export declare function startProductionSupervisor(home?: string): Promise<SupervisorServerHandle>;
export declare function runProductionSupervisor(home?: string): Promise<"started" | "already-running">;
