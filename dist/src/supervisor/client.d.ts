import { type SupervisorCloseRequest, type SupervisorCloseResult, type SupervisorLaunchRequest, type SupervisorLaunchResult, type SupervisorMethod, type SupervisorPingResult } from "./protocol.js";
export declare function supervisorTokenPath(home?: string): string;
export declare function supervisorEndpoint(home?: string): string;
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
export declare function createSupervisorClient(options?: SupervisorClientOptions): SupervisorClient;
