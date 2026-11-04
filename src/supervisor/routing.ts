import type { LaunchChromeOptions } from "../core/chrome.js";
import type { Lane } from "../core/lane.js";
import { createSupervisorClient, SupervisorReplyError, type SupervisorClient } from "./client.js";
import type { SupervisorLaunchResult } from "./protocol.js";

export async function launchPersistentBrowser(
  lane: Lane,
  options: LaunchChromeOptions,
  client: SupervisorClient = createSupervisorClient(),
): Promise<SupervisorLaunchResult> {
  try {
    return await client.launch({
      laneId: lane.id,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
      ...(options.initialUrl ? { initialUrl: options.initialUrl } : {}),
    });
  } catch (error) {
    // The supervisor is running and said no (for example, another browser
    // holds the lane's debug port). Pass its reason through; telling the user
    // to restart the dashboard would send them after the wrong problem.
    if (error instanceof SupervisorReplyError) {
      throw new Error(`PortPilot could not open the browser for lane ${lane.id}: ${error.message}`);
    }
    throw new Error(
      "PortPilot supervisor is unavailable; persistent browsers are not launched under disposable MCP workers. " +
      "Open or restart the PortPilot dashboard, then retry. " +
      `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
