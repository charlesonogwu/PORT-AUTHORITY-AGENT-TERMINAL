import type { ChromeAttachVerdict, LaunchResult } from "../core/chrome.js";
import type { Lane } from "../core/lane.js";
import type { SupervisorHandlers, SupervisorLaunchRequest } from "./protocol.js";
export interface BrowserOwnerDependencies {
    supervisorId: string;
    getLane(id: string): Promise<Lane | undefined>;
    check(lane: Lane, signal?: AbortSignal): Promise<ChromeAttachVerdict>;
    launch(lane: Lane, request: SupervisorLaunchRequest): Promise<LaunchResult>;
    persist(lane: Lane): Promise<void>;
    close(lane: Lane): Promise<boolean>;
    verifyAttempts?: number;
    verifyDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    operationTimeoutMs?: number;
}
export declare function createBrowserOwner(deps: BrowserOwnerDependencies): SupervisorHandlers;
