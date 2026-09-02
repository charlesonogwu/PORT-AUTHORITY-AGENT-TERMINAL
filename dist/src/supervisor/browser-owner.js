import { laneBrowser, nowIso } from "../core/lane.js";
function withIdentity(lane, args) {
    const status = args.state === "active"
        ? "active"
        : args.state === "crashed"
            ? "stale"
            : args.state === "closed"
                ? "reserved"
                : lane.status;
    const updated = {
        ...lane,
        status,
        browserState: args.state,
        supervisorId: args.supervisorId,
        lastSeen: nowIso(),
        ...(args.pid !== undefined ? { pid: args.pid, browserPid: args.pid } : {}),
        ...(args.startedAt !== undefined ? { browserStartedAt: args.startedAt } : {}),
    };
    if (args.clearIdentity) {
        delete updated.pid;
        delete updated.browserPid;
        delete updated.browserStartedAt;
    }
    else if (args.replaceStartedAt && args.startedAt === undefined) {
        delete updated.browserStartedAt;
    }
    return updated;
}
export function createBrowserOwner(deps) {
    const laneLocks = new Map();
    async function withLaneLock(laneId, operation) {
        const previous = laneLocks.get(laneId) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => gate);
        laneLocks.set(laneId, tail);
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
            if (laneLocks.get(laneId) === tail)
                laneLocks.delete(laneId);
        }
    }
    async function requireLane(id) {
        const lane = await deps.getLane(id);
        if (!lane)
            throw new Error(`lane not found: ${id}`);
        if (lane.status === "released")
            throw new Error(`lane is released: ${id}`);
        return lane;
    }
    return {
        async launch(request) {
            return withLaneLock(request.laneId, async () => {
                const lane = await requireLane(request.laneId);
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(new Error("browser launch verification deadline exceeded")), deps.operationTimeoutMs ?? 12_000);
                timer.unref?.();
                let spawnedPid;
                let launchStarted = false;
                const startedAt = nowIso();
                const waitForRetry = async (ms) => {
                    if (deps.sleep) {
                        await deps.sleep(ms);
                        controller.signal.throwIfAborted();
                        return;
                    }
                    await new Promise((resolve, reject) => {
                        if (controller.signal.aborted) {
                            reject(controller.signal.reason);
                            return;
                        }
                        const onAbort = () => {
                            clearTimeout(delay);
                            reject(controller.signal.reason);
                        };
                        const delay = setTimeout(() => {
                            controller.signal.removeEventListener("abort", onAbort);
                            resolve();
                        }, ms);
                        controller.signal.addEventListener("abort", onAbort, { once: true });
                    });
                };
                try {
                    controller.signal.throwIfAborted();
                    const verdict = await deps.check(lane, controller.signal);
                    controller.signal.throwIfAborted();
                    if (verdict.kind === "safe-attach") {
                        const pid = verdict.observation.pid;
                        await deps.persist(withIdentity(lane, {
                            supervisorId: deps.supervisorId,
                            state: "active",
                            ...(pid !== undefined ? { pid } : {}),
                            startedAt: verdict.observation.processStartedAt,
                            replaceStartedAt: true,
                        }));
                        return { laneId: lane.id, ...(pid !== undefined ? { pid } : {}), reused: true };
                    }
                    if (verdict.kind !== "safe-free")
                        throw new Error(`unsafe to launch lane ${lane.id}: ${verdict.kind}`);
                    await deps.persist(withIdentity(lane, {
                        supervisorId: deps.supervisorId,
                        state: "starting",
                        startedAt,
                        clearIdentity: true,
                    }));
                    launchStarted = true;
                    controller.signal.throwIfAborted();
                    const result = await deps.launch(lane, request);
                    spawnedPid = result.pid;
                    let verified;
                    const attempts = deps.verifyAttempts ?? 100;
                    for (let attempt = 0; attempt < attempts; attempt += 1) {
                        controller.signal.throwIfAborted();
                        verified = await deps.check(lane, controller.signal);
                        controller.signal.throwIfAborted();
                        if (verified.kind === "safe-attach")
                            break;
                        if (verified.kind !== "safe-free")
                            throw new Error(`launched browser failed identity verification: ${verified.kind}`);
                        if (attempt + 1 < attempts)
                            await waitForRetry(deps.verifyDelayMs ?? 100);
                    }
                    if (!verified || verified.kind !== "safe-attach") {
                        throw new Error(`launched browser did not become attachable on port ${lane.chromeDebugPort}`);
                    }
                    const verifiedPid = verified.observation.pid;
                    if (laneBrowser(lane) !== "firefox" && result.pid !== undefined && verifiedPid !== undefined && result.pid !== verifiedPid) {
                        throw new Error(`launched browser pid mismatch: spawned ${result.pid}, observed ${verifiedPid}`);
                    }
                    const pid = verifiedPid ?? result.pid;
                    await deps.persist(withIdentity(lane, {
                        supervisorId: deps.supervisorId,
                        state: "active",
                        ...(pid !== undefined ? { pid } : {}),
                        startedAt: verified.observation.processStartedAt,
                        replaceStartedAt: true,
                    }));
                    return {
                        laneId: lane.id,
                        ...(pid !== undefined ? { pid } : {}),
                        reused: false,
                        command: { binary: result.binary, args: result.args },
                        mode: result.mode,
                    };
                }
                catch (error) {
                    if (launchStarted && (spawnedPid !== undefined || !controller.signal.aborted)) {
                        await deps.persist(withIdentity(lane, {
                            supervisorId: deps.supervisorId,
                            state: spawnedPid !== undefined ? "recoverable" : "crashed",
                            ...(spawnedPid !== undefined ? { pid: spawnedPid } : {}),
                            clearIdentity: spawnedPid === undefined,
                            replaceStartedAt: true,
                        }));
                    }
                    throw error;
                }
                finally {
                    clearTimeout(timer);
                }
            });
        },
        async close(request) {
            return withLaneLock(request.laneId, async () => {
                const lane = await requireLane(request.laneId);
                const closed = await deps.close(lane);
                await deps.persist(withIdentity(lane, {
                    supervisorId: deps.supervisorId,
                    state: "closed",
                    clearIdentity: true,
                }));
                return { laneId: lane.id, closed };
            });
        },
    };
}
