import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { portpilotHome } from "../core/paths.js";
import { SUPERVISOR_PROTOCOL_VERSION, } from "./protocol.js";
export function supervisorTokenPath(home = portpilotHome()) {
    return join(resolve(home), "supervisor.token");
}
export function supervisorEndpoint(home = portpilotHome()) {
    const resolved = resolve(home);
    if (process.platform === "win32") {
        const suffix = createHash("sha256").update(resolved.toLowerCase()).digest("hex").slice(0, 24);
        return `\\\\.\\pipe\\portpilot-supervisor-${suffix}`;
    }
    return join(resolved, "supervisor.sock");
}
export function supervisorRequestTimeout(method, override) {
    return override ?? (method === "launch" ? 40_000 : method === "close" ? 10_000 : 3_000);
}
export function createSupervisorClient(options = {}) {
    const home = options.home ?? portpilotHome();
    const endpoint = supervisorEndpoint(home);
    async function request(method, params) {
        const timeoutMs = supervisorRequestTimeout(method, options.timeoutMs);
        const token = options.token ?? (await readFile(supervisorTokenPath(home), "utf8")).trim();
        const id = randomUUID();
        const message = {
            id,
            token,
            protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
            method,
            params,
        };
        return new Promise((resolvePromise, reject) => {
            const socket = connect(endpoint);
            let buffer = "";
            let settled = false;
            const finish = (error, result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                if (error)
                    reject(error);
                else
                    resolvePromise(result);
            };
            const timer = setTimeout(() => finish(new Error(`PortPilot supervisor request timed out after ${timeoutMs}ms`)), timeoutMs);
            timer.unref?.();
            socket.setEncoding("utf8");
            socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
            socket.on("data", (chunk) => {
                buffer += chunk;
                const newline = buffer.indexOf("\n");
                if (newline < 0) {
                    if (buffer.length > 256 * 1024)
                        finish(new Error("PortPilot supervisor response exceeded 256 KiB"));
                    return;
                }
                try {
                    const response = JSON.parse(buffer.slice(0, newline));
                    if (response.id !== id)
                        return finish(new Error("PortPilot supervisor response id mismatch"));
                    if (!response.ok)
                        return finish(new Error(response.error));
                    finish(undefined, response.result);
                }
                catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            });
            socket.on("error", (error) => finish(error));
            socket.on("end", () => {
                if (!settled)
                    finish(new Error("PortPilot supervisor disconnected before replying"));
            });
        });
    }
    return {
        ping: () => request("ping", {}),
        launch: (launchRequest) => request("launch", launchRequest),
        close: (closeRequest) => request("close", closeRequest),
    };
}
