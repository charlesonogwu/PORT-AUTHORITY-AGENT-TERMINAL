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

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
export function claudeConfigPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "Claude", "claude_desktop_config.json");
}

/** Resolves ~/.codex/config.toml. */
export function codexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

function makeBackupName(configPath: string): string {
  // ISO timestamp with `:` and `.` swapped to `-` so it's a legal filename on Windows.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${configPath}.backup-${ts}`;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Install PAAT into the Claude Desktop MCP config. Merges into any existing
 * `mcpServers` block without clobbering other servers.
 */
export async function installClaudeMcp(opts: InstallMcpOptions = {}): Promise<InstallMcpResult> {
  const configPath = opts.configPath ?? claudeConfigPath();
  const command = opts.command ?? "paat";
  const args = opts.args ?? ["mcp"];

  await mkdir(dirname(configPath), { recursive: true });

  const raw = await readIfExists(configPath);
  let existing: Record<string, unknown> = {};
  if (raw !== null && raw.trim().length > 0) {
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
      if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
        throw new Error(`expected a JSON object at the root, got ${Array.isArray(existing) ? "array" : typeof existing}`);
      }
    } catch (err) {
      throw new Error(
        `could not parse existing Claude Desktop config (${configPath}): ${(err as Error).message}.\n` +
          `Fix the JSON manually, or delete the file and re-run \`paat install-mcp claude\`.`,
      );
    }
  }

  // Backup the existing file if it had content (skip if creating a fresh one).
  let backupPath: string | null = null;
  if (raw !== null) {
    backupPath = makeBackupName(configPath);
    await copyFile(configPath, backupPath);
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existingBlock = mcpServers.paat as { command?: string; args?: string[] } | undefined;
  const newBlock = { command, args };

  let action: InstallMcpResult["action"];
  if (existingBlock === undefined) {
    action = "installed";
  } else if (existingBlock.command === command && JSON.stringify(existingBlock.args ?? []) === JSON.stringify(args)) {
    action = "already-installed";
  } else {
    action = "updated";
  }

  if (action === "already-installed") {
    return { client: "claude", configPath, backupPath, action };
  }

  mcpServers.paat = newBlock;
  existing.mcpServers = mcpServers;
  await writeFile(configPath, JSON.stringify(existing, null, 2) + "\n", "utf8");

  return { client: "claude", configPath, backupPath, action };
}

/**
 * Install PAAT into the Codex Desktop MCP config (TOML). We do NOT pull in a
 * TOML parser — the block we add is a fixed shape that's safe to append
 * textually. If a `[mcp_servers.paat]` section already exists we don't
 * touch it (idempotent), and we don't try to silently rewrite a malformed
 * existing entry.
 */
export async function installCodexMcp(opts: InstallMcpOptions = {}): Promise<InstallMcpResult> {
  const configPath = opts.configPath ?? codexConfigPath();
  const command = opts.command ?? "paat";
  const args = opts.args ?? ["mcp"];

  await mkdir(dirname(configPath), { recursive: true });
  const raw = await readIfExists(configPath);

  let backupPath: string | null = null;
  if (raw !== null) {
    backupPath = makeBackupName(configPath);
    await copyFile(configPath, backupPath);
  }

  // Detect an existing [mcp_servers.paat] section anywhere in the file. We
  // require the section header to start the line (after optional whitespace)
  // so we don't false-match it inside a string value.
  const sectionRegex = /^[ \t]*\[mcp_servers\.paat\]/m;
  if (raw !== null && sectionRegex.test(raw)) {
    return { client: "codex", configPath, backupPath, action: "already-installed" };
  }

  // TOML inline-array syntax happens to be a subset of JSON, so JSON.stringify
  // on the args produces a valid TOML right-hand side.
  const argsToml = JSON.stringify(args);
  const block = `[mcp_servers.paat]\ncommand = ${JSON.stringify(command)}\nargs = ${argsToml}\n`;

  const prefix = raw ?? "";
  const needsBlankLine = prefix.length > 0 && !prefix.endsWith("\n\n");
  const sep = prefix.length === 0 ? "" : prefix.endsWith("\n") ? (needsBlankLine ? "\n" : "") : "\n\n";
  await writeFile(configPath, prefix + sep + block, "utf8");

  return { client: "codex", configPath, backupPath, action: "installed" };
}

export async function installMcpFor(client: McpClient, opts: InstallMcpOptions = {}): Promise<InstallMcpResult> {
  if (client === "claude") return installClaudeMcp(opts);
  if (client === "codex") return installCodexMcp(opts);
  throw new Error(`unknown MCP client: ${client as string}. Supported: claude, codex.`);
}
