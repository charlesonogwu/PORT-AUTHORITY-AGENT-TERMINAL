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

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type McpClient = "claude" | "claude-code" | "codex";

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

/* -------------------------------------------------------------------------- */
/*  Claude Code (the CLI, not the desktop app)                                */
/* -------------------------------------------------------------------------- */

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
 * Quote a single shell argument so concatenation into a command line is safe.
 * On Windows we double-quote anything with whitespace or shell metacharacters
 * and escape internal double quotes by doubling them (cmd.exe convention).
 * On POSIX we single-quote, escaping any internal single quotes.
 */
function quoteShellArg(arg: string): string {
  if (process.platform === "win32") {
    if (/[\s&|<>^"]/.test(arg) || arg.length === 0) {
      return '"' + arg.replace(/"/g, '""') + '"';
    }
    return arg;
  }
  // POSIX: single-quote everything and escape internal single quotes.
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Wraps a Claude Code subcommand call. Background:
 *
 *   - On Windows, npm-installed binaries are .cmd shims. Per CVE-2024-27980,
 *     Node ≥18 refuses to spawn a .cmd/.bat file WITHOUT shell:true. So we
 *     have to use shell:true on Windows.
 *   - With shell:true, Node's DEP0190 deprecation fires if you pass args
 *     separately (Node concatenates without escaping → injection risk).
 *
 * The fix that satisfies both: build the command line ourselves with
 * proper shell quoting, then call spawn with the FULL command string
 * and an empty args array. Node sees no args to "unsafely concatenate"
 * (we already did it, safely), and the shell still resolves .cmd shims.
 */
const defaultClaudeRunner: ClaudeCliRunner = (claudeBin, args) =>
  new Promise<ClaudeCliRunResult>((resolve) => {
    const cmdLine = [claudeBin, ...args].map(quoteShellArg).join(" ");
    const child = spawn(cmdLine, [], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => resolve({ ok: false, stdout, stderr: stderr + String(err), code: -1 }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr, code: code ?? -1 }));
  });

/**
 * Parse a single line of `claude mcp list` output for the paat entry.
 * The format Claude Code prints is:
 *   "paat: paat mcp - ✓ Connected"
 *   "paat: paat mcp - ! Failed to connect"
 * We only care about: does an entry exist, and what's its command string?
 */
export function parseExistingPaatLine(listStdout: string): { exists: boolean; command: string | null } {
  for (const line of listStdout.split(/\r?\n/)) {
    const m = /^paat:\s*(.+?)\s*-\s*[✓✗⚠!✓-]/u.exec(line);
    if (m && m[1]) return { exists: true, command: m[1].trim() };
    // Fallback: simpler match if we couldn't extract the command portion.
    if (/^paat:/.test(line)) return { exists: true, command: null };
  }
  return { exists: false, command: null };
}

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
export async function installClaudeCodeMcp(opts: InstallClaudeCodeOptions = {}): Promise<InstallMcpResult> {
  const claudeBin = opts.claudeBin ?? "claude";
  const scope = opts.scope ?? "user";
  const command = opts.command ?? "paat";
  const args = opts.args ?? ["mcp"];
  const run = opts.runner ?? defaultClaudeRunner;

  // 1. Sanity-check that claude is reachable. If not, give a useful error
  //    instead of a confusing "claude mcp list exited with code 127."
  const probe = await run(claudeBin, ["--version"]);
  if (!probe.ok) {
    throw new Error(
      `'${claudeBin}' is not on PATH. Install Claude Code from ` +
        `https://docs.claude.com/en/claude-code/quickstart first, then re-run ` +
        `\`paat install-mcp claude-code\`.`,
    );
  }

  // 2. Check whether paat is already registered.
  const list = await run(claudeBin, ["mcp", "list"]);
  if (!list.ok) {
    throw new Error(`\`claude mcp list\` failed (exit ${list.code}): ${list.stderr.trim() || "(no stderr)"}`);
  }
  const existing = parseExistingPaatLine(list.stdout);
  const expectedCommand = [command, ...args].join(" ");

  // The pseudo-config-path we report — Claude Code maintains the real path
  // itself. For user/local scope this is ~/.claude.json, but we don't write
  // to it directly, we delegate to the CLI.
  const reportedPath = `${homedir()}${join("/", ".claude.json")} (managed by claude CLI, scope=${scope})`;

  if (existing.exists && existing.command === expectedCommand) {
    return { client: "claude-code", configPath: reportedPath, backupPath: null, action: "already-installed" };
  }

  // 3a. If an entry exists with a different command, remove it first.
  let action: InstallMcpResult["action"] = "installed";
  if (existing.exists) {
    action = "updated";
    const removed = await run(claudeBin, ["mcp", "remove", "paat", "--scope", scope]);
    if (!removed.ok) {
      throw new Error(
        `\`claude mcp remove paat\` failed before re-adding (exit ${removed.code}): ${removed.stderr.trim() || "(no stderr)"}.\n` +
          `You may need to remove paat manually with: ${claudeBin} mcp remove paat`,
      );
    }
  }

  // 3b. Add fresh.
  const addArgs = [
    "mcp",
    "add",
    "--transport",
    "stdio",
    "paat",
    "--scope",
    scope,
    "--",
    command,
    ...args,
  ];
  const added = await run(claudeBin, addArgs);
  if (!added.ok) {
    throw new Error(`\`claude mcp add\` failed (exit ${added.code}): ${added.stderr.trim() || "(no stderr)"}`);
  }

  return { client: "claude-code", configPath: reportedPath, backupPath: null, action };
}

/* -------------------------------------------------------------------------- */
/*  Dispatcher                                                                */
/* -------------------------------------------------------------------------- */

export async function installMcpFor(client: McpClient, opts: InstallMcpOptions = {}): Promise<InstallMcpResult> {
  if (client === "claude") return installClaudeMcp(opts);
  if (client === "claude-code") return installClaudeCodeMcp({});
  if (client === "codex") return installCodexMcp(opts);
  throw new Error(`unknown MCP client: ${client as string}. Supported: claude, claude-code, codex.`);
}
