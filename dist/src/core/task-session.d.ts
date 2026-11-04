/** Hash the complete host task ID; filename truncation must not merge tasks. */
export declare function taskSessionId(taskId: string): string;
/** Only an explicitly configured identity shared by CLI and MCP is automatic.
 * Codex thread IDs reach shell children, but are not forwarded to MCP servers.
 * In normal Codex use, pass the same explicit sessionId / --session on both.
 */
export declare function taskSessionFromEnvironment(env: NodeJS.ProcessEnv): string | undefined;
/** Explicit sessions keep their identity. An omitted/default session belongs
 * to this task, rather than any older task in the same project. */
export declare function resolveTaskSession(_owner: string, requested: string | undefined, taskSession: string | undefined): string;
