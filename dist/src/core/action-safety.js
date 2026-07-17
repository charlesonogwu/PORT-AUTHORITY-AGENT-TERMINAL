import { evaluateBrowserAttach } from "./browsers.js";
/**
 * Final fail-closed gate immediately before a dashboard process/window action.
 * The caller must supply the freshly reloaded lane and freshly scanned process
 * observations; this function never trusts a PID cached in the React view.
 */
export function evaluateLaneAction(lane, requestedPid, observations) {
    if (!Number.isInteger(requestedPid) || requestedPid <= 0) {
        throw new Error("refused dashboard action: PID must be a positive integer");
    }
    if (lane.status === "released") {
        throw new Error(`refused dashboard action: lane ${lane.id} is released`);
    }
    if (!lane.chromeDebugPort) {
        throw new Error(`refused dashboard action: lane ${lane.id} has no browser debugging port`);
    }
    const verdict = evaluateBrowserAttach(lane, observations);
    if (verdict.kind !== "safe-attach") {
        throw new Error(`refused dashboard action: lane ${lane.id} did not pass safe-attach (${verdict.kind})`);
    }
    if (verdict.observation.pid !== requestedPid) {
        throw new Error(`refused dashboard action: live PID ${verdict.observation.pid ?? "unknown"} does not match requested PID ${requestedPid}`);
    }
    return { lane, pid: requestedPid, observation: verdict.observation };
}
