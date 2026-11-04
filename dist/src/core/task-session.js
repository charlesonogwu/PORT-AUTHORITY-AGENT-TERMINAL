import { createHash } from "node:crypto";
import { DEFAULT_SESSION_ID, sessionSlug } from "./lane.js";
/** Hash the complete host task ID; filename truncation must not merge tasks. */
export function taskSessionId(taskId) {
    const id = taskId.trim();
    if (!id)
        throw new Error("PortPilot task ID must not be blank");
    return `task-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}
/** Only an explicitly configured identity shared by CLI and MCP is automatic.
 * Codex thread IDs reach shell children, but are not forwarded to MCP servers.
 * In normal Codex use, pass the same explicit sessionId / --session on both.
 */
export function taskSessionFromEnvironment(env) {
    for (const key of ["PORTPILOT_TASK_ID"]) {
        const value = env[key]?.trim();
        if (value)
            return taskSessionId(value);
    }
    return undefined;
}
/** Explicit sessions keep their identity. An omitted/default session belongs
 * to this task, rather than any older task in the same project. */
export function resolveTaskSession(_owner, requested, taskSession) {
    const explicit = sessionSlug(requested);
    if (explicit !== DEFAULT_SESSION_ID)
        return explicit;
    if (taskSession)
        return taskSession;
    throw new Error("Task identity required: pass one stable, task-specific sessionId for this task and reuse it on every call. Use a different sessionId for a different task, or an exact laneId to deliberately reopen a saved profile. Do not use default or copy an unrelated task's sessionId.");
}
