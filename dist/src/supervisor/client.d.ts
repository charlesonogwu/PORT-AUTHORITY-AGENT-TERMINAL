import { type SupervisorCloseRequest, type SupervisorCloseResult, type SupervisorLaunchRequest, type SupervisorLaunchResult, type SupervisorMethod, type SupervisorPingResult } from "./protocol.js";
export declare function supervisorTokenPath(home?: string): string;
export declare function supervisorEndpoint(home?: string): string;
/**
 * The supervisor answered and refused the request, as opposed to being
 * unreachable. Callers must not tell the user to restart anything for these:
 * the supervisor is up and the message says why it said no.
 */
export declare class SupervisorReplyError extends Error {
    constructor(message: string);
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
export declare function supervisorRequestTimeout(method: SupervisorMethod, override?: number): number;
export interface SupervisorStatus {
    ok: boolean;
    running: boolean;
    supervisorId?: string;
    protocolVersion?: number;
    error?: string;
}
/** Ping the supervisor and describe the answer. Never throws: "not running" is a status, not an error. */
export declare function getSupervisorStatus(options?: SupervisorClientOptions): Promise<SupervisorStatus>;
export declare function createSupervisorClient(options?: SupervisorClientOptions): SupervisorClient;
