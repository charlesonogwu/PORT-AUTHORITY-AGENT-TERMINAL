/**
 * `paat install-mcp <client>` — wire PAAT into a desktop AI agent's MCP
 * config file so the agent can spawn `paat mcp` without the user having
 * to hand-edit JSON / TOML.
 *
 * Currently supports:
 *   - Claude Desktop  → %APPDATA%\Claude\claude_desktop_config.json (JSON)
 *   - Codex Desktop   → ~/.codex/config.toml                         (TOML)
 *
 * Design constraints:
 *   1. Never corrupt an existing config — always back it up first.
 *   2. Never clobber other entries — preserve other MCP servers and any
 *      unrelated settings the user has in there.
 *   3. Be idempotent — running twice in a row is a no-op the second time.
 *   4. Refuse to silently rewrite a malformed config — throw a clear
 *      error pointing the user at the file path instead.
 *   5. Don't pull in a TOML parser dependency just for Codex. The Codex
 *      block is a fixed shape we can append textually; if a paat block
 *      already exists we leave it alone and report "already-installed."
 */
export type McpClient = "claude" | "claude-code" | "codex";
/**
 * Canonical MCP server name we register everywhere. This is what users see
 * in Claude Code's /mcp view, Claude Desktop's MCP server list, and in any
 * tool prefixes the agent generates (e.g. `port-authority-agent-terminal:
 * reserve_lane`). We use kebab-case to match the npm package name and to
 * avoid shell-quoting headaches.
 */
export declare const MCP_SERVER_NAME = "port-authority-agent-terminal";
/**
 * Older names we've registered under in past versions. When the installer
 * finds an entry under one of these, it removes it as part of migrating to
 * the canonical MCP_SERVER_NAME above. This guarantees a user who upgrades
 * never ends up with duplicate entries in their MCP list.
 */
export declare const LEGACY_MCP_SERVER_NAMES: readonly ["paat"];
export interface InstallMcpOptions {
    /** Override the config file path. Used by tests. */
    configPath?: string;
    /** The command the agent should spawn for our MCP server. Defaults to "paat". */
    command?: string;
    /** Args to pass to that command. Defaults to ["mcp"]. */
    args?: string[];
}
export interface InstallMcpResult {
    client: McpClient;
    /** Absolute path to the config file that was written. */
    configPath: string;
    /** Absolute path to the .backup-<ts> copy, or null if the file didn't exist before. */
    backupPath: string | null;
    /**
     * - "installed"          → paat block was added (was absent)
     * - "updated"            → paat block existed with a different command/args, replaced
     * - "already-installed"  → paat block already present and matched exactly; no write
     */
    action: "installed" | "updated" | "already-installed";
}
/** Resolves %APPDATA%\Claude\claude_desktop_config.json. Honors APPDATA env when present. */
export declare function claudeConfigPath(): string;
/** Resolves ~/.codex/config.toml. */
export declare function codexConfigPath(): string;
/**
 * Install PAAT into the Claude Desktop MCP config. Merges into any existing
 * `mcpServers` block without clobbering other servers.
 */
export declare function installClaudeMcp(opts?: InstallMcpOptions): Promise<InstallMcpResult>;
/**
 * Install PAAT into the Codex Desktop MCP config (TOML). We do NOT pull in a
 * TOML parser — the block we add is a fixed shape that's safe to append
 * textually. If a `[mcp_servers.paat]` section already exists we don't
 * touch it (idempotent), and we don't try to silently rewrite a malformed
 * existing entry.
 */
export declare function installCodexMcp(opts?: InstallMcpOptions): Promise<InstallMcpResult>;
/**
 * Result of running a `claude mcp ...` subcommand.
 * Used by the injectable runner so tests can fake the CLI.
 */
export interface ClaudeCliRunResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number;
}
export type ClaudeCliRunner = (claudeBin: string, args: readonly string[]) => Promise<ClaudeCliRunResult>;
export interface InstallClaudeCodeOptions {
    /** Override the claude binary name. Defaults to "claude" (resolved via PATH). */
    claudeBin?: string;
    /**
     * MCP scope. user (default) makes PAAT available across every project on this
     * machine. project writes .mcp.json in the CWD (for team-shared configs).
     * local stores it in ~/.claude.json scoped to the current project only.
     */
    scope?: "user" | "project" | "local";
    /** The command claude should spawn for the MCP server. Defaults to "paat". */
    command?: string;
    /** Args to that command. Defaults to ["mcp"]. */
    args?: string[];
    /** Injectable for tests. If omitted we shell out for real via child_process.spawn. */
    runner?: ClaudeCliRunner;
}
/**
 * Parse `claude mcp list` output looking for a specific server name. Format:
 *   "<name>: <command> - ✓ Connected"
 *   "<name>: <command> - ! Failed to connect"
 * Returns whether it exists and (best-effort) the command string.
 */
export declare function parseMcpListLine(listStdout: string, name: string): {
    exists: boolean;
    command: string | null;
};
/**
 * Backwards-compatible alias retained for tests still calling the old name.
 * Equivalent to parseMcpListLine(stdout, "paat").
 */
export declare function parseExistingPaatLine(listStdout: string): {
    exists: boolean;
    command: string | null;
};
/**
 * Install (or update, or no-op) the PAAT MCP server entry in Claude Code's
 * configuration. Delegates to the `claude` CLI so we don't have to encode
 * Claude Code's config format ourselves (it can change between releases).
 *
 * Failure modes:
 *   - `claude` not on PATH                -> clear error with install link
 *   - `claude mcp list` errored           -> propagate stderr
 *   - `claude mcp add` errored            -> propagate stderr
 *
 * Idempotency:
 *   - Parses `claude mcp list` first.
 *   - If paat already present with the same command -> "already-installed", no write.
 *   - If paat already present with a different command -> remove + add ("updated").
 *   - Otherwise -> add ("installed").
 */
export declare function installClaudeCodeMcp(opts?: InstallClaudeCodeOptions): Promise<InstallMcpResult>;
export declare function installMcpFor(client: McpClient, opts?: InstallMcpOptions): Promise<InstallMcpResult>;
