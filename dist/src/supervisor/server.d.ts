import { type SupervisorHandlers } from "./protocol.js";
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
export declare function startSupervisorServer(options: StartSupervisorOptions): Promise<SupervisorServerHandle>;
