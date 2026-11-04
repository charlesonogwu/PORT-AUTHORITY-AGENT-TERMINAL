import type { LaunchChromeOptions } from "../core/chrome.js";
import type { Lane } from "../core/lane.js";
import { type SupervisorClient } from "./client.js";
import type { SupervisorLaunchResult } from "./protocol.js";
export declare function launchPersistentBrowser(lane: Lane, options: LaunchChromeOptions, client?: SupervisorClient): Promise<SupervisorLaunchResult>;
