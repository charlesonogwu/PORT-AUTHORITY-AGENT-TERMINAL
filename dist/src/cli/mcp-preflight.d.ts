/**
 * Detection + messaging for the "PortPilot MCP server can't load its own
 * dependencies" failure mode.
 *
 * Why this exists: the MCP server is commonly registered to run a working
 * checkout directly, e.g. `node <repo>/dist/src/cli/index.js mcp`. If that
 * checkout's `node_modules` is ever removed (an `npm run clean` cousin, a fresh
 * `git pull`, a disk tidy), the server's static `import` of
 * `@modelcontextprotocol/sdk` throws `ERR_MODULE_NOT_FOUND` at module load and
 * the process dies before printing anything useful — the calling agent just
 * sees "MCP server disconnected" with no clue why. These helpers turn that
 * cryptic crash into one actionable line that works on Windows, macOS, and
 * Linux alike.
 */
/** True iff `err` looks like Node failing to resolve a JS dependency. */
export declare function isMissingDependencyError(err: unknown): boolean;
/** Pull the quoted package name out of a "Cannot find package 'x'" message. */
export declare function missingDependencyName(err: unknown): string | undefined;
export interface MissingDependencyMessageOpts {
    /** Absolute path to the installed package root (the dir holding package.json). */
    packageDir: string;
    /** The unresolved package, when known (e.g. "@modelcontextprotocol/sdk"). */
    missing?: string;
}
/**
 * One actionable, OS-agnostic message for a missing-dependency startup failure.
 * Written to stderr right before the server process exits non-zero, so whoever
 * is staring at a dead MCP connection learns the exact fix.
 */
export declare function formatMissingDependencyMessage(opts: MissingDependencyMessageOpts): string;
