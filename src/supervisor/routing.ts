import type { LaunchChromeOptions } from "../core/chrome.js";
import type { Lane } from "../core/lane.js";
import { createSupervisorClient, type SupervisorClient } from "./client.js";
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
    throw new Error(
      "PortPilot supervisor is unavailable; persistent browsers are not launched under disposable MCP workers. " +
      "Open or restart the PortPilot dashboard, then retry. " +
      `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
