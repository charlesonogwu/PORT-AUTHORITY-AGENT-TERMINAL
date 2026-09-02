import { evaluateBrowserAttach } from "../core/browsers.js";
import { nowIso } from "../core/lane.js";
const EXPECTED_RUNNING = new Set(["starting", "active", "disconnected", "recoverable"]);
/** Reconcile persisted lifecycle state from one fresh process/port snapshot. */
export function reconcileBrowserLanes(lanes, observations, supervisorId, at = nowIso()) {
    return lanes.map((lane) => {
        if (lane.status === "released")
            return lane;
        const verdict = evaluateBrowserAttach(lane, observations);
        if (verdict.kind === "safe-attach") {
            const pid = verdict.observation.pid;
            const updated = {
                ...lane,
                status: "active",
                lastSeen: at,
                supervisorId,
                browserState: "recoverable",
                ...(pid !== undefined ? { pid, browserPid: pid } : {}),
            };
            if (verdict.observation.processStartedAt !== undefined) {
                updated.browserStartedAt = verdict.observation.processStartedAt;
            }
            else {
                delete updated.browserStartedAt;
            }
            return updated;
        }
        if (verdict.kind === "safe-free") {
            if (!lane.browserPid && !EXPECTED_RUNNING.has(lane.browserState ?? ""))
                return lane;
            const updated = {
                ...lane,
                status: "stale",
                lastSeen: at,
                supervisorId,
                browserState: "crashed",
            };
            delete updated.pid;
            delete updated.browserPid;
            delete updated.browserStartedAt;
            return updated;
        }
        const updated = {
            ...lane,
            status: "stale",
            lastSeen: at,
            supervisorId,
            browserState: "disconnected",
        };
        delete updated.pid;
        delete updated.browserPid;
        delete updated.browserStartedAt;
        return updated;
    });
}
export function markSupervisorDisconnected(lanes, supervisorId, at = nowIso()) {
    return lanes.map((lane) => lane.supervisorId === supervisorId && lane.browserState === "active"
        ? { ...lane, browserState: "disconnected", lastSeen: at }
        : lane);
}
