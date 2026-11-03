import { randomUUID } from "node:crypto";
import { assertModeSupported, evaluateBrowserAttach, launchBrowserForLane } from "../core/browsers.js";
import { loadConfig } from "../core/config.js";
import { resolveChromeMode } from "../core/chrome.js";
import { laneBrowser } from "../core/lane.js";
import { portpilotHome } from "../core/paths.js";
import { listLanes, updateRegistry } from "../core/registry.js";
import { scanNative } from "../core/scanner.js";
import { createBrowserOwner } from "./browser-owner.js";
import { createSupervisorClient } from "./client.js";
import { closeBrowserForLane } from "./close-browser.js";
import { markSupervisorDisconnected, reconcileBrowserLanes } from "./reconcile.js";
import { startSupervisorServer } from "./server.js";
export async function persistBrowserIdentity(updated) {
    await updateRegistry((lanes) => lanes.map((current) => {
        if (current.id !== updated.id)
            return current;
        return {
            ...current,
            status: updated.status,
            lastSeen: updated.lastSeen,
            pid: updated.pid,
            browserPid: updated.browserPid,
            supervisorId: updated.supervisorId,
            browserState: updated.browserState,
            browserStartedAt: updated.browserStartedAt,
        };
    }));
}
export async function startProductionSupervisor(home = portpilotHome()) {
    const supervisorId = randomUUID();
    let initializationError;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const owner = createBrowserOwner({
        supervisorId,
        getLane: async (id) => (await listLanes()).find((lane) => lane.id === id),
        check: async (lane, signal) => evaluateBrowserAttach(lane, await scanNative({ signal })),
        launch: async (lane, request) => {
            const config = await loadConfig();
            const mode = resolveChromeMode(request.mode, config.chromeMode);
            assertModeSupported(laneBrowser(lane), mode);
            return launchBrowserForLane(lane, {
                mode,
                ...(request.binaryPath ? { binaryPath: request.binaryPath } : {}),
                ...(request.initialUrl ? { initialUrl: request.initialUrl } : {}),
            });
        },
        persist: persistBrowserIdentity,
        close: closeBrowserForLane,
    });
    const waitUntilReady = async () => {
        await ready;
        if (initializationError)
            throw initializationError;
    };
    const handlers = {
        launch: async (request) => {
            await waitUntilReady();
            return owner.launch(request);
        },
        close: async (request) => {
            await waitUntilReady();
            return owner.close(request);
        },
    };
    const handle = await startSupervisorServer({ home, handlers, supervisorId, waitUntilReady });
    try {
        const observations = await scanNative();
        await updateRegistry((lanes) => reconcileBrowserLanes(lanes, observations, supervisorId));
        resolveReady();
        return handle;
    }
    catch (error) {
        initializationError = error;
        resolveReady();
        await handle.close();
        throw error;
    }
}
export async function runProductionSupervisor(home = portpilotHome()) {
    try {
        await createSupervisorClient({ home, timeoutMs: 250 }).ping();
        return "already-running";
    }
    catch {
        // No responsive supervisor; attempt to become it.
    }
    let handle;
    try {
        handle = await startProductionSupervisor(home);
    }
    catch (error) {
        const code = error.code;
        if (code === "EADDRINUSE") {
            await createSupervisorClient({ home, timeoutMs: 1_000 }).ping();
            return "already-running";
        }
        throw error;
    }
    process.title = "portpilot-supervisor";
    await new Promise((resolve) => {
        const stop = () => resolve();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
    await updateRegistry((lanes) => markSupervisorDisconnected(lanes, handle.supervisorId));
    await handle.close();
    return "started";
}
