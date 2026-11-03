/** Hash the complete host task ID; filename truncation must not merge tasks. */
export declare function taskSessionId(taskId: string): string;
/** Hosts can supply PORTPILOT_TASK_ID; Codex already supplies its thread ID. */
export declare function taskSessionFromEnvironment(env: NodeJS.ProcessEnv): string | undefined;
/** Explicit sessions keep their identity. An omitted/default session belongs
 * to this task, rather than any older task in the same project. */
export declare function resolveTaskSession(owner: string, requested: string | undefined, taskSession: string | undefined): string;
