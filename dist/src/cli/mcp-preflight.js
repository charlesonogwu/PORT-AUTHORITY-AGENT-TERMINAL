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
const MISSING_DEP_CODES = new Set([
    "ERR_MODULE_NOT_FOUND",
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "MODULE_NOT_FOUND",
]);
function errorCode(err) {
    if (err && typeof err === "object" && "code" in err) {
        const c = err.code;
        return typeof c === "string" ? c : undefined;
    }
    return undefined;
}
/** True iff `err` looks like Node failing to resolve a JS dependency. */
export function isMissingDependencyError(err) {
    if (!(err instanceof Error))
        return false;
    const code = errorCode(err);
    if (code && MISSING_DEP_CODES.has(code))
        return true;
    return /Cannot find (?:package|module)\b/i.test(err.message);
}
/** Pull the quoted package name out of a "Cannot find package 'x'" message. */
export function missingDependencyName(err) {
    if (!(err instanceof Error))
        return undefined;
    const m = /Cannot find (?:package|module)\s+'([^']+)'/i.exec(err.message);
    return m ? m[1] : undefined;
}
/**
 * One actionable, OS-agnostic message for a missing-dependency startup failure.
 * Written to stderr right before the server process exits non-zero, so whoever
 * is staring at a dead MCP connection learns the exact fix.
 */
export function formatMissingDependencyMessage(opts) {
    const dep = opts.missing ? ` (missing "${opts.missing}")` : "";
    return (`portpilot: the MCP server could not load its dependencies${dep}.\n` +
        `\n` +
        `This install is missing its node_modules:\n` +
        `  ${opts.packageDir}\n` +
        `\n` +
        `Fix it one of two ways:\n` +
        `  1) Restore deps in place:  cd into the dir above, then  npm install\n` +
        `  2) Reinstall globally:     npm install -g port-authority-agent-terminal-mcp\n` +
        `\n` +
        `Then restart the agent / MCP client so it reconnects.\n`);
}
