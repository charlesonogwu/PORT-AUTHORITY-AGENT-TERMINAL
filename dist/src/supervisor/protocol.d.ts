export declare const SUPERVISOR_PROTOCOL_VERSION: 1;
export interface SupervisorLaunchRequest {
    laneId: string;
    mode?: "visible" | "background" | "headless";
    binaryPath?: string;
    initialUrl?: string;
}
export interface SupervisorLaunchResult {
    laneId: string;
    pid?: number;
    reused: boolean;
    command?: {
        binary: string;
        args: string[];
    };
    mode?: "visible" | "background" | "headless";
}
export interface SupervisorCloseRequest {
    laneId: string;
}
export interface SupervisorCloseResult {
    laneId: string;
    closed: boolean;
}
export interface SupervisorPingResult {
    supervisorId: string;
    protocolVersion: typeof SUPERVISOR_PROTOCOL_VERSION;
}
export interface SupervisorHandlers {
    launch(request: SupervisorLaunchRequest): Promise<SupervisorLaunchResult>;
    close(request: SupervisorCloseRequest): Promise<SupervisorCloseResult>;
}
export type SupervisorMethod = "ping" | "launch" | "close";
export interface SupervisorWireRequest {
    id: string;
    token: string;
    protocolVersion: number;
    method: SupervisorMethod;
    params: unknown;
}
export type SupervisorWireResponse = {
    id: string;
    ok: true;
    result: unknown;
} | {
    id: string;
    ok: false;
    error: string;
};
export declare function assertLaneId(value: unknown): asserts value is string;
