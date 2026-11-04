import { createSupervisorClient, SupervisorReplyError } from "./client.js";
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
        // The supervisor is running and said no (for example, another browser
        // holds the lane's debug port). Pass its reason through; telling the user
        // to restart the dashboard would send them after the wrong problem.
        if (error instanceof SupervisorReplyError) {
            throw new Error(`PortPilot could not open the browser for lane ${lane.id}: ${error.message}`);
        }
        throw new Error("PortPilot supervisor is unavailable; persistent browsers are not launched under disposable MCP workers. " +
            "Open or restart the PortPilot dashboard, then retry. " +
            `Cause: ${error instanceof Error ? error.message : String(error)}`);
    }
}
