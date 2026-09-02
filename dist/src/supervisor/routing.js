import { createSupervisorClient } from "./client.js";
export async function launchPersistentBrowser(lane, options, client = createSupervisorClient()) {
    try {
        return await client.launch({
            laneId: lane.id,
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
            ...(options.initialUrl ? { initialUrl: options.initialUrl } : {}),
        });
    }
    catch (error) {
        throw new Error("PortPilot supervisor is unavailable; persistent browsers are not launched under disposable MCP workers. " +
            "Open or restart the PortPilot dashboard, then retry. " +
            `Cause: ${error instanceof Error ? error.message : String(error)}`);
    }
}
