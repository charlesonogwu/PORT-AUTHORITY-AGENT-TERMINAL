import { createHash } from "node:crypto";
import { canonicalizeOwner, DEFAULT_SESSION_ID, sessionSlug } from "./lane.js";

/** Hash the complete host task ID; filename truncation must not merge tasks. */
export function taskSessionId(taskId: string): string {
  const id = taskId.trim();
  if (!id) throw new Error("PortPilot task ID must not be blank");
  return `task-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

/** Hosts can supply PORTPILOT_TASK_ID; Codex already supplies its thread ID. */
export function taskSessionFromEnvironment(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of ["PORTPILOT_TASK_ID", "T3CODE_THREAD_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]) {
    const value = env[key]?.trim();
    if (value) return taskSessionId(value);
  }
  return undefined;
}

/** Explicit sessions keep their identity. An omitted/default session belongs
 * to this task, rather than any older task in the same project. */
export function resolveTaskSession(owner: string, requested: string | undefined, taskSession: string | undefined): string {
  const explicit = sessionSlug(requested);
  if (explicit !== DEFAULT_SESSION_ID) return explicit;
  const legacySuffix = sessionSlug(canonicalizeOwner(owner).custom);
  if (legacySuffix !== DEFAULT_SESSION_ID) return legacySuffix;
  if (taskSession) return taskSession;
  throw new Error("Task identity required: pass one stable, task-specific sessionId for this task and reuse it on every call. Use a different sessionId for a different task, or an exact laneId to deliberately reopen a saved profile. Do not use default or copy an unrelated task's sessionId.");
}
