/**
 * Resolves filesystem locations used by portpilot. All functions read the
 * environment lazily so tests can override locations via PORTPILOT_HOME.
 */
export declare function portpilotHome(): string;
export declare function registryPath(): string;
export declare function lockPath(): string;
export declare function profilesDir(): string;
/**
 * Compose a deterministic Chrome profile directory for a lane.
 * - sessionId: distinguishes parallel sessions for the same (owner, project).
 *   When sessionId is "default" or missing, it is omitted from the slug so
 *   single-session installations have stable, short paths.
 * - dedupeSuffix: a numeric suffix added when another lane in the registry
 *   already owns the deterministic path (rare; e.g. two cwds with the same
 *   project name).
 */
export declare function profileDirFor(ownerSlug: string, projectSlug: string, options?: {
    sessionId?: string;
    dedupeSuffix?: string;
    browser?: string;
} | string): string;
export declare function isWindows(): boolean;
