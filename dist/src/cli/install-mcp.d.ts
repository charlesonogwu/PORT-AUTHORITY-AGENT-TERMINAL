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
export type McpClient = "claude" | "codex";
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
export declare function installMcpFor(client: McpClient, opts?: InstallMcpOptions): Promise<InstallMcpResult>;
